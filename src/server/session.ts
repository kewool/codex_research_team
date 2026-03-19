// @ts-nocheck
import { existsSync, readFileSync } from "node:fs";
import {
  AgentPreset,
  AgentSnapshot,
  AgentTurnResult,
  AppConfig,
  SessionChannel,
  SessionEvent,
  SessionSnapshot,
  SessionStatus,
  TokenUsage,
} from "../shared/types";
import { CodexAgentProcess } from "./agent-process";
import {
  AgentFiles,
  SessionFiles,
  appendAgentHistory,
  appendSessionEvent,
  createAgentFiles,
  createSessionFiles,
  writeAgentSnapshot,
  writeSessionSnapshot,
} from "./storage";
import { nowIso, tailText } from "./utils";

interface PendingDigest {
  totalCount: number;
  latestGoal: SessionEvent | null;
  operatorEvents: SessionEvent[];
  directInputs: SessionEvent[];
  researchEvents: SessionEvent[];
  implementationEvents: SessionEvent[];
  reviewEvents: SessionEvent[];
  otherEvents: SessionEvent[];
}

interface RuntimeAgent {
  preset: AgentPreset;
  files: AgentFiles;
  process: CodexAgentProcess;
  snapshot: AgentSnapshot;
  pendingDigest: PendingDigest;
  inFlightDigest: PendingDigest | null;
  draining: boolean;
  drainTimer: ReturnType<typeof setTimeout> | null;
}

const RECENT_EVENT_LIMIT = 40;
const SNAPSHOT_STREAM_TAIL = 2400;
const DRAIN_DEBOUNCE_MS = 350;

function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
}

function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: Number(left?.inputTokens || 0) + Number(right?.inputTokens || 0),
    cachedInputTokens: Number(left?.cachedInputTokens || 0) + Number(right?.cachedInputTokens || 0),
    outputTokens: Number(left?.outputTokens || 0) + Number(right?.outputTokens || 0),
  };
}

function compactWhitespace(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function shortenText(text: string, maxChars = 160): string {
  const normalized = compactWhitespace(text);
  if (!normalized) {
    return "-";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function extractTargetAgentIds(metadata: Record<string, unknown> | undefined): string[] {
  const multi = Array.isArray(metadata?.targetAgentIds)
    ? metadata.targetAgentIds.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  if (multi.length > 0) {
    return [...new Set(multi)];
  }
  const single = typeof metadata?.targetAgentId === "string" ? metadata.targetAgentId.trim() : "";
  return single ? [single] : [];
}

function formatTargetSuffix(metadata: Record<string, unknown> | undefined): string {
  const targetIds = extractTargetAgentIds(metadata);
  return targetIds.length > 0 ? ` target=${targetIds.join(",")}` : "";
}

function formatDigestEvent(event: SessionEvent): string {
  const targetText = formatTargetSuffix(event.metadata);
  const directText = event.metadata?.directInput ? " direct-input" : "";
  return `[${event.sender} -> ${event.channel}${targetText}${directText}]\n${String(event.content ?? "").trim() || "-"}`;
}

function emptyPendingDigest(): PendingDigest {
  return {
    totalCount: 0,
    latestGoal: null,
    operatorEvents: [],
    directInputs: [],
    researchEvents: [],
    implementationEvents: [],
    reviewEvents: [],
    otherEvents: [],
  };
}

function hasPendingDigest(digest: PendingDigest): boolean {
  return digest.totalCount > 0;
}

function mergePendingDigest(digest: PendingDigest, event: SessionEvent, config: AppConfig): PendingDigest {
  const agentRole = String(event.metadata?.agentRole ?? "").trim();
  if (event.channel === config.defaults.goalChannel) {
    return {
      ...emptyPendingDigest(),
      totalCount: 1,
      latestGoal: event,
    };
  }

  const next: PendingDigest = {
    totalCount: digest.totalCount + 1,
    latestGoal: digest.latestGoal,
    operatorEvents: [...digest.operatorEvents],
    directInputs: [...digest.directInputs],
    researchEvents: [...digest.researchEvents],
    implementationEvents: [...digest.implementationEvents],
    reviewEvents: [...digest.reviewEvents],
    otherEvents: [...digest.otherEvents],
  };

  if (event.channel === config.defaults.operatorChannel) {
    if (event.metadata?.directInput) {
      next.directInputs = [...next.directInputs, event];
    } else {
      next.operatorEvents = [...next.operatorEvents, event];
    }
    return next;
  }

  if (event.channel === config.defaults.researchChannel || agentRole === "research") {
    next.researchEvents = [...next.researchEvents, event];
    return next;
  }

  if (event.channel === config.defaults.implementationChannel || agentRole === "implementation") {
    next.implementationEvents = [...next.implementationEvents, event];
    return next;
  }

  if (event.channel === config.defaults.reviewChannel || agentRole === "review") {
    next.reviewEvents = [...next.reviewEvents, event];
    return next;
  }

  if (event.channel !== "status" && event.channel !== "system") {
    next.otherEvents = [...next.otherEvents, event];
  }

  return next;
}

function buildDigestSection(title: string, events: SessionEvent[]): string {
  if (events.length === 0) {
    return "";
  }
  return `${title}:\n${events.map((event) => formatDigestEvent(event)).join("\n\n")}`;
}

function buildTriggerSummary(digest: PendingDigest): string {
  const sections: string[] = [];
  if (digest.latestGoal) {
    sections.push(`Goal update:\n${formatDigestEvent(digest.latestGoal)}`);
  }
  const directInputsSection = buildDigestSection("Direct operator inputs", digest.directInputs);
  if (directInputsSection) {
    sections.push(directInputsSection);
  }
  const operatorSection = buildDigestSection("Operator directives", digest.operatorEvents);
  if (operatorSection) {
    sections.push(operatorSection);
  }
  const researchSection = buildDigestSection("Research digest", digest.researchEvents);
  if (researchSection) {
    sections.push(researchSection);
  }
  const implementationSection = buildDigestSection("Implementation digest", digest.implementationEvents);
  if (implementationSection) {
    sections.push(implementationSection);
  }
  const reviewSection = buildDigestSection("Review digest", digest.reviewEvents);
  if (reviewSection) {
    sections.push(reviewSection);
  }
  const otherSection = buildDigestSection("Additional channel updates", digest.otherEvents);
  if (otherSection) {
    sections.push(otherSection);
  }

  return sections.join("\n\n");
}

function digestSequences(digest: PendingDigest): Set<number> {
  const sequences = new Set<number>();
  const push = (event: SessionEvent | null | undefined): void => {
    const sequence = Number(event?.sequence || 0);
    if (sequence > 0) {
      sequences.add(sequence);
    }
  };
  push(digest.latestGoal);
  for (const event of digest.operatorEvents) {
    push(event);
  }
  for (const event of digest.directInputs) {
    push(event);
  }
  for (const event of digest.researchEvents) {
    push(event);
  }
  for (const event of digest.implementationEvents) {
    push(event);
  }
  for (const event of digest.reviewEvents) {
    push(event);
  }
  for (const event of digest.otherEvents) {
    push(event);
  }
  return sequences;
}

function maxDigestSequence(digest: PendingDigest | null): number {
  if (!digest) {
    return 0;
  }
  let maxSequence = 0;
  for (const sequence of digestSequences(digest)) {
    if (sequence > maxSequence) {
      maxSequence = sequence;
    }
  }
  return maxSequence;
}

function readSessionEvents(filePath: string): SessionEvent[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const raw = readFileSync(filePath, "utf8").replace(/^\ufeff/, "");
  if (!raw.trim()) {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as SessionEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is SessionEvent => Boolean(event && Number(event.sequence) > 0));
}

export class LiveSession {
  readonly id: string;
  private readonly config: AppConfig;
  private readonly files: SessionFiles;
  private readonly workspaceName: string;
  private readonly workspacePath: string;
  private readonly title: string;
  private readonly restoredAgents = new Map<string, AgentSnapshot>();
  private goal: string;
  private status: SessionStatus = "starting";
  private sequence = 0;
  private recentEvents: SessionEvent[] = [];
  private readonly agents = new Map<string, RuntimeAgent>();
  private readonly subscribers = new Set<(payload: unknown) => void>();
  private updatedAt = nowIso();
  private historySerial = 0;

  constructor(options: {
    config: AppConfig;
    goal: string;
    title: string;
    workspaceName: string;
    workspacePath: string;
    files?: SessionFiles;
    snapshot?: SessionSnapshot | null;
  }) {
    this.config = options.config;
    this.goal = options.goal;
    this.title = options.title;
    this.workspaceName = options.workspaceName;
    this.workspacePath = options.workspacePath;
    this.files = options.files ?? createSessionFiles(this.config, options.title || options.goal);
    this.id = this.files.root.split(/[\\/]/).at(-1) ?? this.files.root;
    if (options.snapshot) {
      for (const agent of options.snapshot.agents || []) {
        if (agent?.id) {
          this.restoredAgents.set(agent.id, agent);
        }
      }
      this.sequence = Number(options.snapshot.eventCount || 0);
      this.recentEvents = Array.isArray(options.snapshot.recentEvents) ? [...options.snapshot.recentEvents] : [];
      this.updatedAt = String(options.snapshot.updatedAt || this.updatedAt);
      this.status = options.snapshot.status === "stopped" || options.snapshot.status === "error" ? "idle" : options.snapshot.status;
      this.historySerial = Math.max(0, this.sequence * 10);
    }
  }

  private goalChannel(): SessionChannel {
    return this.config.defaults.goalChannel;
  }

  private researchChannel(): SessionChannel {
    return this.config.defaults.researchChannel;
  }

  private implementationChannel(): SessionChannel {
    return this.config.defaults.implementationChannel;
  }

  private reviewChannel(): SessionChannel {
    return this.config.defaults.reviewChannel;
  }

  private operatorChannel(): SessionChannel {
    return this.config.defaults.operatorChannel;
  }

  private isRole(agent: RuntimeAgent, role: "research" | "implementation" | "review" | "general"): boolean {
    return agent.preset.role === role;
  }

  private eventRole(event: SessionEvent): string {
    return String(event.metadata?.agentRole ?? "").trim();
  }

  private isResearchEvent(event: SessionEvent): boolean {
    return event.channel === this.researchChannel() || this.eventRole(event) === "research";
  }

  private isImplementationEvent(event: SessionEvent): boolean {
    return event.channel === this.implementationChannel() || this.eventRole(event) === "implementation";
  }

  private isReviewEvent(event: SessionEvent): boolean {
    return event.channel === this.reviewChannel() || this.eventRole(event) === "review";
  }

  async start(): Promise<void> {
    await this.activate("new");
  }

  async resume(): Promise<void> {
    await this.activate("resume");
  }

  private async activate(mode: "new" | "resume"): Promise<void> {
    this.initializeAgents();
    if (mode === "resume") {
      this.rebuildPendingDigestsFromHistory();
    }
    this.status = "starting";
    this.persistSession();
    this.emit({ type: "session", sessionId: this.id, snapshot: this.snapshot() });

    this.status = "running";
    this.persistSession();
    this.emit({ type: "session", sessionId: this.id, snapshot: this.snapshot() });
    if (mode === "new") {
      this.publish("system", "status", `Session started in ${this.workspacePath}`);
      this.publish("user", this.goalChannel(), this.goal);
    } else {
      this.publish("system", "status", `Session resumed in ${this.workspacePath}`);
      for (const runtime of this.agents.values()) {
        if (!this.wasInterruptedSnapshot(runtime.snapshot)) {
          continue;
        }
        this.publish(
          "operator",
          this.operatorChannel(),
          `Resume note: your previous work was interrupted before it finished. Continue from completed turn ${runtime.snapshot.turnCount} and treat this as a resumed turn, not a fresh restart.`,
          { targetAgentId: runtime.preset.id },
        );
      }
    }

    for (const runtime of this.agents.values()) {
      void runtime.process
        .start(this.goal)
        .then(() => {
          if (hasPendingDigest(runtime.pendingDigest) && this.status !== "stopped") {
            this.scheduleAgentDrain(runtime.preset.id, true);
          }
        })
        .catch((error) => {
          this.updateAgentSnapshot(runtime.preset.id, {
            status: "error",
            lastError: (error as Error).message,
            waitingForInput: false,
          });
        });
    }
  }

  private initializeAgents(): void {
    if (this.agents.size > 0) {
      return;
    }
    for (const preset of this.config.agents) {
      const files = createAgentFiles(this.files, preset.id);
      const restored = this.restoredAgents.get(preset.id);
      const snapshot: AgentSnapshot = restored
        ? {
            ...restored,
            id: preset.id,
            name: preset.name,
            brief: preset.brief,
            publishChannel: preset.publishChannel,
            model: preset.model ?? this.config.defaults.model ?? restored.model ?? null,
            status: "starting",
            lastConsumedSequence: Number(restored.lastConsumedSequence ?? this.sequence),
            pendingSignals: 0,
            waitingForInput: false,
            lastError: "",
            completion: restored.completion === "blocked" ? "continue" : restored.completion ?? "continue",
            lastUsage: restored.lastUsage ?? emptyTokenUsage(),
            totalUsage: restored.totalUsage ?? emptyTokenUsage(),
          }
        : {
            id: preset.id,
            name: preset.name,
            brief: preset.brief,
            publishChannel: preset.publishChannel,
            model: preset.model ?? this.config.defaults.model ?? null,
            status: "starting",
            turnCount: 0,
            lastConsumedSequence: 0,
            pendingSignals: 0,
            waitingForInput: false,
            lastPrompt: "",
            lastInput: "",
            lastError: "",
            lastResponseAt: null,
            completion: "continue",
            workingNotes: [],
            teamMessage: "",
            stdoutTail: "",
            stderrTail: "",
            lastUsage: emptyTokenUsage(),
            totalUsage: emptyTokenUsage(),
          };
      const runtime = new CodexAgentProcess({
        config: this.config,
        agent: preset,
        workspacePath: this.workspacePath,
        language: this.config.defaults.language,
        files,
        hooks: {
          onState: (update) => this.updateAgentSnapshot(preset.id, update),
          onStdout: (text) => this.captureAgentStream(preset.id, "stdout", text),
          onStderr: (text) => this.captureAgentStream(preset.id, "stderr", text),
        },
      });
      if (restored) {
        runtime.restoreFromSnapshot(restored, { interrupted: this.wasInterruptedSnapshot(restored) });
      }
      this.agents.set(preset.id, {
        preset,
        files,
        process: runtime,
        snapshot,
        pendingDigest: emptyPendingDigest(),
        inFlightDigest: null,
        draining: false,
        drainTimer: null,
      });
      this.persistAgent(preset.id);
    }
  }

  subscribe(handler: (payload: unknown) => void): () => void {
    this.subscribers.add(handler);
    handler({ type: "session", sessionId: this.id, snapshot: this.snapshot() });
    return () => {
      this.subscribers.delete(handler);
    };
  }

  snapshot(): SessionSnapshot {
    const totalUsage = [...this.agents.values()].reduce((accumulator, entry) => addTokenUsage(accumulator, entry.snapshot.totalUsage), emptyTokenUsage());
    return {
      id: this.id,
      title: this.title,
      goal: this.goal,
      workspaceName: this.workspaceName,
      workspacePath: this.workspacePath,
      createdAt: this.id.slice(0, 15),
      updatedAt: this.updatedAt,
      status: this.status,
      eventCount: this.sequence,
      agentCount: this.agents.size,
      selectedAgentId: this.agents.keys().next().value ?? null,
      agents: [...this.agents.values()].map((entry) => ({ ...entry.snapshot })),
      recentEvents: [...this.recentEvents],
      totalUsage,
    };
  }

  async sendGoal(text: string): Promise<void> {
    this.goal = text.trim();
    for (const agent of this.agents.values()) {
      agent.snapshot.completion = "continue";
    }
    this.status = "running";
    this.publish("user", this.goalChannel(), this.goal);
  }

  async sendOperatorInstruction(text: string, targetAgentId?: string | null): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    this.publish("operator", this.operatorChannel(), trimmed, targetAgentId ? { targetAgentId } : undefined);
  }

  async sendHumanInput(agentId: string, text: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    this.updateAgentSnapshot(agentId, { lastInput: trimmed, waitingForInput: false });
    this.publish("operator", this.operatorChannel(), trimmed, { targetAgentId: agentId, directInput: true });
  }

  async stop(): Promise<void> {
    this.status = "stopping";
    this.persistSession();
    for (const agent of this.agents.values()) {
      if (agent.drainTimer) {
        clearTimeout(agent.drainTimer);
        agent.drainTimer = null;
      }
      await agent.process.stop();
      this.updateAgentSnapshot(agent.preset.id, { status: "stopped", waitingForInput: false });
    }
    this.status = "stopped";
    this.publish("system", "status", "Session stopped by operator.");
  }

  private publish(sender: string, channel: SessionChannel, content: string, metadata?: Record<string, unknown>): void {
    const event: SessionEvent = {
      sequence: ++this.sequence,
      timestamp: nowIso(),
      sender,
      channel,
      content,
      metadata,
    };
    this.updatedAt = event.timestamp;
    this.recentEvents = [...this.recentEvents.slice(-(RECENT_EVENT_LIMIT - 1)), event];
    appendSessionEvent(this.files, event);
    this.routeEvent(event);
    this.persistSession();
    this.emit({ type: "event", sessionId: this.id, event, snapshot: this.snapshot() });
  }

  private shouldRouteEventToAgent(agent: RuntimeAgent, event: SessionEvent): boolean {
    if (!agent.preset.listenChannels.includes(event.channel)) {
      return false;
    }
    if (event.sender === agent.preset.name) {
      return false;
    }
    const targetIds = extractTargetAgentIds(event.metadata);
    if (targetIds.length > 0 && !targetIds.includes(agent.preset.id)) {
      return false;
    }
    if (this.shouldIgnoreCompletedAgent(agent, event)) {
      return false;
    }
    if (this.shouldMuteResearchFollowup(agent, event)) {
      return false;
    }
    return true;
  }

  private routeEvent(event: SessionEvent): void {
    for (const agent of this.agents.values()) {
      if (!this.shouldRouteEventToAgent(agent, event)) {
        continue;
      }
      agent.pendingDigest = mergePendingDigest(agent.pendingDigest, event, this.config);
      agent.snapshot.pendingSignals = agent.pendingDigest.totalCount;
      this.persistAgent(agent.preset.id);
      this.scheduleAgentDrain(agent.preset.id);
    }
  }

  private rebuildPendingDigestsFromHistory(): void {
    const events = readSessionEvents(this.files.eventsJsonl);
    for (const agent of this.agents.values()) {
      agent.pendingDigest = emptyPendingDigest();
      agent.snapshot.pendingSignals = 0;
      const afterSequence = Number(agent.snapshot.lastConsumedSequence || 0);
      for (const event of events) {
        if (event.sequence <= afterSequence) {
          continue;
        }
        if (!this.shouldRouteEventToAgent(agent, event)) {
          continue;
        }
        agent.pendingDigest = mergePendingDigest(agent.pendingDigest, event, this.config);
      }
      agent.snapshot.pendingSignals = agent.pendingDigest.totalCount;
      this.persistAgent(agent.preset.id);
    }
  }

  private scheduleAgentDrain(agentId: string, immediate = false): void {
    const agent = this.agents.get(agentId);
    if (!agent || this.status === "stopped") {
      return;
    }
    if (agent.drainTimer) {
      clearTimeout(agent.drainTimer);
      agent.drainTimer = null;
    }
    agent.drainTimer = setTimeout(() => {
      const runtime = this.agents.get(agentId);
      if (!runtime) {
        return;
      }
      runtime.drainTimer = null;
      if (this.status !== "stopped") {
        void this.drainAgent(agentId);
      }
    }, immediate ? 0 : DRAIN_DEBOUNCE_MS);
  }

  private async drainAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent || agent.draining || !hasPendingDigest(agent.pendingDigest) || agent.snapshot.status === "error" || agent.snapshot.status === "starting") {
      return;
    }
    if (agent.preset.maxTurns > 0 && agent.snapshot.turnCount >= agent.preset.maxTurns) {
      return;
    }
    if (this.shouldDeferAgent(agent)) {
      this.updateAgentSnapshot(agentId, { status: "idle" });
      return;
    }

    agent.draining = true;
    const digest = agent.pendingDigest;
    agent.pendingDigest = emptyPendingDigest();
    agent.inFlightDigest = digest;
    agent.snapshot.pendingSignals = 0;
    this.updateAgentSnapshot(agentId, { status: "running" });
    const transcript = this.buildTranscript(agent, digest);
    const triggerSummary = buildTriggerSummary(digest) || "(no new triggers)";

    try {
      const result = await agent.process.runTurn(this.goal, transcript, triggerSummary);
      this.applyTurnResult(agentId, result, maxDigestSequence(digest));
    } catch (error) {
      const message = String((error as Error).message || "");
      if (this.status === "stopping" && message.includes("Codex run stopped")) {
        return;
      }
      this.applyTurnResult(agentId, {
        shouldReply: false,
        workingNotes: [`Codex turn failed: ${(error as Error).message}`],
        teamMessage: "",
        completion: "blocked",
        rawText: "",
      }, maxDigestSequence(digest));
    } finally {
      agent.draining = false;
      agent.inFlightDigest = null;
      if (hasPendingDigest(agent.pendingDigest) && this.status !== "stopped") {
        this.scheduleAgentDrain(agentId, true);
      } else if (this.status === "running" && [...this.agents.values()].every((entry) => !entry.draining && !hasPendingDigest(entry.pendingDigest))) {
        this.status = "idle";
        this.persistSession();
        this.emit({ type: "session", sessionId: this.id, snapshot: this.snapshot() });
      }
    }
  }

  private applyTurnResult(agentId: string, result: AgentTurnResult, consumedSequence = 0): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }
    agent.snapshot.turnCount += 1;
    agent.snapshot.lastConsumedSequence = Math.max(Number(agent.snapshot.lastConsumedSequence || 0), consumedSequence);
    agent.snapshot.completion = result.completion;
    agent.snapshot.workingNotes = result.workingNotes;
    agent.snapshot.teamMessage = result.teamMessage;
    agent.snapshot.lastResponseAt = nowIso();
    agent.snapshot.status = result.completion === "blocked" ? "error" : "idle";

    if (result.workingNotes.length > 0) {
      this.appendAgentHistory(agent, "notes", result.workingNotes.join("\n"), `Turn ${agent.snapshot.turnCount}`);
    }
    if (result.teamMessage) {
      this.appendAgentHistory(agent, "messages", result.teamMessage, `Turn ${agent.snapshot.turnCount}`);
    }

    this.persistAgent(agentId);
    this.emit({ type: "agent", sessionId: this.id, agent: { ...agent.snapshot } });

    const requestedTargetIds = Array.isArray(result.targetAgentIds) && result.targetAgentIds.length > 0
      ? result.targetAgentIds
      : result.targetAgentId
        ? [result.targetAgentId]
        : [];
    const normalizedTargetAgentIds = [...new Set(
      requestedTargetIds
        .map((value) => String(value ?? "").trim())
        .filter((value) => value && value !== agentId && this.agents.has(value)),
    )];
    const effectiveTargetAgentIds = this.shouldForceBroadcastResearch(agent) ? [] : normalizedTargetAgentIds;

    const eventMetadata = {
      agentId,
      agentRole: agent.preset.role,
      turnCount: agent.snapshot.turnCount,
      shouldReply: result.shouldReply,
      completion: result.completion,
      ...(effectiveTargetAgentIds.length === 1 ? { targetAgentId: effectiveTargetAgentIds[0] } : {}),
      ...(effectiveTargetAgentIds.length > 0 ? { targetAgentIds: effectiveTargetAgentIds } : {}),
    };

    if (result.workingNotes.length > 0) {
      this.publish(agent.preset.name, "status", result.workingNotes.join(" | "), eventMetadata);
    }
    if (result.shouldReply && result.teamMessage) {
      this.status = "running";
      this.publish(agent.preset.name, agent.preset.publishChannel, result.teamMessage, eventMetadata);
    }
  }

  private captureAgentStream(agentId: string, stream: "stdout" | "stderr", text: string): void {
    const agent = this.agents.get(agentId);
    if (!agent || !text) {
      return;
    }
    const field = stream === "stdout" ? "stdoutTail" : "stderrTail";
    agent.snapshot[field] = tailText(`${agent.snapshot[field]}${text}`, SNAPSHOT_STREAM_TAIL);
    this.persistAgent(agentId);
    this.emit({ type: "stream", sessionId: this.id, agentId, stream, text });
  }

  private updateAgentSnapshot(agentId: string, update: Partial<AgentSnapshot>): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }
    const previousPrompt = agent.snapshot.lastPrompt;
    const previousError = agent.snapshot.lastError;
    agent.snapshot = {
      ...agent.snapshot,
      ...update,
    };
    if (typeof update.lastPrompt === "string" && update.lastPrompt.trim() && update.lastPrompt !== previousPrompt) {
      agent.snapshot.lastPrompt = tailText(update.lastPrompt, 4000);
    }
    if (typeof update.lastError === "string" && update.lastError.trim() && update.lastError !== previousError) {
      agent.snapshot.lastError = tailText(update.lastError, 4000);
      this.appendAgentHistory(agent, "errors", update.lastError.trim(), agent.snapshot.status === "error" ? "Agent Error" : null);
    }
    this.persistAgent(agentId);
    this.persistSession();
    this.emit({ type: "agent", sessionId: this.id, agent: { ...agent.snapshot } });
  }

  private appendAgentHistory(agent: RuntimeAgent, kind: "notes" | "messages" | "errors", text: string, label?: string | null): void {
    const normalized = String(text ?? "").trim();
    if (!normalized) {
      return;
    }
    appendAgentHistory(agent.files, {
      id: `${agent.preset.id}-${kind}-${++this.historySerial}`,
      timestamp: nowIso(),
      kind,
      text: normalized,
      label: label ?? null,
      metadata: {
        agentId: agent.preset.id,
        turnCount: agent.snapshot.turnCount,
      },
    });
  }

  private persistAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }
    writeAgentSnapshot(agent.files.stateJson, agent.snapshot);
  }

  private persistSession(): void {
    writeSessionSnapshot(this.files, this.snapshot());
  }

  private latestGoalSequence(): number {
    for (let index = this.recentEvents.length - 1; index >= 0; index -= 1) {
      if (this.recentEvents[index].channel === this.goalChannel()) {
        return this.recentEvents[index].sequence;
      }
    }
    return 0;
  }

  private requiredResearchSources(): number {
    const researchAgentCount = [...this.agents.values()].filter((agent) => this.isRole(agent, "research")).length;
    return Math.max(1, Math.min(2, researchAgentCount));
  }

  private hasEnoughResearchContext(): boolean {
    const latestGoalSequence = this.latestGoalSequence();
    const researchEvents = this.recentEvents.filter(
      (event) => this.isResearchEvent(event) && event.sequence > latestGoalSequence && event.sender !== "system",
    );
    const senders = new Set(researchEvents.map((event) => event.sender));
    return senders.size >= this.requiredResearchSources() && researchEvents.length >= 3;
  }

  private hasImplementationContext(): boolean {
    const latestGoalSequence = this.latestGoalSequence();
    return this.recentEvents.some(
      (event) =>
        this.isImplementationEvent(event) &&
        event.sequence > latestGoalSequence &&
        event.sender !== "system" &&
        compactWhitespace(event.content).length > 0,
    );
  }

  private shouldIgnoreCompletedAgent(agent: RuntimeAgent, event: SessionEvent): boolean {
    if (agent.snapshot.completion !== "done") {
      return false;
    }
    const targetIds = extractTargetAgentIds(event.metadata);
    if (targetIds.includes(agent.preset.id)) {
      return false;
    }
    if (event.channel === this.goalChannel() || event.channel === this.operatorChannel()) {
      return false;
    }
    if (this.isRole(agent, "implementation")) {
      return !this.isReviewEvent(event);
    }
    if (this.isRole(agent, "review")) {
      return !this.isImplementationEvent(event);
    }
    return true;
  }

  private wasInterruptedSnapshot(snapshot: AgentSnapshot): boolean {
    if (!snapshot) {
      return false;
    }
    if (snapshot.completion === "blocked") {
      return true;
    }
    if (compactWhitespace(snapshot.lastError).toLowerCase().includes("stopped")) {
      return true;
    }
    const notes = Array.isArray(snapshot.workingNotes) ? snapshot.workingNotes.join(" ") : "";
    return compactWhitespace(notes).toLowerCase().includes("stopped");
  }

  private researchReplyCountSinceGoal(agentName: string): number {
    const latestGoalSequence = this.latestGoalSequence();
    return this.recentEvents.filter(
      (event) => event.sender === agentName && this.isResearchEvent(event) && event.sequence > latestGoalSequence,
    ).length;
  }

  private shouldMuteResearchFollowup(agent: RuntimeAgent, event: SessionEvent): boolean {
    if (!this.isRole(agent, "research")) {
      return false;
    }
    if (!this.isResearchEvent(event)) {
      return false;
    }
    if (this.hasImplementationContext()) {
      return true;
    }
    return this.researchReplyCountSinceGoal(agent.preset.name) >= 1;
  }

  private hasOperatorOverride(agent: RuntimeAgent): boolean {
    return agent.pendingDigest.operatorEvents.length > 0 || agent.pendingDigest.directInputs.length > 0;
  }

  private shouldForceBroadcastResearch(agent: RuntimeAgent): boolean {
    if (!this.isRole(agent, "research")) {
      return false;
    }
    if (this.hasOperatorOverride(agent)) {
      return false;
    }
    if (this.hasImplementationContext()) {
      return false;
    }
    return agent.snapshot.turnCount === 0;
  }

  private shouldDeferAgent(agent: RuntimeAgent): boolean {
    if (this.isRole(agent, "implementation")) {
      return !this.hasOperatorOverride(agent) && !this.hasEnoughResearchContext();
    }
    if (this.isRole(agent, "review")) {
      return !this.hasOperatorOverride(agent) && !this.hasImplementationContext();
    }
    return false;
  }

  private transcriptEventLimit(agent: RuntimeAgent): number {
    const configured = Math.max(1, Number(this.config.defaults.historyTail || 0) || 1);
    if (this.isRole(agent, "implementation") || this.isRole(agent, "review")) {
      return Math.min(configured, 6);
    }
    return Math.min(configured, 5);
  }

  private transcriptCharLimit(agent: RuntimeAgent): number {
    if (this.isRole(agent, "implementation") || this.isRole(agent, "review")) {
      return 180;
    }
    return 150;
  }

  private transcriptChannels(agent: RuntimeAgent): Set<SessionChannel> {
    if (this.isRole(agent, "implementation")) {
      return new Set<SessionChannel>([this.goalChannel(), this.operatorChannel(), this.researchChannel(), this.reviewChannel(), ...agent.preset.listenChannels]);
    }
    if (this.isRole(agent, "review")) {
      return new Set<SessionChannel>([this.goalChannel(), this.operatorChannel(), this.implementationChannel(), this.researchChannel(), ...agent.preset.listenChannels]);
    }
    if (this.hasImplementationContext()) {
      return new Set<SessionChannel>([this.goalChannel(), this.operatorChannel(), this.implementationChannel(), ...agent.preset.listenChannels]);
    }
    return new Set<SessionChannel>([this.goalChannel(), this.operatorChannel(), this.researchChannel(), this.implementationChannel(), ...agent.preset.listenChannels]);
  }

  private buildTranscript(agent: RuntimeAgent, digest: PendingDigest): string {
    const latestGoalSequence = this.latestGoalSequence();
    const allowedChannels = this.transcriptChannels(agent);
    const skipSequences = digestSequences(digest);
    const events = this.recentEvents
      .filter((event) => {
        const targetIds = extractTargetAgentIds(event.metadata);
        const isTargetedTeamMessage = event.channel !== this.operatorChannel() && targetIds.length > 0;
        if (event.sender === agent.preset.name) {
          return false;
        }
        if (event.channel === "status" || event.channel === "system") {
          return false;
        }
        if (!isTargetedTeamMessage && !allowedChannels.has(event.channel)) {
          return false;
        }
        if (event.channel === this.operatorChannel() && targetIds.length > 0 && !targetIds.includes(agent.preset.id)) {
          return false;
        }
        if (latestGoalSequence > 0 && event.sequence < latestGoalSequence) {
          return false;
        }
        if (skipSequences.has(event.sequence)) {
          return false;
        }
        return true;
      })
      .slice(-this.transcriptEventLimit(agent));

    if (events.length === 0) {
      return "(no prior transcript)";
    }

    return events
      .map((event) => {
        const targetText = formatTargetSuffix(event.metadata);
        return `#${event.sequence} ${event.sender} -> ${event.channel}${targetText}: ${shortenText(event.content, this.transcriptCharLimit(agent))}`;
      })
      .join("\n");
  }

  private emit(payload: unknown): void {
    for (const handler of this.subscribers) {
      handler(payload);
    }
  }
}
