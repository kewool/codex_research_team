// @ts-nocheck
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AgentPreset, AgentSnapshot, AgentTurnResult, AppConfig, TokenUsage } from "../shared/types";
import { AgentFiles, appendAgentHistory } from "./storage";
import { ensureParent, normalizePath, nowIso, tailText } from "./utils";
import { effectiveCodexHomeDir } from "./codex-home";

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
  const customLines = Array.isArray(agent.policy?.promptGuidance)
    ? agent.policy.promptGuidance.map((line) => `- ${String(line ?? "").trim()}`).filter((line) => line !== "-")
    : [];
  if (customLines.length > 0) {
    return customLines;
  }
  return [
    "- Work according to your standing brief and the current trigger.",
    "- Use your configured channels and the visible team transcript to decide what to publish or who to target next.",
  ];
}

function workspaceGuardrailLines(workspacePath: string): string[] {
  const normalizedWorkspacePath = normalizePath(workspacePath);
  return [
    `- Your allowed working scope is the selected workspace only: ${normalizedWorkspacePath}. Treat paths outside this workspace as out-of-scope.`,
    "- Do not create, modify, delete, or publish files outside the selected workspace.",
    "- Do not introduce or normalize repo-root output trees such as exports/, release/, publish/, or other sibling directories.",
    "- If existing workspace code tries to write outside the selected workspace, do not implement or preserve that behavior. Treat it as a workflow risk to report and keep outputs workspace-relative instead.",
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
    "- Use targeted messages only when one or more specific agents need to act. Otherwise broadcast to the team channel you publish on.",
  ];
  const allowedTargets = Array.isArray(agent.policy?.allowedTargetAgentIds)
    ? agent.policy.allowedTargetAgentIds.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
  if (allowedTargets.length > 0) {
    lines.push(`- If you target another agent, you may only target these agent ids: ${allowedTargets.join(", ")}.`);
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
      ...workspaceGuardrailLines(this.workspacePath),
      ...routingGuidanceLines(this.agent, this.config.agents),
      "- Other agents and the operator will send more messages later in this same session.",
      "- This runtime uses a goal board with subgoals and stage transitions. Do your work through the goal board, not only through free-form team chat.",
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
        "If the previous attempt may have been interrupted mid-turn or mid-change, explicitly treat this turn as a resume and continue from the saved team state.",
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
    const token = `__CODEX_RESEARCH_TEAM_END__${this.agent.id}_${Date.now()}_${this.turnIndex}`;
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
      ...workspaceGuardrailLines(this.workspacePath),
      ...routingGuidanceLines(this.agent, this.config.agents),
      "- Only give public working notes. Do not expose hidden reasoning.",
      "- The goal board is the source of truth for progress. Use subgoalUpdates to create, refine, assign, or advance subgoals whenever the state of the work has changed.",
      "- Prefer updating the relevant subgoal over merely describing progress in free text.",
      "- Use subgoal decisionState explicitly: open while still exploring, disputed when contradictory evidence or unresolved reopen pressure remains, resolved only when the core contract for that subgoal is settled enough to hand off downstream.",
      "- If you reopen a subgoal because implementation/review changed the assumptions or exposed a contradiction, include reopenReason and set decisionState to disputed.",
      "- When you update an existing subgoal by id, include expectedRevision and copy the rev number shown in the Goal board or Actionable subgoals view. If the revision has changed since you read it, the runtime may ignore the stale state mutation instead of overwriting newer work.",
      "- Keep teamMessage compact: one short delta or handoff, ideally 1-4 sentences. Put durable state into subgoalUpdates.summary instead of repeating long evidence dumps in teamMessage.",
      "- Do not paste long command transcripts, multi-paragraph audits, or large code excerpts into teamMessage. Summarize the conclusion, the changed evidence, and the next action.",
      "- Reply only when you add materially new evidence, a concrete contradiction, or a decision-changing action.",
      "- Do not reply just to agree, restate, lightly refine, or say that you support a prior point.",
      "- If the primary trigger is a targeted message from a specific agent and your response is mainly for that sender, target your reply back to that sender by default.",
      "- If the primary trigger is a targeted multi-agent handoff and your response is mainly for that same subset, keep the reply targeted to that subset instead of broadcasting.",
      "- If the recent transcript already contains your point in substance, set shouldReply=false and leave teamMessage empty.",
      "- If you have nothing new right now but may still add value after future team updates, set shouldReply=false and keep completion=\"continue\".",
      "- Prefer shouldReply=false when you only validated, agreed, or found that a concern is stale and no one needs to act differently.",
      "- If you reply, make the action owner obvious: either broadcast a team-level decision or target the exact next actor.",
      "- Use completion=\"done\" only when your current branch looks genuinely exhausted until a new goal, operator instruction, implementation change, or targeted request gives you new information.",
      "- When one specific agent should act next, use targetAgentId instead of relying only on broadcast.",
      "- When two or more specific agents should act next, use targetAgentIds for a multi-target handoff.",
      "- Use subgoal stage meanings consistently: open/researching for discovery, ready_for_build when research is sufficient for routing, building for active implementation, ready_for_review when code is ready to audit, done when accepted, blocked when a real blocker prevents progress.",
      "- Implementation and review can reopen research. If downstream evidence changes assumptions, acceptance criteria, benchmark/eval contracts, or operator workflow, update the relevant subgoal back to researching instead of keeping it trapped in a build/review loop.",
      "Return exactly this shape between the XML tags:",
      "<codex_research_team-response>",
      '{"shouldReply":true,"workingNotes":["short public note"],"teamMessage":"one concise message for the team","targetAgentId":null,"targetAgentIds":[],"subgoalUpdates":[{"id":"sg-1","expectedRevision":3,"title":"short subgoal title","summary":"what changed","stage":"researching","decisionState":"disputed","reopenReason":"what remains unresolved","assigneeAgentId":null}],"completion":"continue"}',
      "</codex_research_team-response>",
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
          CODEX_HOME: effectiveCodexHomeDir(this.config),
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

    const codexArgs: string[] = [];
    if (!this.config.defaults.dangerousBypass) {
      codexArgs.push("-a", this.config.defaults.approvalPolicy);
    }
    codexArgs.push("exec", "--json", "--skip-git-repo-check", "-C", this.workspacePath);
    if (effectiveModel) {
      codexArgs.push("-m", effectiveModel);
    }
    codexArgs.push("-c", `web_search=\"${this.config.defaults.search ? "live" : "disabled"}\"`);
    if (this.config.defaults.modelReasoningEffort) {
      codexArgs.push("-c", `model_reasoning_effort=\"${this.config.defaults.modelReasoningEffort}\"`);
    }
    if (this.config.defaults.dangerousBypass) {
      codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      codexArgs.push("-s", this.config.defaults.sandbox);
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

function normalizeParsedTurnResult(parsed: Partial<AgentTurnResult> & { teamMessage?: string }, rawText: string): AgentTurnResult {
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
  const subgoalUpdates = Array.isArray(parsed.subgoalUpdates)
    ? parsed.subgoalUpdates
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          id: String((item as Record<string, unknown>).id ?? "").trim() || null,
          expectedRevision: Number.isFinite(Number((item as Record<string, unknown>).expectedRevision))
            ? Math.max(1, Number((item as Record<string, unknown>).expectedRevision))
            : null,
          title: String((item as Record<string, unknown>).title ?? "").trim() || null,
          summary: String((item as Record<string, unknown>).summary ?? "").trim() || null,
          stage: String((item as Record<string, unknown>).stage ?? "").trim() || null,
          decisionState: String((item as Record<string, unknown>).decisionState ?? "").trim() || null,
          reopenReason: String((item as Record<string, unknown>).reopenReason ?? "").trim() || null,
          assigneeAgentId: String((item as Record<string, unknown>).assigneeAgentId ?? "").trim() || null,
        }))
    : [];
  return {
    shouldReply: Boolean(parsed.shouldReply) && Boolean(parsed.teamMessage),
    workingNotes: notes.length > 0 ? notes : ["No public working notes were provided."],
    teamMessage: String(parsed.teamMessage ?? "").trim(),
    targetAgentId: targetAgentIds.length === 1 ? targetAgentIds[0] : null,
    targetAgentIds,
    subgoalUpdates,
    completion,
    rawText,
  };
}

function repairMalformedResponseJson(payloadText: string): string {
  return payloadText
    .replace(/,\\"([A-Za-z0-9_]+)\\":/g, ',"$1":')
    .replace(/\{\\"([A-Za-z0-9_]+)\\":/g, '{"$1":')
    .replace(/:\\"([^"\\]*(?:\\.[^"\\]*)*)\\"(?=\s*[,}\]])/g, ':"$1"')
    .replace(/\[\\"/g, '["')
    .replace(/\\",\\"/g, '","')
    .replace(/\\"\]/g, '"]')
    .replace(/,\s*([}\]])/g, "$1");
}

export function parseAgentTurnResult(rawText: string): AgentTurnResult {
  const match = [...rawText.matchAll(/<codex_research_team-response>([\s\S]*?)<\/codex_research_team-response>/g)].at(-1);
  const payloadText = match?.[1]?.trim() ?? "";
  if (!payloadText) {
    return {
      shouldReply: false,
      workingNotes: ["Structured response was missing."],
      teamMessage: "",
      targetAgentId: null,
      targetAgentIds: [],
      subgoalUpdates: [],
      completion: "continue",
      rawText,
    };
  }

  try {
    const parsed = JSON.parse(payloadText) as Partial<AgentTurnResult> & { teamMessage?: string };
    return normalizeParsedTurnResult(parsed, rawText);
  } catch (error) {
    try {
      const repairedPayload = repairMalformedResponseJson(payloadText);
      const parsed = JSON.parse(repairedPayload) as Partial<AgentTurnResult> & { teamMessage?: string };
      const normalized = normalizeParsedTurnResult(parsed, rawText);
      normalized.workingNotes = [
        ...normalized.workingNotes,
        "Recovered from a malformed structured response.",
      ];
      return normalized;
    } catch {
      // fall through to non-fatal parse failure
    }
    return {
      shouldReply: false,
      workingNotes: [`Response JSON parse failed: ${(error as Error).message}`],
      teamMessage: "",
      targetAgentId: null,
      targetAgentIds: [],
      subgoalUpdates: [],
      completion: "continue",
      rawText,
    };
  }
}
