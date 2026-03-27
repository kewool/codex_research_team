// @ts-nocheck
import { appendFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
    "- The runtime may permit real filesystem writes so you can modify the selected workspace directly. Treat that as execution capability for this workspace only, not permission to inspect or modify unrelated files.",
    "- Do not create, modify, delete, or publish files outside the selected workspace.",
    "- Do not introduce or normalize repo-root output trees such as exports/, release/, publish/, or other sibling directories.",
    "- If existing workspace code tries to write outside the selected workspace, do not implement or preserve that behavior. Treat it as a workflow risk to report and keep outputs workspace-relative instead.",
    "- Do not use synthetic write probes as proof that the workspace is blocked. If you already have an actionable workspace-local task, prefer the normal edit/apply path first.",
    "- Do not open, print, or dump raw binary/media files directly. Treat audio, wav, mp3, image, and other large binaries as opaque assets unless a specific tool is required.",
    "- Prefer metadata, filenames, directory listings, and targeted text/code reads over broad workspace scans.",
    "- Treat large structured data files and logs as expensive context. Do not fully load or print them by default; prefer schema/header checks, row counts, targeted filters, sampled slices, or narrow aggregations first.",
    "- Do not materialize full stream/chat datasets into memory by default with helpers like load_chat_log, pandas.read_csv, or csv.DictReader over the entire file. Only do that after smaller probes prove it is necessary for the current subgoal.",
    "- Do not run full-dataset pipeline paths like ChatHighlightDetector, HighlightRescorer, or ShortsGenerator against project-scale assets by default. Prefer smaller fixtures, bounded slices, or existing regressions first.",
    "- Reuse already-established aggregates from the transcript or goal board instead of recomputing the same full-file statistics on later turns.",
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

function hasStructuredResponseEnvelope(rawText: string): boolean {
  return /<codex_research_team-response>[\s\S]*?<\/codex_research_team-response>/i.test(String(rawText ?? ""));
}

function looksLikeWriteProbeCommand(command: string): boolean {
  const normalized = String(command ?? "").toLowerCase();
  return /(new-item|set-content|add-content|out-file|copy-item|move-item|remove-item|mkdir|md |ni |touch|>>|>\s*[^|]|apply_patch|write)/.test(normalized);
}

function looksLikeBroadDataLoadCommand(command: string): boolean {
  const normalized = String(command ?? "").toLowerCase();
  return /(load_chat_log\s*\(|pandas\.read_csv|pd\.read_csv|csv\.dictreader|import-csv\b|chathighlightdetector\s*\(|find_highlights\s*\(|highlightrescorer\s*\(|shortsgenerator\s*\(|generator\.generate\s*\()/i.test(normalized);
}

export class CodexAgentProcess {
  private readonly config: AppConfig;
  private readonly agent: AgentPreset;
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
      "- The goal board is the source of truth for progress. Use subgoalUpdates when the board state or durable subgoal memory has actually changed.",
      "- The top-level session goal is not itself a subgoal. Create a subgoal only when you can name a concrete research topic, deliverable, or handoff slice.",
      "- Prefer topic titles for subgoals. Do not use generic names like 'Subgoal sg-2'.",
      "- Give each subgoal a stable topicKey in kebab-case, such as timing-contract, data-quality, or ranking-policy. Reuse the same topicKey when new evidence belongs to the same topic.",
      "- If new evidence belongs to a materially different research axis, acceptance contract, deliverable, or downstream owner, create a new subgoal instead of overloading an existing one.",
      "- If an active card with the same topicKey already exists, update that card by id instead of creating a fresh no-id card.",
      "- subgoalUpdates are optional. If you are only sharing an opinion, objection, or extra evidence, teamMessage alone is fine.",
      "- Use subgoalUpdates when you create a card, change stage/assignee/decisionState/acceptance/nextAction, or add durable facts that should stay on the board.",
      "- Keep subgoalUpdates.summary short, and store durable details in addFacts/addOpenQuestions/addResolvedDecisions/addAcceptanceCriteria/addRelevantFiles/nextAction.",
      "- If you are not the current assignee or a coordination owner for an existing subgoal, prefer append-only updates instead of changing stage, decisionState, or assignee.",
      "- Only coordination owners should canonicalize duplicates by setting mergedIntoSubgoalId on the source subgoal. Do not rewrite or delete history in free text.",
      "- Use decisionState deliberately: open while exploring, disputed when contradictions remain, resolved only when the core contract is settled enough for downstream routing.",
      "- If you reopen a subgoal because implementation or review changed the assumptions, include reopenReason and set decisionState to disputed.",
      "- For cards already in ready_for_build, building, ready_for_review, or done, do not send a no-id subgoalUpdate just to reconfirm the same conclusion. Use teamMessage for commentary, or update the existing card by id only if you are explicitly reopening it.",
      "- When you update an existing subgoal by id, include expectedRevision from the current Goal board or Actionable subgoals view.",
      "- Keep teamMessage to one short delta or handoff. Do not paste long transcripts, audits, or code excerpts.",
      "- Reply only when you add materially new evidence, a contradiction, or a decision-changing action. Otherwise prefer shouldReply=false and keep completion=\"continue\".",
      "- Use targetAgentId or targetAgentIds only when a specific next actor or subset needs to act; otherwise broadcast.",
      "- Use completion=\"done\" only when your branch is genuinely exhausted until a new goal, operator instruction, implementation change, or targeted request arrives.",
      "- Use subgoal stages consistently: open/researching for discovery, ready_for_build for routing-ready research, building for active implementation, ready_for_review for audit, done for accepted work, blocked for real blockers.",
      "- Implementation and review can reopen research. If downstream evidence changes assumptions, acceptance, eval contracts, or operator workflow, move the affected subgoal back to researching instead of trapping it in a build/review loop.",
      "Return exactly this shape between the XML tags:",
      "<codex_research_team-response>",
      '{"shouldReply":true,"workingNotes":["short public note"],"teamMessage":"one concise message for the team","targetAgentId":null,"targetAgentIds":[],"subgoalUpdates":[{"title":"timing contract","topicKey":"timing-contract","summary":"Define the canonical timing contract before implementation.","addFacts":["Current timing source differs between export paths."],"addOpenQuestions":["Which timestamp source is canonical?"],"addRelevantFiles":["src/timing.ts"],"nextAction":"researchers should settle the canonical timing source","stage":"researching","decisionState":"open","assigneeAgentId":null,"mergedIntoSubgoalId":null}],"completion":"continue"}',
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
      try {
        currentProcess.kill();
      } catch {
        // ignore
      }
      if (process.platform === "win32" && currentProcess.pid) {
        try {
          execFileSync("taskkill", ["/PID", String(currentProcess.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {
          // ignore
        }
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
      const runState = {
        sawFileChange: false,
        sawPolicyWriteBlock: false,
        sawBroadDataLoad: false,
      };
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
          this.handleStdoutLine(line, agentMessages, runState);
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
          this.handleStdoutLine(stdoutBuffer.trim(), agentMessages, runState);
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
    runState: { sawFileChange: boolean; sawPolicyWriteBlock: boolean; sawBroadDataLoad: boolean },
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
}

function normalizeParsedTurnResult(parsed: Partial<AgentTurnResult> & { teamMessage?: string }, rawText: string): AgentTurnResult {
  const normalizeStringArray = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
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
          id: String(
            (item as Record<string, unknown>).id
            ?? (item as Record<string, unknown>).subgoalId
            ?? "",
          ).trim() || null,
          expectedRevision: Number.isFinite(Number((item as Record<string, unknown>).expectedRevision))
            ? Math.max(1, Number((item as Record<string, unknown>).expectedRevision))
            : null,
          title: String((item as Record<string, unknown>).title ?? "").trim() || null,
          topicKey: String((item as Record<string, unknown>).topicKey ?? "").trim() || null,
          summary: String((item as Record<string, unknown>).summary ?? "").trim() || null,
          addFacts: normalizeStringArray((item as Record<string, unknown>).addFacts),
          addOpenQuestions: normalizeStringArray((item as Record<string, unknown>).addOpenQuestions),
          addResolvedDecisions: normalizeStringArray((item as Record<string, unknown>).addResolvedDecisions),
          addAcceptanceCriteria: normalizeStringArray((item as Record<string, unknown>).addAcceptanceCriteria),
          addRelevantFiles: normalizeStringArray((item as Record<string, unknown>).addRelevantFiles),
          ...(Object.prototype.hasOwnProperty.call(item as Record<string, unknown>, "nextAction")
            ? { nextAction: String((item as Record<string, unknown>).nextAction ?? "").trim() || null }
            : {}),
          stage: String((item as Record<string, unknown>).stage ?? "").trim() || null,
          decisionState: String((item as Record<string, unknown>).decisionState ?? "").trim() || null,
          reopenReason: String((item as Record<string, unknown>).reopenReason ?? "").trim() || null,
          assigneeAgentId: String((item as Record<string, unknown>).assigneeAgentId ?? "").trim() || null,
          mergedIntoSubgoalId: Object.prototype.hasOwnProperty.call(item as Record<string, unknown>, "mergedIntoSubgoalId")
            ? (String((item as Record<string, unknown>).mergedIntoSubgoalId ?? "").trim() || null)
            : undefined,
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
