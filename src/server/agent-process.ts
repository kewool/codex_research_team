// @ts-nocheck
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AgentPreset, AgentSnapshot, AgentTurnResult, AppConfig, TokenUsage } from "../shared/types";
import { AgentFiles, appendAgentHistory } from "./storage";
import { ensureParent, normalizePath, nowIso, tailText } from "./utils";

export interface AgentProcessHooks {
  onState(state: Partial<Record<string, unknown>>): void;
  onStdout(text: string): void;
  onStderr(text: string): void;
}

interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
}

interface CompletedRun {
  responseText: string;
  sawToken: boolean;
  stderrText: string;
}

function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
}

function normalizeTokenUsage(usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }): TokenUsage {
  return {
    inputTokens: Number(usage?.input_tokens || 0),
    cachedInputTokens: Number(usage?.cached_input_tokens || 0),
    outputTokens: Number(usage?.output_tokens || 0),
  };
}

function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: Number(left?.inputTokens || 0) + Number(right?.inputTokens || 0),
    cachedInputTokens: Number(left?.cachedInputTokens || 0) + Number(right?.cachedInputTokens || 0),
    outputTokens: Number(left?.outputTokens || 0) + Number(right?.outputTokens || 0),
  };
}

function operatingModeLines(agent: AgentPreset): string[] {
  if (agent.role === "implementation") {
    return [
      "- Work in implementation mode by default. Turn research into concrete file changes when the workspace is ready.",
      "- Use the workspace, inspect files, and propose or make concrete implementation steps instead of staying at abstract discussion.",
    ];
  }
  if (agent.role === "review") {
    return [
      "- Work in review mode by default. Audit plans and implementation outputs for bugs, regressions, and missing tests.",
      "- Be concrete and critical. Prefer actionable review findings over broad brainstorming.",
    ];
  }
  return [
    "- Work in research mode by default unless the operator explicitly asks for implementation.",
    "- Prioritize findings, tradeoffs, and decision support for the team.",
  ];
}

function workspaceGuardrailLines(): string[] {
  return [
    "- Do not open, print, or dump raw binary/media files directly. Treat audio, wav, mp3, image, and other large binaries as opaque assets unless a specific tool is required.",
    "- Prefer metadata, filenames, directory listings, and targeted text/code reads over broad workspace scans.",
    "- Avoid generated artifacts and scratch directories such as tmp_*, output folders, caches, or derived stems unless they are the explicit subject of the turn.",
    "- Do not repeatedly reread unchanged large files just to restate prior findings. Reuse the transcript and current trigger as the primary context.",
  ];
}

function routingGuidanceLines(agent: AgentPreset, allAgents: AgentPreset[]): string[] {
  const agentIds = allAgents.map((entry) => entry.id).join(", ");
  const lines = [
    `- Available agent ids for targeted team messages: ${agentIds}.`,
    "- You may optionally set targetAgentId for one recipient or targetAgentIds for multiple recipients. Use null or [] to broadcast normally.",
  ];
  if (agent.role === "review") {
    lines.push("- Review findings should usually target the implementer who needs to act on them, rather than broadcasting to all researchers.");
  } else if (agent.role === "implementation") {
    lines.push("- Implementation updates that mainly need validation should usually target the reviewer.");
  } else {
    lines.push("- Research findings should usually stay broadcast.");
    lines.push("- On your first turn for a new goal, keep research findings broadcast by default. Do not target the implementer immediately unless the operator explicitly asks for implementation handoff.");
    lines.push("- If your finding requires code changes, rework, or a concrete implementation action, target the implementer directly instead of only broadcasting it.");
    lines.push("- If your finding is mainly a validation request on shipped code, target the reviewer or implementer directly.");
  }
  return lines;
}

export class CodexAgentProcess {
  private readonly config: AppConfig;
  private readonly agent: AgentPreset;
  private readonly workspacePath: string;
  private readonly language: string;
  private readonly hooks: AgentProcessHooks;
  private readonly files: AgentFiles;
  private readonly promptFilePath: string;
  private readonly promptFileRef: string;
  private process: ChildProcessWithoutNullStreams | null = null;
  private commandLine = "";
  private stdoutTail = "";
  private stderrTail = "";
  private turnIndex = 0;
  private ready = false;
  private stopping = false;
  private threadId: string | null = null;
  private historySerial = 0;
  private totalUsage: TokenUsage = emptyTokenUsage();
  private resumeNotice = "";

  constructor(options: {
    config: AppConfig;
    agent: AgentPreset;
    workspacePath: string;
    language: string;
    files: AgentFiles;
    hooks: AgentProcessHooks;
  }) {
    this.config = options.config;
    this.agent = options.agent;
    this.workspacePath = options.workspacePath;
    this.language = options.language;
    this.files = options.files;
    this.hooks = options.hooks;
    this.promptFilePath = this.files.promptFile;
    this.promptFileRef = normalizePath(this.promptFilePath);
  }

  async start(initialGoal: string): Promise<void> {
    if (this.ready || this.process) {
      return;
    }
    const bootstrapPrompt = [
      `You are ${this.agent.name}, one agent in a long-running multi-agent Codex collaboration runtime.`,
      `Standing brief: ${this.agent.brief}`,
      `Current top-level goal: ${initialGoal}`,
      "Operating rules:",
      `- Reply in ${this.language}.`,
      ...operatingModeLines(this.agent),
      ...workspaceGuardrailLines(),
      ...routingGuidanceLines(this.agent, this.config.agents),
      "- Other agents and the operator will send more messages later in this same session.",
      "- Your outputs are public. Do not reveal private chain-of-thought.",
      "- Runtime note: each turn is executed statelessly from the local transcript, so do not rely on hidden memory from prior Codex turns.",
      "- When you receive a TURN prompt, follow its JSON protocol exactly.",
    ].join("\n\n");

    this.hooks.onState({
      status: "starting",
      waitingForInput: false,
      lastError: "",
      lastPrompt: bootstrapPrompt,
    });
    this.recordHistory("prompts", bootstrapPrompt, "Bootstrap");
    this.appendProtocolBlock("BOOTSTRAP", bootstrapPrompt);
    this.ready = true;
    this.hooks.onState({ status: "idle", waitingForInput: false, lastError: "" });
  }

  restoreFromSnapshot(snapshot: AgentSnapshot, options?: { interrupted?: boolean }): void {
    this.turnIndex = Math.max(0, Number(snapshot?.turnCount || 0));
    this.totalUsage = snapshot?.totalUsage ?? emptyTokenUsage();
    this.stdoutTail = String(snapshot?.stdoutTail || "");
    this.stderrTail = String(snapshot?.stderrTail || "");
    this.historySerial = Math.max(this.historySerial, this.turnIndex * 10);
    if (options?.interrupted) {
      this.resumeNotice = [
        `Resume note for ${this.agent.name}: the previous session ended while your work was still in progress.`,
        `Continue from completed turn ${this.turnIndex}. Do not restart from scratch unless the current transcript requires it.`,
        "If the previous attempt may have been interrupted mid-analysis or mid-implementation, explicitly treat this turn as a resume and continue from the saved team state.",
      ].join("\n");
    } else {
      this.resumeNotice = [
        `Resume note for ${this.agent.name}: this session was reopened after a stop.`,
        `Continue from completed turn ${this.turnIndex} and the saved team state instead of restarting the discussion.`,
      ].join("\n");
    }
  }

  async runTurn(objective: string, transcript: string, triggerSummary: string): Promise<AgentTurnResult> {
    if (this.process) {
      throw new Error("Agent is already running a Codex turn.");
    }
    this.turnIndex += 1;
    const token = `__CODEX_GROUP_END__${this.agent.id}_${Date.now()}_${this.turnIndex}`;
    const turnPrompt = [
      `You are ${this.agent.name}, one agent in a long-running multi-agent Codex collaboration runtime.`,
      `Standing brief: ${this.agent.brief}`,
      `Current top-level goal: ${objective}`,
      `TURN ${this.turnIndex} for ${this.agent.name}`,
      this.resumeNotice ? "Resume context:" : "",
      this.resumeNotice,
      "Recent team transcript:",
      transcript,
      "Primary trigger for this turn:",
      triggerSummary,
      "Protocol reminder:",
      `- Reply in ${this.language}.`,
      ...operatingModeLines(this.agent),
      ...workspaceGuardrailLines(),
      ...routingGuidanceLines(this.agent, this.config.agents),
      "- Only give public working notes. Do not expose hidden reasoning.",
      "- Reply only when you add materially new evidence, a concrete contradiction, or a decision-changing action.",
      "- Do not reply just to agree, restate, lightly refine, or say that you support a prior point.",
      "- If the recent transcript already contains your point in substance, set shouldReply=false and leave teamMessage empty.",
      "- If your current research or review thread feels saturated for now, prefer shouldReply=false and completion=\"done\".",
      "Return exactly this shape between the XML tags:",
      "<codex-group-response>",
      '{"shouldReply":true,"workingNotes":["short public note"],"teamMessage":"one concise message for the team","targetAgentId":null,"targetAgentIds":[],"completion":"continue"}',
      "</codex-group-response>",
      `Finish with this token on its own line: ${token}`,
    ].join("\n\n");

    this.hooks.onState({
      status: "running",
      waitingForInput: false,
      lastError: "",
      lastPrompt: turnPrompt,
    });
    this.recordHistory("prompts", turnPrompt, `Turn ${this.turnIndex}`);
    this.appendProtocolBlock("OUTBOUND TURN", turnPrompt);

    const result = await this.executePrompt(turnPrompt, token);
    this.resumeNotice = "";
    if (!result.sawToken) {
      throw new Error("Turn completion token was missing from the Codex response.");
    }

    const parsed = parseAgentTurnResult(result.responseText);
    if (parsed.completion === "blocked" && result.stderrText.trim()) {
      parsed.workingNotes = [...parsed.workingNotes, `stderr: ${result.stderrText.trim()}`];
    }
    return parsed;
  }

  async sendHumanInput(_text: string): Promise<void> {
    throw new Error("Direct terminal input is not available in exec mode. Send an operator instruction instead.");
  }

  snapshotLogs(): { stdoutTail: string; stderrTail: string } {
    return { stdoutTail: this.stdoutTail, stderrTail: this.stderrTail };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // ignore
      }
    }
    this.process = null;
    this.ready = false;
  }

  private async executePrompt(promptText: string, token: string): Promise<CompletedRun> {
    this.writePromptFile(promptText);
    const spec = this.buildCommandSpec();
    this.commandLine = [spec.file, ...spec.args].join(" ");

    return await new Promise<CompletedRun>((resolve, reject) => {
      const child = spawn(spec.file, spec.args, {
        cwd: this.workspacePath,
        env: {
          ...process.env,
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
        shell: spec.shell,
      });

      this.process = child;
      let stdoutBuffer = "";
      let stderrBuffer = "";
      const agentMessages: string[] = [];
      let settled = false;

      const rejectWith = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.process = null;
        reject(error);
      };

      const resolveWith = (value: CompletedRun): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.process = null;
        resolve(value);
      };

      child.on("error", (error) => {
        this.appendStderrChunk(String(error?.message ?? error));
        rejectWith(error as Error);
      });

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdoutBuffer += chunk.toString("utf8");
        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          this.handleStdoutLine(line, agentMessages);
          newlineIndex = stdoutBuffer.indexOf("\n");
        }
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString("utf8");
        stderrBuffer += text;
        this.appendStderrChunk(text);
      });

      child.on("exit", (code, signal) => {
        if (stdoutBuffer.trim()) {
          this.handleStdoutLine(stdoutBuffer.trim(), agentMessages);
          stdoutBuffer = "";
        }
        if (this.stopping) {
          rejectWith(new Error("Codex run stopped."));
          return;
        }
        if (code !== 0) {
          const detail = tailText(stderrBuffer.trim(), 2000).trim();
          const base = `Codex exited code=${code ?? "null"} signal=${signal ?? "null"}`;
          rejectWith(new Error(detail ? `${base}\n${detail}` : base));
          return;
        }

        const combined = agentMessages.join("\n\n").trim();
        const sawToken = combined.includes(token);
        const responseText = sawToken ? combined.slice(0, combined.indexOf(token)).trim() : combined;
        resolveWith({
          responseText,
          sawToken,
          stderrText: stderrBuffer.trim(),
        });
      });
    });
  }

  private handleStdoutLine(line: string, agentMessages: string[]): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let event: CodexJsonEvent | null = null;
    try {
      event = JSON.parse(trimmed) as CodexJsonEvent;
    } catch {
      this.appendStdoutBlock(trimmed);
      return;
    }

    switch (event.type) {
      case "thread.started": {
        const threadId = String(event.thread_id ?? "").trim();
        if (threadId) {
          this.threadId = threadId;
          this.appendStdoutBlock(`[thread.started] ${threadId}`);
        }
        break;
      }
      case "turn.started":
        this.appendStdoutBlock("[turn.started]");
        break;
      case "item.completed":
        this.handleCompletedItem(event.item ?? {}, agentMessages);
        break;
      case "turn.completed": {
        const usage = normalizeTokenUsage(event.usage ?? {});
        this.totalUsage = addTokenUsage(this.totalUsage, usage);
        this.hooks.onState({
          lastUsage: usage,
          totalUsage: this.totalUsage,
        });
        const parts = [
          `[turn.completed] input=${usage.inputTokens}`,
          `cached=${usage.cachedInputTokens}`,
          `output=${usage.outputTokens}`,
        ];
        this.appendStdoutBlock(parts.join(" "));
        break;
      }
      default:
        this.appendStdoutBlock(trimmed);
        break;
    }
  }

  private handleCompletedItem(item: { type?: string; text?: string; command?: string; aggregated_output?: string; exit_code?: number | null; status?: string }, agentMessages: string[]): void {
    const type = String(item.type ?? "").trim() || "item";
    const text = String(item.text ?? "").trim();
    if (type === "agent_message") {
      if (text) {
        agentMessages.push(text);
        this.appendStdoutBlock(`[agent_message]\n${text}`);
      } else {
        this.appendStdoutBlock("[agent_message]");
      }
      return;
    }

    if (type === "command_execution") {
      const command = String(item.command ?? "").trim();
      const status = String(item.status ?? "").trim();
      const exitCode = item.exit_code;
      const summary = ["[command_execution]", command, status ? `status=${status}` : "", exitCode == null ? "" : `exit=${exitCode}`]
        .filter(Boolean)
        .join(" ");
      this.appendStdoutBlock(summary);
      const output = String(item.aggregated_output ?? "").trim();
      if (output) {
        this.appendStdoutBlock(output);
      }
      return;
    }

    if (text) {
      this.appendStdoutBlock(`[item.completed] ${type}\n${text}`);
      return;
    }

    this.appendStdoutBlock(`[item.completed] ${type}`);
  }

  private buildCommandSpec(): { file: string; args: string[]; windowsVerbatimArguments: boolean; shell: boolean } {
    const effectiveModel = this.agent.model ?? this.config.defaults.model;
    const wrapperPrompt = [
      `Read the UTF-8 file at the absolute path '${this.promptFileRef}' and treat its contents as the real prompt for this turn.`,
      "Follow that file exactly.",
      "Respond directly to that file's contents.",
      "Do not mention the wrapper prompt, the file path, or the act of reading the file.",
      "If you use a shell command to read it on Windows, prefer a UTF-8 safe no-profile read.",
    ].join(" ");

    const codexArgs: string[] = ["exec", "--json", "--skip-git-repo-check", "-C", this.workspacePath];
    if (effectiveModel) {
      codexArgs.push("-m", effectiveModel);
    }
    codexArgs.push("-c", `web_search=\"${this.config.defaults.search ? "live" : "off"}\"`);
    if (this.config.defaults.dangerousBypass) {
      codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
    } else if (this.config.defaults.sandbox === "workspace-write" && this.config.defaults.approvalPolicy === "on-request") {
      codexArgs.push("--full-auto");
    }
    codexArgs.push(wrapperPrompt);

    if (process.platform !== "win32") {
      return {
        file: this.config.defaults.codexCommand,
        args: codexArgs,
        windowsVerbatimArguments: false,
        shell: false,
      };
    }

    const commandText = `"${this.config.defaults.codexCommand}" ${codexArgs.map((item) => this.quoteCmdArgument(item)).join(" ")}`;
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${commandText}"`],
      windowsVerbatimArguments: true,
      shell: false,
    };
  }

  private writePromptFile(promptText: string): void {
    ensureParent(this.promptFilePath);
    writeFileSync(this.promptFilePath, promptText, "utf8");
  }

  private appendProtocolBlock(label: string, text: string): void {
    this.appendToFile(this.files.protocolLog, `[${nowIso()}] ${label}\n${text}\n`);
  }

  private appendStdoutBlock(text: string): void {
    const normalized = text.endsWith("\n") ? text : `${text}\n`;
    this.stdoutTail = tailText(this.stdoutTail + normalized, 12000);
    this.appendToFile(this.files.stdoutLog, normalized);
    this.recordHistory("stdout", normalized);
    this.hooks.onStdout(normalized);
  }

  private appendStderrChunk(text: string): void {
    if (!text) {
      return;
    }
    this.stderrTail = tailText(this.stderrTail + text, 12000);
    this.appendToFile(this.files.stderrLog, text);
    this.recordHistory("stderr", text);
    this.hooks.onStderr(text);
  }

  private recordHistory(kind: "prompts" | "stdout" | "stderr", text: string, label?: string | null): void {
    if (!String(text ?? "").trim()) {
      return;
    }
    appendAgentHistory(this.files, {
      id: `${this.agent.id}-${kind}-${++this.historySerial}`,
      timestamp: nowIso(),
      kind,
      text: String(text),
      label: label ?? null,
      metadata: {
        agentId: this.agent.id,
        turnIndex: this.turnIndex,
      },
    });
  }

  private appendToFile(filePath: string, text: string): void {
    ensureParent(filePath);
    appendFileSync(filePath, text, "utf8");
  }

  private quoteCmdArgument(value: string): string {
    return `"${String(value ?? "").replace(/"/g, '\\"')}"`;
  }
}

export function parseAgentTurnResult(rawText: string): AgentTurnResult {
  const match = [...rawText.matchAll(/<codex-group-response>([\s\S]*?)<\/codex-group-response>/g)].at(-1);
  const payloadText = match?.[1]?.trim() ?? "";
  if (!payloadText) {
    return {
      shouldReply: false,
      workingNotes: ["Structured response was missing."],
      teamMessage: "",
      completion: "blocked",
      rawText,
    };
  }

  try {
    const parsed = JSON.parse(payloadText) as Partial<AgentTurnResult> & { teamMessage?: string };
    const notes = Array.isArray(parsed.workingNotes)
      ? parsed.workingNotes.map((item) => String(item).trim()).filter(Boolean)
      : [];
    const completion = parsed.completion === "done" || parsed.completion === "blocked" ? parsed.completion : "continue";
    const parsedTargetAgentIds = Array.isArray(parsed.targetAgentIds)
      ? parsed.targetAgentIds.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
    const singleTargetAgentId = String(parsed.targetAgentId ?? "").trim() || null;
    const targetAgentIds = parsedTargetAgentIds.length > 0
      ? [...new Set(parsedTargetAgentIds)]
      : singleTargetAgentId
        ? [singleTargetAgentId]
        : [];
    return {
      shouldReply: Boolean(parsed.shouldReply) && Boolean(parsed.teamMessage),
      workingNotes: notes.length > 0 ? notes : ["No public working notes were provided."],
      teamMessage: String(parsed.teamMessage ?? "").trim(),
      targetAgentId: targetAgentIds.length === 1 ? targetAgentIds[0] : null,
      targetAgentIds,
      completion,
      rawText,
    };
  } catch (error) {
    return {
      shouldReply: false,
      workingNotes: [`Response JSON parse failed: ${(error as Error).message}`],
      teamMessage: "",
      targetAgentId: null,
      targetAgentIds: [],
      completion: "blocked",
      rawText,
    };
  }
}
