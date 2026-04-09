// @ts-nocheck
import { appendFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AgentPreset, AgentSnapshot, AgentTurnResult, AppConfig, TokenUsage } from "../../shared/types";
import { AgentFiles, appendAgentHistory } from "../persistence/storage";
import { ensureParent, nowIso, tailText } from "../lib/utils";
import { effectiveCodexHomeDir } from "./codex-home";
import { operatingModeLines, roleSpecificPromptLines, routingGuidanceLines, sharedTurnProtocolLines, workspaceGuardrailLines } from "./prompt-rules";
import {
  hasStructuredResponseEnvelope,
  looksLikeBroadDataLoadCommand,
  looksLikeWriteProbeCommand,
  parseAgentTurnResult,
} from "./turn-parser";
import { addTokenUsage, emptyTokenUsage, normalizeTokenUsage } from "./token-usage";

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
    changes?: Array<{
      path?: string;
      kind?: string;
    }>;
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
  sawFileChange: boolean;
  sawPolicyWriteBlock: boolean;
  sawBroadDataLoad: boolean;
}

interface RunState {
  sawFileChange: boolean;
  sawPolicyWriteBlock: boolean;
  sawBroadDataLoad: boolean;
  sawTurnCompleted: boolean;
}

export class CodexAgentProcess {
  private readonly config: AppConfig;
  private readonly agent: AgentPreset;
  private readonly sessionId: string;
  private readonly workspacePath: string;
  private readonly language: string;
  private readonly hooks: AgentProcessHooks;
  private readonly files: AgentFiles;
  private readonly promptFilePath: string;
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
    sessionId: string;
    workspacePath: string;
    language: string;
    files: AgentFiles;
    hooks: AgentProcessHooks;
  }) {
    this.config = options.config;
    this.agent = options.agent;
    this.sessionId = options.sessionId;
    this.workspacePath = options.workspacePath;
    this.language = options.language;
    this.files = options.files;
    this.hooks = options.hooks;
    this.promptFilePath = this.files.promptFile;
  }

  async start(initialGoal: string): Promise<void> {
    if (this.ready || this.process) {
      return;
    }
    this.stopping = false;
    const bootstrapPrompt = [
      `You are ${this.agent.name}, one agent in a long-running multi-agent Codex collaboration runtime.`,
      `Standing brief: ${this.agent.brief}`,
      `Current top-level goal: ${initialGoal}`,
      "Operating rules:",
      `- Reply in ${this.language}.`,
      ...operatingModeLines(this.agent),
      ...workspaceGuardrailLines(this.workspacePath),
      ...roleSpecificPromptLines(this.agent),
      ...routingGuidanceLines(this.agent, this.config.agents),
      ...sharedTurnProtocolLines({ hasSessionStateTools: this.hasSessionStateTools() }),
      "- Other agents and the operator will send more messages later in this same session.",
      "- This runtime uses a goal board with subgoals and stage transitions. Do your work through the goal board, not only through free-form team chat.",
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
      ...roleSpecificPromptLines(this.agent),
      ...routingGuidanceLines(this.agent, this.config.agents),
      ...sharedTurnProtocolLines({ hasSessionStateTools: this.hasSessionStateTools() }),
      "Return exactly this shape between the XML tags:",
      "<codex_research_team-response>",
      '{"shouldReply":false,"workingNotes":[],"teamMessages":[],"subgoalUpdates":[],"completion":"continue"}',
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
    const parsed = parseAgentTurnResult(result.responseText);
    parsed.runtimeDiagnostics = {
      sawFileChange: result.sawFileChange,
      sawPolicyWriteBlock: result.sawPolicyWriteBlock,
      sawBroadDataLoad: result.sawBroadDataLoad,
    };
    if (!result.sawToken) {
      if (!hasStructuredResponseEnvelope(result.responseText)) {
        throw new Error("Turn completion token was missing from the Codex response.");
      }
      parsed.workingNotes = [
        ...parsed.workingNotes,
        "Completion token was missing; accepted the structured response fallback.",
      ];
    }
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
    const currentProcess = this.process;
    if (currentProcess) {
      await this.terminateProcessTree(currentProcess, 3000);
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
          CRT_SERVER_URL: this.sessionServerUrl(),
          CRT_SESSION_ID: this.sessionId,
          CRT_AGENT_ID: this.agent.id,
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
        shell: spec.shell,
      });

      this.process = child;
      child.stdin.end(promptText, "utf8");
      let stdoutBuffer = "";
      let stderrBuffer = "";
      const agentMessages: string[] = [];
      const runState: RunState = {
        sawFileChange: false,
        sawPolicyWriteBlock: false,
        sawBroadDataLoad: false,
        sawTurnCompleted: false,
      };
      let settled = false;

      const tryResolveCompletedTurn = (): void => {
        if (settled || !runState.sawTurnCompleted) {
          return;
        }
        const combined = agentMessages.join("\n\n").trim();
        const sawToken = combined.includes(token);
        if (!sawToken && !hasStructuredResponseEnvelope(combined)) {
          return;
        }
        const responseText = sawToken ? combined.slice(0, combined.indexOf(token)).trim() : combined;
        resolveWith({
          responseText,
          sawToken,
          stderrText: stderrBuffer.trim(),
          sawFileChange: runState.sawFileChange,
          sawPolicyWriteBlock: runState.sawPolicyWriteBlock,
          sawBroadDataLoad: runState.sawBroadDataLoad,
        });
        void this.terminateProcessTree(child, 1000);
      };

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
          this.handleStdoutLine(line, agentMessages, runState);
          tryResolveCompletedTurn();
          newlineIndex = stdoutBuffer.indexOf("\n");
        }
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString("utf8");
        stderrBuffer += text;
        this.appendStderrChunk(text);
      });

      child.on("close", (code, signal) => {
        if (stdoutBuffer.trim()) {
          this.handleStdoutLine(stdoutBuffer.trim(), agentMessages, runState);
          stdoutBuffer = "";
        }
        tryResolveCompletedTurn();
        if (settled) {
          return;
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
          sawFileChange: runState.sawFileChange,
          sawPolicyWriteBlock: runState.sawPolicyWriteBlock,
          sawBroadDataLoad: runState.sawBroadDataLoad,
        });
      });
    });
  }

  private handleStdoutLine(
    line: string,
    agentMessages: string[],
    runState: RunState,
  ): void {
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
        this.handleCompletedItem(event.item ?? {}, agentMessages, runState);
        break;
      case "turn.completed": {
        const usage = normalizeTokenUsage(event.usage ?? {});
        this.totalUsage = addTokenUsage(this.totalUsage, usage);
        runState.sawTurnCompleted = true;
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

  private handleCompletedItem(
    item: {
      type?: string;
      text?: string;
      command?: string;
      aggregated_output?: string;
      exit_code?: number | null;
      status?: string;
      changes?: Array<{ path?: string; kind?: string }>;
    },
    agentMessages: string[],
    runState: { sawFileChange: boolean; sawPolicyWriteBlock: boolean; sawBroadDataLoad: boolean },
  ): void {
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
        if (output.toLowerCase().includes("rejected: blocked by policy") && looksLikeWriteProbeCommand(command)) {
          runState.sawPolicyWriteBlock = true;
        }
      }
      if (looksLikeBroadDataLoadCommand(command)) {
        runState.sawBroadDataLoad = true;
      }
      return;
    }

    if (type === "file_change") {
      runState.sawFileChange = true;
      const changed = Array.isArray(item.changes)
        ? item.changes
            .map((change) => `${String(change.kind ?? "").trim() || "change"} ${String(change.path ?? "").trim()}`)
            .filter(Boolean)
        : [];
      if (changed.length > 0) {
        this.appendStdoutBlock(`[file_change] ${changed.join(" | ")}`);
      } else {
        this.appendStdoutBlock("[file_change]");
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
    const effectiveReasoningEffort = this.agent.modelReasoningEffort ?? this.config.defaults.modelReasoningEffort;

    const codexArgs: string[] = [];
    if (!this.config.defaults.dangerousBypass) {
      codexArgs.push("-a", this.config.defaults.approvalPolicy);
    }
    codexArgs.push("exec", "--json", "--skip-git-repo-check", "-C", this.workspacePath);
    if (effectiveModel) {
      codexArgs.push("-m", effectiveModel);
    }
    codexArgs.push("-c", `web_search=\"${this.config.defaults.search ? "live" : "disabled"}\"`);
    if (effectiveReasoningEffort) {
      codexArgs.push("-c", `model_reasoning_effort=\"${effectiveReasoningEffort}\"`);
    }
    if (this.config.defaults.dangerousBypass) {
      codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      codexArgs.push("-s", this.config.defaults.sandbox);
    }
    codexArgs.push("-");

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

  private hasSessionStateTools(): boolean {
    return this.config.defaults.codexHomeMode === "project";
  }

  private sessionServerUrl(): string {
    const host = String(this.config.defaults.serverHost ?? "").trim();
    const port = Number(this.config.defaults.serverPort || 0) || 4280;
    const safeHost = !host || host === "0.0.0.0" || host === "::" || host === "[::]" ? "127.0.0.1" : host;
    return `http://${safeHost}:${port}`;
  }

  private async terminateProcessTree(currentProcess: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
    let settled = false;
    const waitForExit = new Promise<void>((resolve) => {
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      currentProcess.once("exit", finish);
      currentProcess.once("close", finish);
    });
    try {
      if (process.platform === "win32" && currentProcess.pid) {
        try {
          execFileSync("taskkill", ["/PID", String(currentProcess.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {
          try {
            currentProcess.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      } else {
        currentProcess.kill("SIGKILL");
      }
    } catch {
      // ignore
    }
    await Promise.race([
      waitForExit,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
}
