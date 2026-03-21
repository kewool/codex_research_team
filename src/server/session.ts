// @ts-nocheck
import { existsSync, readFileSync } from "node:fs";
import {
  AgentPreset,
  AgentSnapshot,
  AgentTurnResult,
  AppConfig,
  SessionChannel,
  SessionEvent,
  SessionSubgoal,
  SessionSnapshot,
  SessionStatus,
  SubgoalStage,
  SubgoalUpdate,
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
  channelEvents: Record<string, SessionEvent[]>;
  otherEvents: SessionEvent[];
}

interface RuntimeAgent {
  preset: AgentPreset;
  files: AgentFiles;
  process: CodexAgentProcess;
  snapshot: AgentSnapshot;
  pendingDigest: PendingDigest;
  inFlightDigest: PendingDigest | null;
  inFlightSubgoalRefs: TrackedSubgoalRef[] | null;
  draining: boolean;
  drainTimer: ReturnType<typeof setTimeout> | null;
}

interface SubgoalUpdateResult {
  changedIds: string[];
  blockedBuildPromotion: boolean;
  conflicts: StaleSubgoalConflict[];
}

interface StaleSubgoalConflict {
  reason: "stale_update" | "obsolete_turn";
  subgoalId: string;
  agentId: string;
  expectedRevision: number;
  currentRevision: number;
  requestedStage: SubgoalStage;
  currentStage: SubgoalStage;
  currentAssigneeAgentId: string | null;
  message: string;
}

interface TrackedSubgoalRef {
  id: string;
  revision: number;
  stage: SubgoalStage;
  assigneeAgentId: string | null;
}

const SUBGOAL_STAGE_SET = new Set<SubgoalStage>([
  "open",
  "researching",
  "ready_for_build",
  "building",
  "ready_for_review",
  "done",
  "blocked",
]);

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

function formatSubgoalSuffix(metadata: Record<string, unknown> | undefined): string {
  const subgoalIds = Array.isArray(metadata?.subgoalIds)
    ? metadata.subgoalIds.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
  return subgoalIds.length > 0 ? ` subgoals=${[...new Set(subgoalIds)].join(",")}` : "";
}

function formatDigestEvent(event: SessionEvent, maxChars = 220): string {
  const targetText = formatTargetSuffix(event.metadata);
  const directText = event.metadata?.directInput ? " direct-input" : "";
  const subgoalText = formatSubgoalSuffix(event.metadata);
  return `- #${event.sequence} ${event.sender} -> ${event.channel}${targetText}${subgoalText}${directText}: ${shortenText(event.content, maxChars)}`;
}

function emptyPendingDigest(): PendingDigest {
  return {
    totalCount: 0,
    latestGoal: null,
    operatorEvents: [],
    directInputs: [],
    channelEvents: {},
    otherEvents: [],
  };
}

function hasPendingDigest(digest: PendingDigest): boolean {
  return digest.totalCount > 0;
}

function mergePendingDigest(digest: PendingDigest, event: SessionEvent): PendingDigest {
  if (event.metadata?.goalEvent) {
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
    channelEvents: Object.fromEntries(
      Object.entries(digest.channelEvents).map(([channel, events]) => [channel, [...events]]),
    ),
    otherEvents: [...digest.otherEvents],
  };

  if (event.metadata?.operatorEvent) {
    if (event.metadata?.directInput) {
      next.directInputs = [...next.directInputs, event];
    } else {
      next.operatorEvents = [...next.operatorEvents, event];
    }
    return next;
  }

  if (event.channel !== "status" && event.channel !== "system") {
    next.channelEvents[event.channel] = [...(next.channelEvents[event.channel] || []), event];
    return next;
  }

  next.otherEvents = [...next.otherEvents, event];
  return next;
}

function buildDigestSection(title: string, events: SessionEvent[], maxChars = 220): string {
  if (events.length === 0) {
    return "";
  }
  return `${title}:\n${events.map((event) => formatDigestEvent(event, maxChars)).join("\n")}`;
}

function buildTriggerSummary(digest: PendingDigest): string {
  const sections: string[] = [];
  if (digest.latestGoal) {
    sections.push(`Goal update:\n${formatDigestEvent(digest.latestGoal, 420)}`);
  }
  const directInputsSection = buildDigestSection("Direct operator inputs", digest.directInputs, 480);
  if (directInputsSection) {
    sections.push(directInputsSection);
  }
  const operatorSection = buildDigestSection("Operator directives", digest.operatorEvents, 320);
  if (operatorSection) {
    sections.push(operatorSection);
  }
  for (const [channel, events] of Object.entries(digest.channelEvents)) {
    const channelSection = buildDigestSection(`Channel digest: ${channel}`, events, 220);
    if (channelSection) {
      sections.push(channelSection);
    }
  }
  const otherSection = buildDigestSection("Additional channel updates", digest.otherEvents, 180);
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
  for (const events of Object.values(digest.channelEvents)) {
    for (const event of events) {
      push(event);
    }
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

function normalizeSubgoalStage(value: unknown, fallback: SubgoalStage = "researching"): SubgoalStage {
  const stage = String(value ?? "").trim();
  return SUBGOAL_STAGE_SET.has(stage as SubgoalStage) ? (stage as SubgoalStage) : fallback;
}

function createSeedSubgoal(goal: string, revision: number, timestamp: string): SessionSubgoal {
  const normalized = compactWhitespace(goal);
  const title = normalized.length > 72 ? `${normalized.slice(0, 69).trimEnd()}...` : normalized;
  return {
    id: "sg-1",
    title: title || "Initial subgoal",
    summary: normalized || "Investigate the top-level goal and break it down into actionable work.",
    stage: "open",
    assigneeAgentId: null,
    updatedAt: timestamp,
    updatedBy: "system",
    revision,
    conflictCount: 0,
    activeConflict: false,
    lastConflictAt: null,
    lastConflictSummary: null,
  };
}

function normalizeExpectedRevision(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : null;
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
  private subgoals: SessionSubgoal[] = [];
  private subgoalRevision = 0;
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
      this.subgoalRevision = Math.max(0, Number(options.snapshot.subgoalRevision || 0));
      this.subgoals = Array.isArray(options.snapshot.subgoals)
        ? options.snapshot.subgoals.map((subgoal) => ({
            id: String(subgoal?.id ?? "").trim(),
            title: String(subgoal?.title ?? "").trim() || "Untitled subgoal",
            summary: String(subgoal?.summary ?? "").trim(),
            stage: normalizeSubgoalStage(subgoal?.stage, "researching"),
            assigneeAgentId: String(subgoal?.assigneeAgentId ?? "").trim() || null,
            updatedAt: String(subgoal?.updatedAt ?? nowIso()),
            updatedBy: String(subgoal?.updatedBy ?? "system"),
            revision: Math.max(1, Number(subgoal?.revision || 1)),
            conflictCount: Math.max(0, Number(subgoal?.conflictCount || 0)),
            activeConflict: Boolean(subgoal?.activeConflict),
            lastConflictAt: subgoal?.lastConflictAt ? String(subgoal.lastConflictAt) : null,
            lastConflictSummary: subgoal?.lastConflictSummary ? String(subgoal.lastConflictSummary) : null,
          }))
        : [];
      this.updatedAt = String(options.snapshot.updatedAt || this.updatedAt);
      this.status = options.snapshot.status === "stopped" || options.snapshot.status === "error" ? "idle" : options.snapshot.status;
      this.historySerial = Math.max(0, this.sequence * 10);
    }
    if (this.subgoals.length === 0) {
      this.subgoalRevision = Math.max(1, this.subgoalRevision || 1);
      this.subgoals = [createSeedSubgoal(this.goal, this.subgoalRevision, this.updatedAt)];
    }
  }

  private goalChannel(): SessionChannel {
    return this.config.defaults.goalChannel;
  }

  private operatorChannel(): SessionChannel {
    return this.config.defaults.operatorChannel;
  }

  private isGoalEvent(event: SessionEvent): boolean {
    return Boolean(event.metadata?.goalEvent);
  }

  private isOperatorEvent(event: SessionEvent): boolean {
    return Boolean(event.metadata?.operatorEvent);
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
      this.publish("user", this.goalChannel(), this.goal, { goalEvent: true });
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
          { targetAgentId: runtime.preset.id, operatorEvent: true },
        );
      }
    }

    for (const runtime of this.agents.values()) {
      void runtime.process
        .start(this.goal)
        .then(() => {
          if ((hasPendingDigest(runtime.pendingDigest) || this.goalBoardNeedsAttention(runtime)) && this.status !== "stopped") {
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
            lastSeenSubgoalRevision: Math.max(0, Number(restored.lastSeenSubgoalRevision ?? this.subgoalRevision ?? 0)),
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
            lastSeenSubgoalRevision: 0,
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
        inFlightSubgoalRefs: null,
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
      subgoalRevision: this.subgoalRevision,
      agentCount: this.agents.size,
      selectedAgentId: this.agents.keys().next().value ?? null,
      agents: [...this.agents.values()].map((entry) => ({ ...entry.snapshot })),
      recentEvents: [...this.recentEvents],
      subgoals: this.subgoals.map((subgoal) => ({ ...subgoal })),
      totalUsage,
    };
  }

  async sendGoal(text: string): Promise<void> {
    this.goal = text.trim();
    this.resetGoalBoard(this.goal, "operator");
    for (const agent of this.agents.values()) {
      agent.snapshot.completion = "continue";
    }
    this.status = "running";
    this.publish("user", this.goalChannel(), this.goal, { goalEvent: true });
  }

  async sendOperatorInstruction(text: string, targetAgentId?: string | null): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    this.publish("operator", this.operatorChannel(), trimmed, {
      ...(targetAgentId ? { targetAgentId } : {}),
      operatorEvent: true,
    });
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
    this.publish("operator", this.operatorChannel(), trimmed, { targetAgentId: agentId, directInput: true, operatorEvent: true });
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
    const ownsDiscoveryStages = agent.preset.policy.ownedStages.includes("open") || agent.preset.policy.ownedStages.includes("researching");
    const ownsOnlyReviewStage =
      Array.isArray(agent.preset.policy.ownedStages) &&
      agent.preset.policy.ownedStages.length > 0 &&
      agent.preset.policy.ownedStages.every((stage) => stage === "ready_for_review");
    if (!this.isGoalEvent(event) && !this.isOperatorEvent(event) && targetIds.length === 0 && !ownsDiscoveryStages && this.discoveryChannels().has(event.channel)) {
      return false;
    }
    if (ownsOnlyReviewStage && !this.isOperatorEvent(event) && !this.goalBoardNeedsAttention(agent)) {
      return false;
    }
    if (this.shouldIgnoreCompletedAgent(agent, event)) {
      return false;
    }
    return true;
  }

  private routeEvent(event: SessionEvent): void {
    for (const agent of this.agents.values()) {
      if (!this.shouldRouteEventToAgent(agent, event)) {
        continue;
      }
      agent.pendingDigest = mergePendingDigest(agent.pendingDigest, event);
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
        agent.pendingDigest = mergePendingDigest(agent.pendingDigest, event);
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
    if (!agent || agent.draining || agent.snapshot.status === "error" || agent.snapshot.status === "starting") {
      return;
    }
    if (!hasPendingDigest(agent.pendingDigest) && !this.goalBoardNeedsAttention(agent)) {
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
    agent.inFlightSubgoalRefs = this.captureTrackedSubgoalRefs(agent);
    agent.snapshot.pendingSignals = 0;
    this.updateAgentSnapshot(agentId, { status: "running" });
    const transcript = this.buildTranscript(agent, digest);
    const digestSummary = buildTriggerSummary(digest);
    const triggerSummary = [
      "Goal board:",
      this.buildGoalBoardSummary(agent),
      "",
      "Actionable subgoals for you:",
      this.buildActionableSubgoalSummary(agent),
      "",
      "Message triggers for this turn:",
      digestSummary || "(no new message triggers)",
    ].join("\n");

    try {
      const result = await agent.process.runTurn(this.goal, transcript, triggerSummary);
      this.applyTurnResult(agentId, result, maxDigestSequence(digest), agent.inFlightSubgoalRefs);
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
      }, maxDigestSequence(digest), agent.inFlightSubgoalRefs);
    } finally {
      agent.draining = false;
      agent.inFlightDigest = null;
      agent.inFlightSubgoalRefs = null;
      if (hasPendingDigest(agent.pendingDigest) && this.status !== "stopped") {
        this.scheduleAgentDrain(agentId, true);
      } else if (this.status === "running") {
        const pendingGoalBoardAgent = [...this.agents.values()].find((entry) => !entry.draining && this.goalBoardNeedsAttention(entry));
        if (pendingGoalBoardAgent) {
          this.scheduleAgentDrain(pendingGoalBoardAgent.preset.id, true);
        } else if ([...this.agents.values()].every((entry) => !entry.draining && !hasPendingDigest(entry.pendingDigest))) {
          this.status = "idle";
          this.persistSession();
          this.emit({ type: "session", sessionId: this.id, snapshot: this.snapshot() });
        }
      }
    }
  }

  private applyTurnResult(agentId: string, result: AgentTurnResult, consumedSequence = 0, inFlightSubgoalRefs: TrackedSubgoalRef[] | null = null): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }
    const obsoleteConflicts = this.buildObsoleteTurnConflicts(agentId, inFlightSubgoalRefs);
    const hasRequestedStateMutation = Array.isArray(result.subgoalUpdates) && result.subgoalUpdates.length > 0;
    const hasMeaningfulTurnOutput = hasRequestedStateMutation || Boolean(result.teamMessage) || result.completion === "done" || result.completion === "blocked";
    const shouldSuppressObsoleteTurn = obsoleteConflicts.length > 0 && hasMeaningfulTurnOutput;
    const requestedStages = new Set(
      (Array.isArray(result.subgoalUpdates) ? result.subgoalUpdates : [])
        .map((update) => String(update?.stage ?? "").trim())
        .filter(Boolean),
    );
    agent.snapshot.turnCount += 1;
    agent.snapshot.lastConsumedSequence = Math.max(Number(agent.snapshot.lastConsumedSequence || 0), consumedSequence);
    const subgoalResult = shouldSuppressObsoleteTurn
      ? { changedIds: this.recordSubgoalConflicts(obsoleteConflicts), blockedBuildPromotion: false, conflicts: [] as StaleSubgoalConflict[] }
      : this.applySubgoalUpdates(agentId, result.subgoalUpdates);
    const changedSubgoalIds = [...new Set([...subgoalResult.changedIds, ...obsoleteConflicts.map((conflict) => conflict.subgoalId)])];
    if (!shouldSuppressObsoleteTurn) {
      agent.snapshot.lastSeenSubgoalRevision = this.subgoalRevision;
    }
    agent.snapshot.completion = shouldSuppressObsoleteTurn && result.completion !== "blocked" ? "continue" : result.completion;
    agent.snapshot.workingNotes = result.workingNotes;
    agent.snapshot.teamMessage = result.teamMessage;
    agent.snapshot.lastResponseAt = nowIso();
    agent.snapshot.status = shouldSuppressObsoleteTurn ? "idle" : (result.completion === "blocked" ? "error" : "idle");

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
    const allowedTargetSet = new Set(
      (Array.isArray(agent.preset.policy.allowedTargetAgentIds) ? agent.preset.policy.allowedTargetAgentIds : [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    );
    const restrictedTargetAgentIds = allowedTargetSet.size > 0
      ? normalizedTargetAgentIds.filter((value) => allowedTargetSet.has(value))
      : normalizedTargetAgentIds;
    const peerDeferredTargetAgentIds = this.applyPeerContextTargetDeferral(agent, restrictedTargetAgentIds);
    let effectiveTargetAgentIds = this.shouldForceBroadcastOnFirstTurn(agent) ? [] : peerDeferredTargetAgentIds;
    const allowedTargets = new Set(
      (Array.isArray(agent.preset.policy.allowedTargetAgentIds) ? agent.preset.policy.allowedTargetAgentIds : [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    );
    const reviewerId = this.defaultAssigneeForStage("ready_for_review");
    const routingOwnerIds = [
      this.defaultAssigneeForStage("ready_for_build"),
      this.defaultAssigneeForStage("blocked"),
    ].filter((value): value is string => Boolean(value));
    const ownsBuildStage = Array.isArray(agent.preset.policy?.ownedStages) && agent.preset.policy.ownedStages.includes("building");
    const ownsReviewStageOnly =
      Array.isArray(agent.preset.policy?.ownedStages) &&
      agent.preset.policy.ownedStages.length > 0 &&
      agent.preset.policy.ownedStages.every((stage) => stage === "ready_for_review");
    const isAuditHandoff =
      ownsBuildStage &&
      requestedStages.has("ready_for_review") &&
      !requestedStages.has("blocked") &&
      !requestedStages.has("researching");
    if (isAuditHandoff && reviewerId && allowedTargets.has(reviewerId)) {
      if (effectiveTargetAgentIds.length === 0 || effectiveTargetAgentIds.every((value) => routingOwnerIds.includes(value))) {
        effectiveTargetAgentIds = [reviewerId];
      } else if (!effectiveTargetAgentIds.includes(reviewerId)) {
        effectiveTargetAgentIds = [reviewerId, ...effectiveTargetAgentIds];
      }
    }
    if (subgoalResult.blockedBuildPromotion) {
      effectiveTargetAgentIds = effectiveTargetAgentIds.filter((value) => value !== "implementer_1");
    }
    if (ownsReviewStageOnly && requestedStages.has("done") && effectiveTargetAgentIds.length === 0) {
      result.shouldReply = false;
      result.teamMessage = "";
    }

    const eventMetadata = {
      agentId,
      turnCount: agent.snapshot.turnCount,
      shouldReply: result.shouldReply,
      completion: result.completion,
      ...(changedSubgoalIds.length > 0 ? { subgoalIds: changedSubgoalIds } : {}),
      ...(effectiveTargetAgentIds.length === 1 ? { targetAgentId: effectiveTargetAgentIds[0] } : {}),
      ...(effectiveTargetAgentIds.length > 0 ? { targetAgentIds: effectiveTargetAgentIds } : {}),
    };

    if (result.workingNotes.length > 0) {
      this.publish(agent.preset.name, "status", result.workingNotes.join(" | "), eventMetadata);
    }
    if (result.shouldReply && result.teamMessage && !shouldSuppressObsoleteTurn) {
      this.status = "running";
      this.publish(agent.preset.name, agent.preset.publishChannel, result.teamMessage, eventMetadata);
    }
    const allConflicts = [...subgoalResult.conflicts, ...obsoleteConflicts];
    if (allConflicts.length > 0) {
      const coordinatorId = this.defaultAssigneeForStage("ready_for_build");
      for (const conflict of allConflicts) {
        const conflictTargets = [...new Set(
          [coordinatorId, conflict.currentAssigneeAgentId]
            .map((value) => String(value ?? "").trim())
            .filter((value) => value && value !== agentId && this.agents.has(value)),
        )];
        this.status = "running";
        this.publish(
          "system",
          this.operatorChannel(),
          shouldSuppressObsoleteTurn && conflict.reason === "obsolete_turn" && result.teamMessage
            ? `Conflict on ${conflict.subgoalId}: ${conflict.message} Suppressed stale handoff: ${shortenText(result.teamMessage, 220)} Re-read the latest goal board before changing this subgoal again.`
            : `Conflict on ${conflict.subgoalId}: ${conflict.message} Re-read the latest goal board before changing this subgoal again.`,
          {
            operatorEvent: true,
            conflictEvent: true,
            obsoleteEvent: conflict.reason === "obsolete_turn",
            subgoalIds: [conflict.subgoalId],
            staleUpdateBy: conflict.agentId,
            expectedRevision: conflict.expectedRevision,
            currentRevision: conflict.currentRevision,
            requestedStage: conflict.requestedStage,
            currentStage: conflict.currentStage,
            ...(conflictTargets.length === 1 ? { targetAgentId: conflictTargets[0] } : {}),
            ...(conflictTargets.length > 0 ? { targetAgentIds: conflictTargets } : {}),
          },
        );
      }
    }
    if (changedSubgoalIds.length > 0) {
      this.status = "running";
      this.pingGoalBoardOwners();
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

  private resetGoalBoard(goal: string, actor: string): void {
    this.subgoalRevision = Math.max(0, this.subgoalRevision) + 1;
    const timestamp = nowIso();
    this.subgoals = [createSeedSubgoal(goal, this.subgoalRevision, timestamp)];
    for (const agent of this.agents.values()) {
      agent.snapshot.lastSeenSubgoalRevision = 0;
      this.persistAgent(agent.preset.id);
    }
    this.updatedAt = timestamp;
    this.persistSession();
  }

  private nextSubgoalId(): string {
    let maxId = 0;
    for (const subgoal of this.subgoals) {
      const match = String(subgoal.id ?? "").match(/^sg-(\d+)$/);
      const parsed = Number(match?.[1] || 0);
      if (parsed > maxId) {
        maxId = parsed;
      }
    }
    return `sg-${maxId + 1}`;
  }

  private defaultAssigneeForStage(stage: SubgoalStage): string | null {
    if (stage === "open" || stage === "researching" || stage === "done") {
      return null;
    }
    const match = this.config.agents.find((agent) => Array.isArray(agent.policy?.ownedStages) && agent.policy.ownedStages.includes(stage));
    return match?.id ?? null;
  }

  private normalizeStageForAssignee(id: string | null, stage: SubgoalStage, currentSubgoalId?: string): SubgoalStage {
    if (!id || stage !== "building") {
      return stage;
    }
    const hasOtherBuildingSubgoal = this.subgoals.some(
      (subgoal) =>
        subgoal.id !== currentSubgoalId &&
        subgoal.assigneeAgentId === id &&
        subgoal.stage === "building",
    );
    if (hasOtherBuildingSubgoal) {
      return "ready_for_build";
    }
    return stage;
  }

  private sanitizeSubgoalUpdate(update: SubgoalUpdate): SubgoalUpdate | null {
    if (!update || typeof update !== "object") {
      return null;
    }
    const id = String(update.id ?? "").trim() || null;
    const expectedRevision = normalizeExpectedRevision(update.expectedRevision);
    const title = String(update.title ?? "").trim() || null;
    const summary = String(update.summary ?? "").trim() || null;
    const stage = update.stage ? normalizeSubgoalStage(update.stage, "researching") : null;
    const assigneeAgentId = String(update.assigneeAgentId ?? "").trim() || null;
    if (!id && !expectedRevision && !title && !summary && !stage && !assigneeAgentId) {
      return null;
    }
    return {
      id,
      expectedRevision,
      title,
      summary,
      stage,
      assigneeAgentId,
    };
  }

  private shouldIgnoreStaleSubgoalUpdate(existing: SessionSubgoal, update: SubgoalUpdate): boolean {
    if (!update.id) {
      return false;
    }
    const expectedRevision = normalizeExpectedRevision(update.expectedRevision);
    if (!expectedRevision) {
      return false;
    }
    return expectedRevision !== Number(existing.revision || 0);
  }

  private buildStaleSubgoalConflict(agentId: string, existing: SessionSubgoal, update: SubgoalUpdate, requestedStage: SubgoalStage): StaleSubgoalConflict | null {
    if (!update.id) {
      return null;
    }
    const expectedRevision = normalizeExpectedRevision(update.expectedRevision);
    if (!expectedRevision) {
      return null;
    }
    const currentRevision = Number(existing.revision || 0);
    if (expectedRevision === currentRevision) {
      return null;
    }
    return {
      reason: "stale_update",
      subgoalId: existing.id,
      agentId,
      expectedRevision,
      currentRevision,
      requestedStage,
      currentStage: existing.stage,
      currentAssigneeAgentId: existing.assigneeAgentId ?? null,
      message: `${agentId} proposed ${requestedStage} for ${existing.id} on rev ${expectedRevision}, but the current board is rev ${currentRevision} in ${existing.stage}${existing.assigneeAgentId ? ` assigned to ${existing.assigneeAgentId}` : ""}.`,
    };
  }

  private captureTrackedSubgoalRefs(agent: RuntimeAgent): TrackedSubgoalRef[] {
    return this.actionableSubgoalsForAgent(agent).map((subgoal) => ({
      id: subgoal.id,
      revision: Number(subgoal.revision || 0),
      stage: subgoal.stage,
      assigneeAgentId: subgoal.assigneeAgentId ?? null,
    }));
  }

  private buildObsoleteTurnConflicts(agentId: string, trackedRefs: TrackedSubgoalRef[] | null): StaleSubgoalConflict[] {
    if (!trackedRefs || trackedRefs.length === 0) {
      return [];
    }
    const conflicts: StaleSubgoalConflict[] = [];
    for (const trackedRef of trackedRefs) {
      const existing = this.subgoals.find((subgoal) => subgoal.id === trackedRef.id);
      if (!existing) {
        continue;
      }
      const currentRevision = Number(existing.revision || 0);
      if (currentRevision === trackedRef.revision) {
        continue;
      }
      conflicts.push({
        reason: "obsolete_turn",
        subgoalId: existing.id,
        agentId,
        expectedRevision: trackedRef.revision,
        currentRevision,
        requestedStage: trackedRef.stage,
        currentStage: existing.stage,
        currentAssigneeAgentId: existing.assigneeAgentId ?? null,
        message: `${agentId} finished work for ${existing.id} using rev ${trackedRef.revision}, but the board advanced to rev ${currentRevision} in ${existing.stage}${existing.assigneeAgentId ? ` assigned to ${existing.assigneeAgentId}` : ""} while the turn was running.`,
      });
    }
    return conflicts;
  }

  private recordSubgoalConflicts(conflicts: StaleSubgoalConflict[]): string[] {
    const changedIds = new Set<string>();
    for (const conflict of conflicts) {
      const existingIndex = this.subgoals.findIndex((subgoal) => subgoal.id === conflict.subgoalId);
      if (existingIndex < 0) {
        continue;
      }
      const existing = this.subgoals[existingIndex];
      const timestamp = nowIso();
      this.subgoalRevision += 1;
      this.subgoals[existingIndex] = {
        ...existing,
        updatedAt: timestamp,
        updatedBy: "system",
        revision: this.subgoalRevision,
        conflictCount: Math.max(0, Number(existing.conflictCount || 0)) + 1,
        activeConflict: true,
        lastConflictAt: timestamp,
        lastConflictSummary: conflict.message,
      };
      changedIds.add(existing.id);
    }
    if (changedIds.size > 0) {
      this.updatedAt = nowIso();
      this.persistSession();
    }
    return [...changedIds];
  }

  private applySubgoalUpdates(agentId: string, updates: SubgoalUpdate[] | undefined): SubgoalUpdateResult {
    const normalized = Array.isArray(updates) ? updates.map((update) => this.sanitizeSubgoalUpdate(update)).filter(Boolean) as SubgoalUpdate[] : [];
    if (normalized.length === 0) {
      return { changedIds: [], blockedBuildPromotion: false, conflicts: [] };
    }

    const changedIds = new Set<string>();
    let blockedBuildPromotion = false;
    const conflicts: StaleSubgoalConflict[] = [];
    for (const update of normalized.slice(0, 8)) {
      const existingIndex = update.id ? this.subgoals.findIndex((subgoal) => subgoal.id === update.id) : -1;
      const timestamp = nowIso();
      if (existingIndex >= 0) {
        const existing = this.subgoals[existingIndex];
        let requestedStage = update.stage ? normalizeSubgoalStage(update.stage, existing.stage) : existing.stage;
        if (this.shouldIgnoreStaleSubgoalUpdate(existing, update)) {
          const conflict = this.buildStaleSubgoalConflict(agentId, existing, update, requestedStage);
          if (conflict) {
            for (const changedId of this.recordSubgoalConflicts([conflict])) {
              changedIds.add(changedId);
            }
            conflicts.push(conflict);
          }
          continue;
        }
        this.subgoalRevision += 1;
        const explicitAssignee = update.assigneeAgentId != null
          ? (update.assigneeAgentId && this.agents.has(update.assigneeAgentId) ? update.assigneeAgentId : null)
          : null;
        const requestedAssignee = explicitAssignee !== null
          ? explicitAssignee
          : (requestedStage !== existing.stage ? this.defaultAssigneeForStage(requestedStage) : existing.assigneeAgentId);
        const stage = this.normalizeStageForAssignee(requestedAssignee, requestedStage, existing.id);
        const assigneeAgentId = explicitAssignee !== null
          ? (stage === requestedStage ? explicitAssignee : this.defaultAssigneeForStage(stage))
          : (stage !== existing.stage ? this.defaultAssigneeForStage(stage) : existing.assigneeAgentId);
        this.subgoals[existingIndex] = {
          ...existing,
          title: update.title || existing.title,
          summary: update.summary || existing.summary,
          stage,
          assigneeAgentId,
          updatedAt: timestamp,
          updatedBy: agentId,
          revision: this.subgoalRevision,
          conflictCount: Math.max(0, Number(existing.conflictCount || 0)),
          activeConflict: false,
          lastConflictAt: existing.lastConflictAt ?? null,
          lastConflictSummary: existing.lastConflictSummary ?? null,
        };
        changedIds.add(existing.id);
        continue;
      }

      let requestedStage = normalizeSubgoalStage(update.stage, "researching");
      const id = this.nextSubgoalId();
      this.subgoalRevision += 1;
      if (agentId === "coordinator_1" && requestedStage === "building") {
        requestedStage = "ready_for_build";
        blockedBuildPromotion = true;
      }
      const explicitAssignee = update.assigneeAgentId && this.agents.has(update.assigneeAgentId)
        ? update.assigneeAgentId
        : null;
      const requestedAssignee = explicitAssignee ?? this.defaultAssigneeForStage(requestedStage);
      const stage = this.normalizeStageForAssignee(requestedAssignee, requestedStage, id);
      this.subgoals.push({
        id,
        title: update.title || `Subgoal ${id}`,
        summary: update.summary || "No summary provided.",
        stage,
        assigneeAgentId: explicitAssignee && stage === requestedStage ? explicitAssignee : this.defaultAssigneeForStage(stage),
        updatedAt: timestamp,
        updatedBy: agentId,
        revision: this.subgoalRevision,
        conflictCount: 0,
        activeConflict: false,
        lastConflictAt: null,
        lastConflictSummary: null,
      });
      changedIds.add(id);
    }

    this.subgoals = [...this.subgoals].sort((left, right) => {
      if (left.stage === right.stage) {
        return left.id.localeCompare(right.id);
      }
      return left.revision - right.revision;
    });
    this.updatedAt = nowIso();
    this.persistSession();
    return {
      changedIds: [...changedIds],
      blockedBuildPromotion,
      conflicts,
    };
  }

  private actionableSubgoalsForAgent(agent: RuntimeAgent): SessionSubgoal[] {
    const ownedStages = Array.isArray(agent.preset.policy?.ownedStages) ? agent.preset.policy.ownedStages : [];
    if (ownedStages.length === 0) {
      return [];
    }
    return this.subgoals.filter((subgoal) => {
      if (!ownedStages.includes(subgoal.stage)) {
        return false;
      }
      if (subgoal.assigneeAgentId && subgoal.assigneeAgentId !== agent.preset.id) {
        return false;
      }
      return true;
    });
  }

  private goalBoardNeedsAttention(agent: RuntimeAgent): boolean {
    if (this.actionableSubgoalsForAgent(agent).length === 0) {
      return false;
    }
    return Number(agent.snapshot.lastSeenSubgoalRevision || 0) < this.subgoalRevision;
  }

  private buildGoalBoardSummary(agent: RuntimeAgent): string {
    if (this.subgoals.length === 0) {
      return "(no subgoals yet)";
    }
    const lines = this.subgoals.map((subgoal) => {
      const assignee = subgoal.assigneeAgentId ? ` assignee=${subgoal.assigneeAgentId}` : "";
      const revision = ` rev=${subgoal.revision}`;
      const focus = this.actionableSubgoalsForAgent(agent).some((item) => item.id === subgoal.id) ? " focus=true" : "";
      const conflict = subgoal.activeConflict && subgoal.lastConflictSummary
        ? ` conflict=${shortenText(subgoal.lastConflictSummary, 120)}`
        : "";
      return `- ${subgoal.id}${revision} [${subgoal.stage}]${assignee}${focus}${conflict}: ${shortenText(subgoal.title, 100)} :: ${shortenText(subgoal.summary, 180)}`;
    });
    return lines.join("\n");
  }

  private buildActionableSubgoalSummary(agent: RuntimeAgent): string {
    const actionable = this.actionableSubgoalsForAgent(agent);
    if (actionable.length === 0) {
      return "(none)";
    }
    return actionable
      .map((subgoal) => {
        const conflict = subgoal.activeConflict && subgoal.lastConflictSummary
          ? ` !! conflict: ${shortenText(subgoal.lastConflictSummary, 120)}`
          : "";
        return `- ${subgoal.id} rev=${subgoal.revision} [${subgoal.stage}] ${shortenText(subgoal.title, 100)} :: ${shortenText(subgoal.summary, 180)}${conflict}`;
      })
      .join("\n");
  }

  private pingGoalBoardOwners(): void {
    for (const agent of this.agents.values()) {
      if (!this.goalBoardNeedsAttention(agent) || agent.draining || agent.snapshot.status === "starting" || this.status === "stopped") {
        continue;
      }
      this.scheduleAgentDrain(agent.preset.id, true);
    }
  }

  private latestGoalSequence(): number {
    for (let index = this.recentEvents.length - 1; index >= 0; index -= 1) {
      if (this.isGoalEvent(this.recentEvents[index])) {
        return this.recentEvents[index].sequence;
      }
    }
    return 0;
  }

  private eventsSinceGoalForChannels(channels: SessionChannel[]): SessionEvent[] {
    const normalizedChannels = [...new Set(channels.map((channel) => String(channel ?? "").trim()).filter(Boolean))];
    if (normalizedChannels.length === 0) {
      return [];
    }
    const latestGoalSequence = this.latestGoalSequence();
    return this.recentEvents.filter(
      (event) =>
        event.sequence > latestGoalSequence &&
        event.sender !== "system" &&
        normalizedChannels.includes(event.channel),
    );
  }

  private hasChannelActivitySinceGoal(channels: SessionChannel[]): boolean {
    return this.eventsSinceGoalForChannels(channels).length > 0;
  }

  private discoveryChannels(): Set<SessionChannel> {
    return new Set(
      this.config.agents
        .filter((entry) => Array.isArray(entry.policy?.ownedStages) && (entry.policy.ownedStages.includes("open") || entry.policy.ownedStages.includes("researching")))
        .map((entry) => entry.publishChannel),
    );
  }

  private meetsActivationPolicy(agent: RuntimeAgent): boolean {
    return this.goalBoardNeedsAttention(agent);
  }

  private shouldIgnoreCompletedAgent(agent: RuntimeAgent, event: SessionEvent): boolean {
    if (agent.snapshot.completion !== "done") {
      return false;
    }
    const targetIds = extractTargetAgentIds(event.metadata);
    if (targetIds.includes(agent.preset.id)) {
      return false;
    }
    if (this.isGoalEvent(event) || this.isOperatorEvent(event)) {
      return false;
    }
    return !this.goalBoardNeedsAttention(agent);
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

  private currentTurnHasTargetedRequest(agent: RuntimeAgent): boolean {
    const digest = agent.inFlightDigest;
    if (!digest) {
      return false;
    }
    const events = [
      ...(digest.latestGoal ? [digest.latestGoal] : []),
      ...digest.operatorEvents,
      ...digest.directInputs,
      ...Object.values(digest.channelEvents).flat(),
      ...digest.otherEvents,
    ];
    return events.some((event) => extractTargetAgentIds(event.metadata).includes(agent.preset.id));
  }

  private hasOperatorOverride(agent: RuntimeAgent): boolean {
    return (
      agent.pendingDigest.operatorEvents.length > 0 ||
      agent.pendingDigest.directInputs.length > 0 ||
      Boolean(agent.inFlightDigest && (agent.inFlightDigest.operatorEvents.length > 0 || agent.inFlightDigest.directInputs.length > 0))
    );
  }

  private applyPeerContextTargetDeferral(agent: RuntimeAgent, targetAgentIds: string[]): string[] {
    return targetAgentIds;
  }

  private shouldForceBroadcastOnFirstTurn(agent: RuntimeAgent): boolean {
    if (!agent.preset.policy.forceBroadcastOnFirstTurn) {
      return false;
    }
    if (this.hasOperatorOverride(agent)) {
      return false;
    }
    return agent.snapshot.turnCount === 0;
  }

  private shouldDeferAgent(agent: RuntimeAgent): boolean {
    if (this.hasOperatorOverride(agent) || this.currentTurnHasTargetedRequest(agent)) {
      return false;
    }
    if (hasPendingDigest(agent.pendingDigest)) {
      return false;
    }
    return !this.meetsActivationPolicy(agent);
  }

  private transcriptEventLimit(agent: RuntimeAgent): number {
    const configured = Math.max(1, Number(this.config.defaults.historyTail || 0) || 1);
    return Math.min(configured, 6);
  }

  private transcriptCharLimit(agent: RuntimeAgent): number {
    return 170;
  }

  private transcriptChannels(agent: RuntimeAgent): Set<SessionChannel> {
    return new Set<SessionChannel>([this.goalChannel(), this.operatorChannel(), ...agent.preset.listenChannels]);
  }

  private buildTranscript(agent: RuntimeAgent, digest: PendingDigest): string {
    const latestGoalSequence = this.latestGoalSequence();
    const allowedChannels = this.transcriptChannels(agent);
    const skipSequences = digestSequences(digest);
    const events = this.recentEvents
      .filter((event) => {
        const targetIds = extractTargetAgentIds(event.metadata);
        const isTargetedTeamMessage = !this.isOperatorEvent(event) && targetIds.length > 0;
        if (event.sender === agent.preset.name) {
          return false;
        }
        if (event.channel === "status" || event.channel === "system") {
          return false;
        }
        if (!isTargetedTeamMessage && !allowedChannels.has(event.channel)) {
          return false;
        }
        if (this.isOperatorEvent(event) && targetIds.length > 0 && !targetIds.includes(agent.preset.id)) {
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
