// @ts-nocheck
import { existsSync, readFileSync } from "node:fs";
import {
  AgentPreset,
  AgentSnapshot,
  AgentTurnResult,
  AppConfig,
  DirectedTeamMessage,
  SessionChannel,
  SessionEvent,
  SessionSubgoal,
  SessionSnapshot,
  SessionStatus,
  SubgoalStage,
  SubgoalDecisionState,
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
  retryCount: number;
  interruptReason: "stop" | "restart" | null;
  draining: boolean;
  drainTimer: ReturnType<typeof setTimeout> | null;
}

interface SubgoalUpdateResult {
  changedIds: string[];
  blockedBuildPromotion: boolean;
  conflicts: StaleSubgoalConflict[];
}

interface StaleSubgoalConflict {
  reason: "stale_update" | "obsolete_turn" | "done_soft_note" | "done_reopen_suggestion";
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
const SUBGOAL_DECISION_STATE_SET = new Set<SubgoalDecisionState>(["open", "disputed", "resolved"]);

const RECENT_EVENT_LIMIT = 40;
const SNAPSHOT_STREAM_TAIL = 2400;
const DRAIN_DEBOUNCE_MS = 350;
const SUBGOAL_FACT_LIMIT = 6;
const SUBGOAL_QUESTION_LIMIT = 4;
const SUBGOAL_DECISION_LIMIT = 4;
const SUBGOAL_ACCEPTANCE_LIMIT = 4;
const SUBGOAL_FILE_LIMIT = 6;
const TRANSIENT_TURN_RETRY_LIMIT = 3;

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

function defaultDecisionStateForStage(stage: SubgoalStage): SubgoalDecisionState {
  switch (stage) {
    case "ready_for_build":
    case "building":
    case "ready_for_review":
    case "done":
      return "resolved";
    case "blocked":
      return "disputed";
    default:
      return "open";
  }
}

function normalizeDecisionState(state: unknown, fallback: SubgoalDecisionState): SubgoalDecisionState {
  return SUBGOAL_DECISION_STATE_SET.has(state as SubgoalDecisionState) ? (state as SubgoalDecisionState) : fallback;
}

function normalizeMemoryList(values: unknown, limit: number, itemLimit = 180): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const items = values
    .map((value) => shortenText(String(value ?? "").trim(), itemLimit))
    .filter(Boolean);
  return [...new Set(items)].slice(0, limit);
}

function mergeMemoryList(existing: string[], additions: unknown, limit: number, itemLimit = 180): string[] {
  const merged = [
    ...(Array.isArray(existing) ? existing.map((value) => shortenText(String(value ?? "").trim(), itemLimit)).filter(Boolean) : []),
    ...normalizeMemoryList(additions, limit, itemLimit),
  ];
  return [...new Set(merged)].slice(-limit);
}

function normalizeNextAction(value: unknown): string | null {
  const normalized = shortenText(String(value ?? "").trim(), 200);
  return normalized || null;
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

function normalizeDirectedMessageTargets(message: DirectedTeamMessage | null | undefined): string[] {
  const multi = Array.isArray(message?.targetAgentIds)
    ? message.targetAgentIds.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  if (multi.length > 0) {
    return [...new Set(multi)];
  }
  const single = typeof message?.targetAgentId === "string" ? message.targetAgentId.trim() : "";
  return single ? [single] : [];
}

function summarizeDirectedMessages(messages: DirectedTeamMessage[] | null | undefined, maxChars = 220): string {
  const items = (Array.isArray(messages) ? messages : [])
    .map((message) => {
      const content = compactWhitespace(message?.content || "");
      if (!content) {
        return "";
      }
      const targetIds = normalizeDirectedMessageTargets(message);
      const targetText = targetIds.length > 0 ? ` target=${targetIds.join(",")}` : "";
      return `${targetText}: ${shortenText(content, maxChars)}`.trim();
    })
    .filter(Boolean);
  return items.join(" | ");
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

function digestEvents(digest: PendingDigest | null): SessionEvent[] {
  if (!digest) {
    return [];
  }
  const events = [
    ...(digest.latestGoal ? [digest.latestGoal] : []),
    ...digest.operatorEvents,
    ...digest.directInputs,
    ...Object.values(digest.channelEvents).flat(),
    ...digest.otherEvents,
  ];
  return [...events].sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
}

function combinePendingDigests(...digests: Array<PendingDigest | null | undefined>): PendingDigest {
  const combined = emptyPendingDigest();
  const seen = new Set<number>();
  const events = digests.flatMap((digest) => digestEvents(digest));
  for (const event of events) {
    const sequence = Number(event.sequence || 0);
    if (sequence > 0 && seen.has(sequence)) {
      continue;
    }
    if (sequence > 0) {
      seen.add(sequence);
    }
    const next = mergePendingDigest(combined, event);
    combined.totalCount = next.totalCount;
    combined.latestGoal = next.latestGoal;
    combined.operatorEvents = next.operatorEvents;
    combined.directInputs = next.directInputs;
    combined.channelEvents = next.channelEvents;
    combined.otherEvents = next.otherEvents;
  }
  return combined;
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

function normalizeExpectedRevision(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : null;
}

function normalizeTopicKey(value: unknown): string | null {
  const normalized = compactWhitespace(String(value ?? ""))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!normalized) {
    return null;
  }
  const parts = normalized.split("-").filter(Boolean).slice(0, 6);
  return parts.length > 0 ? parts.join("-") : null;
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
            topicKey:
              normalizeTopicKey(subgoal?.topicKey)
              || normalizeTopicKey(`${subgoal?.title ?? ""} ${subgoal?.summary ?? ""}`)
              || String(subgoal?.id ?? "topic"),
            summary: String(subgoal?.summary ?? "").trim(),
            facts: normalizeMemoryList(subgoal?.facts, SUBGOAL_FACT_LIMIT),
            openQuestions: normalizeMemoryList(subgoal?.openQuestions, SUBGOAL_QUESTION_LIMIT),
            resolvedDecisions: normalizeMemoryList(subgoal?.resolvedDecisions, SUBGOAL_DECISION_LIMIT),
            acceptanceCriteria: normalizeMemoryList(subgoal?.acceptanceCriteria, SUBGOAL_ACCEPTANCE_LIMIT),
            relevantFiles: normalizeMemoryList(subgoal?.relevantFiles, SUBGOAL_FILE_LIMIT, 120),
            nextAction: normalizeNextAction(subgoal?.nextAction),
            stage: normalizeSubgoalStage(subgoal?.stage, "researching"),
            decisionState: normalizeDecisionState(subgoal?.decisionState, defaultDecisionStateForStage(normalizeSubgoalStage(subgoal?.stage, "researching"))),
            lastReopenReason: subgoal?.lastReopenReason ? String(subgoal.lastReopenReason) : null,
            assigneeAgentId: String(subgoal?.assigneeAgentId ?? "").trim() || null,
            mergedIntoSubgoalId: String(subgoal?.mergedIntoSubgoalId ?? "").trim() || null,
            archivedAt: subgoal?.archivedAt ? String(subgoal.archivedAt) : null,
            archivedBy: subgoal?.archivedBy ? String(subgoal.archivedBy) : null,
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
            teamMessages: Array.isArray((restored as Partial<AgentSnapshot>).teamMessages)
              ? (restored as Partial<AgentSnapshot>).teamMessages
              : compactWhitespace((restored as Partial<AgentSnapshot> & { teamMessage?: string }).teamMessage || "")
                ? [{ content: compactWhitespace((restored as Partial<AgentSnapshot> & { teamMessage?: string }).teamMessage || "") }]
                : [],
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
            teamMessages: [],
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
        retryCount: 0,
        interruptReason: null,
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

  snapshot(isLive = this.status !== "stopped"): SessionSnapshot {
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
      isLive,
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
      agent.interruptReason = "stop";
      await agent.process.stop();
      this.updateAgentSnapshot(agent.preset.id, { status: "stopped", waitingForInput: false, lastError: "" });
    }
    this.status = "stopped";
    this.publish("system", "status", "Session stopped by operator.");
  }

  async stopAgent(agentId: string): Promise<void> {
    await this.interruptAgent(agentId, "stop");
  }

  async restartAgent(agentId: string): Promise<void> {
    await this.interruptAgent(agentId, "restart");
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
    if (this.requiresGoalBoardOwnership(agent) && !this.isOperatorEvent(event) && !this.goalBoardNeedsAttention(agent)) {
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

  private clearDeferredPending(agent: RuntimeAgent): void {
    if (!this.requiresGoalBoardOwnership(agent)) {
      return;
    }
    if (this.hasOperatorOverride(agent)) {
      return;
    }
    if (this.goalBoardNeedsAttention(agent)) {
      return;
    }
    if (!hasPendingDigest(agent.pendingDigest)) {
      return;
    }
    agent.pendingDigest = emptyPendingDigest();
    agent.snapshot.pendingSignals = 0;
    this.persistAgent(agent.preset.id);
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
    if (!agent || this.status === "stopped" || agent.snapshot.status === "stopped") {
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

  private shouldRetryTransientTurnFailure(message: string): boolean {
    const normalized = compactWhitespace(message).toLowerCase();
    if (!normalized) {
      return false;
    }
    return (
      normalized.includes("max_output_tokens") ||
      normalized.includes("stream disconnected before completion") ||
      normalized.includes("incomplete response returned") ||
      normalized.includes("an error occurred while processing your request")
    );
  }

  private restoreFailedInFlightDigest(agent: RuntimeAgent, digest: PendingDigest | null): void {
    agent.pendingDigest = combinePendingDigests(digest, agent.pendingDigest);
    agent.snapshot.pendingSignals = agent.pendingDigest.totalCount;
    this.persistAgent(agent.preset.id);
  }

  private async drainAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent || agent.draining || agent.snapshot.status === "error" || agent.snapshot.status === "starting" || agent.snapshot.status === "stopped") {
      return;
    }
    if (!hasPendingDigest(agent.pendingDigest) && !this.goalBoardNeedsAttention(agent)) {
      return;
    }
    if (agent.preset.maxTurns > 0 && agent.snapshot.turnCount >= agent.preset.maxTurns) {
      return;
    }
    if (this.shouldDeferAgent(agent)) {
      this.clearDeferredPending(agent);
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
      "Goal board overview:",
      this.buildGoalBoardSummary(agent),
      "",
      "Relevant subgoal memory for you:",
      this.buildRelevantSubgoalSummary(agent),
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
      if (message.includes("Codex run stopped") && agent.interruptReason) {
        return;
      }
      if ((this.status === "stopping" || this.status === "stopped") && message.includes("Codex run stopped")) {
        return;
      }
      if (this.shouldRetryTransientTurnFailure(message) && agent.retryCount < TRANSIENT_TURN_RETRY_LIMIT) {
        agent.retryCount += 1;
        this.restoreFailedInFlightDigest(agent, digest);
        agent.snapshot.status = "idle";
        agent.snapshot.waitingForInput = false;
        agent.snapshot.lastError = "";
        agent.snapshot.lastResponseAt = nowIso();
        agent.snapshot.workingNotes = [
          `Transient Codex turn failure, retrying ${agent.retryCount}/${TRANSIENT_TURN_RETRY_LIMIT}: ${shortenText(message, 240)}`,
        ];
        agent.snapshot.teamMessages = [];
        this.appendAgentHistory(agent, "notes", agent.snapshot.workingNotes[0], `Retry ${agent.retryCount}`);
        this.persistAgent(agentId);
        this.emit({ type: "agent", sessionId: this.id, agent: { ...agent.snapshot } });
        return;
      }
      agent.retryCount = 0;
      this.applyTurnResult(agentId, {
        shouldReply: false,
        workingNotes: [`Codex turn failed: ${(error as Error).message}`],
        teamMessages: [],
        completion: "blocked",
        rawText: "",
      }, maxDigestSequence(digest), agent.inFlightSubgoalRefs);
    } finally {
      agent.draining = false;
      agent.inFlightDigest = null;
      agent.inFlightSubgoalRefs = null;
      agent.interruptReason = null;
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
    agent.retryCount = 0;
    let normalizedResult = this.shouldSuppressPolicyWriteProbeBlocker(agent, result)
      ? this.sanitizePolicyWriteProbeBlocker(result)
      : result;
    if (this.shouldSuppressBroadDataLoadTurn(agent, normalizedResult)) {
      normalizedResult = this.sanitizeBroadDataLoadTurn(normalizedResult);
    }
    const obsoleteConflicts = this.buildObsoleteTurnConflicts(agentId, inFlightSubgoalRefs);
    const hasRequestedStateMutation = Array.isArray(normalizedResult.subgoalUpdates) && normalizedResult.subgoalUpdates.length > 0;
    const hasMeaningfulTurnOutput =
      hasRequestedStateMutation ||
      ((Array.isArray(normalizedResult.teamMessages) ? normalizedResult.teamMessages : []).length > 0) ||
      normalizedResult.completion === "done" ||
      normalizedResult.completion === "blocked";
    const shouldSuppressObsoleteTurn = obsoleteConflicts.length > 0 && hasMeaningfulTurnOutput;
    const requestedStages = new Set(
      (Array.isArray(normalizedResult.subgoalUpdates) ? normalizedResult.subgoalUpdates : [])
        .map((update) => String(update?.stage ?? "").trim())
        .filter(Boolean),
    );
    agent.snapshot.turnCount += 1;
    agent.snapshot.lastConsumedSequence = Math.max(Number(agent.snapshot.lastConsumedSequence || 0), consumedSequence);
    const subgoalResult = shouldSuppressObsoleteTurn
      ? { changedIds: this.recordSubgoalConflicts(obsoleteConflicts), blockedBuildPromotion: false, conflicts: [] as StaleSubgoalConflict[] }
      : this.applySubgoalUpdates(agentId, normalizedResult.subgoalUpdates);
    const changedSubgoalIds = [...new Set([...subgoalResult.changedIds, ...obsoleteConflicts.map((conflict) => conflict.subgoalId)])];
    const conflictOnlyIds = new Set([
      ...subgoalResult.conflicts.map((conflict) => conflict.subgoalId),
      ...obsoleteConflicts.map((conflict) => conflict.subgoalId),
    ]);
    const actualStateChangeIds = subgoalResult.changedIds.filter((id) => !conflictOnlyIds.has(id));
    const referencedSubgoalIds = this.referencedSubgoalIds(changedSubgoalIds, normalizedResult.subgoalUpdates, inFlightSubgoalRefs);
    if (!shouldSuppressObsoleteTurn) {
      agent.snapshot.lastSeenSubgoalRevision = this.subgoalRevision;
    }
    const rawTeamMessages = Array.isArray(normalizedResult.teamMessages)
      ? normalizedResult.teamMessages
          .filter((message) => message && typeof message === "object")
          .map((message) => ({
            content: compactWhitespace(message.content || ""),
            targetAgentId: String(message.targetAgentId ?? "").trim() || null,
            targetAgentIds: normalizeDirectedMessageTargets(message),
          }))
          .filter((message) => message.content)
      : [];
    const allowedTargetSet = new Set(
      (Array.isArray(agent.preset.policy.allowedTargetAgentIds) ? agent.preset.policy.allowedTargetAgentIds : [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    );
    const allowedTargets = new Set(
      (Array.isArray(agent.preset.policy.allowedTargetAgentIds) ? agent.preset.policy.allowedTargetAgentIds : [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    );
    const reviewerId = this.defaultAssigneeForStage("ready_for_review");
    const builderId = this.defaultAssigneeForStage("building");
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
    const materializeTeamMessage = (message: DirectedTeamMessage): DirectedTeamMessage => {
      const normalizedTargetAgentIds = [...new Set(
        normalizeDirectedMessageTargets(message)
          .map((value) => String(value ?? "").trim())
          .filter((value) => value && value !== agentId && this.agents.has(value)),
      )];
      const restrictedTargetAgentIds = allowedTargetSet.size > 0
        ? normalizedTargetAgentIds.filter((value) => allowedTargetSet.has(value))
        : normalizedTargetAgentIds;
      const peerDeferredTargetAgentIds = this.applyPeerContextTargetDeferral(agent, restrictedTargetAgentIds);
      let effectiveTargetAgentIds = this.shouldForceBroadcastOnFirstTurn(agent) ? [] : peerDeferredTargetAgentIds;
      if (isAuditHandoff && reviewerId && allowedTargets.has(reviewerId)) {
        if (effectiveTargetAgentIds.length === 0 || effectiveTargetAgentIds.every((value) => routingOwnerIds.includes(value))) {
          effectiveTargetAgentIds = [reviewerId];
        } else if (!effectiveTargetAgentIds.includes(reviewerId)) {
          effectiveTargetAgentIds = [reviewerId, ...effectiveTargetAgentIds];
        }
      }
      if (subgoalResult.blockedBuildPromotion) {
        effectiveTargetAgentIds = builderId ? effectiveTargetAgentIds.filter((value) => value !== builderId) : effectiveTargetAgentIds;
      }
      effectiveTargetAgentIds = effectiveTargetAgentIds.filter((value) => {
        const target = this.agents.get(value);
        if (!target) {
          return false;
        }
        if (!this.requiresGoalBoardOwnership(target)) {
          return true;
        }
        return this.goalBoardNeedsAttention(target);
      });
      return {
        content: message.content,
        ...(effectiveTargetAgentIds.length === 1 ? { targetAgentId: effectiveTargetAgentIds[0] } : {}),
        ...(effectiveTargetAgentIds.length > 0 ? { targetAgentIds: effectiveTargetAgentIds } : { targetAgentIds: [] }),
      };
    };
    let effectiveTeamMessages = normalizedResult.shouldReply && !shouldSuppressObsoleteTurn
      ? rawTeamMessages.map((message) => materializeTeamMessage(message))
      : [];
    if (
      this.isDiscoveryOwner(agentId) &&
      !this.hasOperatorOverride(agent) &&
      !this.currentTurnHasTargetedRequest(agent) &&
      this.actionableSubgoalsForAgent(agent).length === 0 &&
      (!Array.isArray(normalizedResult.subgoalUpdates) || normalizedResult.subgoalUpdates.length === 0)
    ) {
      normalizedResult.shouldReply = false;
      effectiveTeamMessages = [];
      normalizedResult.workingNotes = [];
    }
    effectiveTeamMessages = effectiveTeamMessages.filter((message) =>
      !this.shouldSuppressDuplicateCoordinationTurn(agent, referencedSubgoalIds, normalizeDirectedMessageTargets(message)) &&
      !this.shouldSuppressRepeatedResearchNote(agent, referencedSubgoalIds, normalizeDirectedMessageTargets(message), actualStateChangeIds.length > 0)
    );
    if (normalizedResult.shouldReply && effectiveTeamMessages.length === 0) {
      normalizedResult.shouldReply = false;
    }
    if (ownsReviewStageOnly && requestedStages.has("done") && effectiveTeamMessages.every((message) => normalizeDirectedMessageTargets(message).length === 0)) {
      normalizedResult.shouldReply = false;
      effectiveTeamMessages = [];
    }

    const baseEventMetadata = {
      agentId,
      turnCount: agent.snapshot.turnCount,
      shouldReply: normalizedResult.shouldReply,
      completion: normalizedResult.completion,
      ...(referencedSubgoalIds.length > 0 ? { subgoalIds: referencedSubgoalIds } : {}),
    };
    agent.snapshot.completion = shouldSuppressObsoleteTurn && normalizedResult.completion !== "blocked" ? "continue" : normalizedResult.completion;
    agent.snapshot.workingNotes = normalizedResult.workingNotes;
    agent.snapshot.teamMessages = effectiveTeamMessages;
    agent.snapshot.lastResponseAt = nowIso();
    agent.snapshot.status = shouldSuppressObsoleteTurn ? "idle" : (normalizedResult.completion === "blocked" ? "error" : "idle");

    if (normalizedResult.workingNotes.length > 0) {
      this.appendAgentHistory(agent, "notes", normalizedResult.workingNotes.join("\n"), `Turn ${agent.snapshot.turnCount}`);
    }
    effectiveTeamMessages.forEach((message, index) => {
      const targetIds = normalizeDirectedMessageTargets(message);
      const prefix = targetIds.length > 0 ? `[target ${targetIds.join(", ")}] ` : "";
      this.appendAgentHistory(agent, "messages", `${prefix}${message.content}`, `Turn ${agent.snapshot.turnCount}${effectiveTeamMessages.length > 1 ? ` #${index + 1}` : ""}`);
    });

    this.persistAgent(agentId);
    this.emit({ type: "agent", sessionId: this.id, agent: { ...agent.snapshot } });

    const statusSignature = this.statusEventSignature(agent, actualStateChangeIds, normalizedResult.completion, subgoalResult.blockedBuildPromotion);
    const shouldPublishStatus =
      normalizedResult.workingNotes.length > 0 &&
      !shouldSuppressObsoleteTurn &&
      (
        normalizedResult.completion !== "continue" ||
        actualStateChangeIds.length > 0 ||
        subgoalResult.blockedBuildPromotion
      ) &&
      !this.shouldSuppressDuplicateStatusEvent(agent, statusSignature);
    if (shouldPublishStatus) {
      this.publish(agent.preset.name, "status", normalizedResult.workingNotes.join(" | "), {
        ...baseEventMetadata,
        ...(statusSignature ? { statusSignature } : {}),
      });
    }
    if (normalizedResult.shouldReply && effectiveTeamMessages.length > 0 && !shouldSuppressObsoleteTurn) {
      this.status = "running";
      for (const message of effectiveTeamMessages) {
        const targetIds = normalizeDirectedMessageTargets(message);
        const researchNoteSignature = this.researchNoteSignature(agent, referencedSubgoalIds, targetIds);
        const eventMetadata = {
          ...baseEventMetadata,
          ...(targetIds.length === 1 ? { targetAgentId: targetIds[0] } : {}),
          ...(targetIds.length > 0 ? { targetAgentIds: targetIds } : {}),
          ...(researchNoteSignature ? { researchNoteSignature } : {}),
          ...(this.canCanonicalizeSubgoal(agentId) && referencedSubgoalIds.length > 0 && targetIds.length > 0
            ? { routingSignature: this.coordinationRoutingSignature(referencedSubgoalIds, targetIds) }
            : {}),
        };
        this.publish(agent.preset.name, agent.preset.publishChannel, message.content, eventMetadata);
      }
    }
    const allConflicts = [...subgoalResult.conflicts, ...obsoleteConflicts];
    if (allConflicts.length > 0) {
      const coordinatorId = this.defaultAssigneeForStage("ready_for_build");
      const groupedConflicts = new Map<string, {
        conflicts: StaleSubgoalConflict[];
        targets: string[];
      }>();
      for (const conflict of allConflicts) {
        const key = conflict.subgoalId;
        const current = groupedConflicts.get(key) || { conflicts: [], targets: [] };
        current.conflicts.push(conflict);
        current.targets = [...new Set([
          ...current.targets,
          ...[coordinatorId, conflict.currentAssigneeAgentId]
            .map((value) => String(value ?? "").trim())
            .filter((value) => value && value !== agentId && this.agents.has(value)),
        ])];
        groupedConflicts.set(key, current);
      }
      for (const [subgoalId, grouped] of groupedConflicts.entries()) {
        const latestConflict = grouped.conflicts[grouped.conflicts.length - 1];
        const conflictSummary = grouped.conflicts
          .map((conflict) => conflict.message)
          .filter(Boolean)
          .join(" | ");
        const hasObsoleteTurn = grouped.conflicts.some((conflict) => conflict.reason === "obsolete_turn");
        const onlyDoneSoftNotes = grouped.conflicts.every((conflict) => conflict.reason === "done_soft_note");
        const hasDoneReopenSuggestion = grouped.conflicts.some((conflict) => conflict.reason === "done_reopen_suggestion");
        const conflictBurstSignature = this.conflictBurstSignature(grouped.conflicts, grouped.targets);
        if (this.shouldSuppressConflictBurst(subgoalId, conflictBurstSignature)) {
          continue;
        }
        this.status = "running";
        this.publish(
          "system",
          this.operatorChannel(),
          onlyDoneSoftNotes
            ? `Stale note on ${subgoalId}: ${shortenText(conflictSummary, 320)}`
            : hasDoneReopenSuggestion
              ? `Reopen suggestion on ${subgoalId}: ${shortenText(conflictSummary, 320)} Re-check whether the completed card should reopen.`
              : shouldSuppressObsoleteTurn && hasObsoleteTurn && summarizeDirectedMessages(rawTeamMessages)
                ? `Conflict on ${subgoalId}: ${shortenText(conflictSummary, 320)} Suppressed stale handoff: ${shortenText(summarizeDirectedMessages(rawTeamMessages), 220)} Re-read the latest goal board before changing this subgoal again.`
                : `Conflict on ${subgoalId}: ${shortenText(conflictSummary, 320)} Re-read the latest goal board before changing this subgoal again.`,
          {
            operatorEvent: true,
            conflictEvent: !onlyDoneSoftNotes && !hasDoneReopenSuggestion,
            staleNoteEvent: onlyDoneSoftNotes,
            reopenSuggestionEvent: hasDoneReopenSuggestion,
            obsoleteEvent: hasObsoleteTurn,
            subgoalIds: [subgoalId],
            staleUpdateBy: latestConflict.agentId,
            expectedRevision: latestConflict.expectedRevision,
            currentRevision: latestConflict.currentRevision,
            requestedStage: latestConflict.requestedStage,
            currentStage: latestConflict.currentStage,
            ...(conflictBurstSignature ? { conflictBurstSignature } : {}),
            ...(grouped.targets.length === 1 ? { targetAgentId: grouped.targets[0] } : {}),
            ...(grouped.targets.length > 0 ? { targetAgentIds: grouped.targets } : {}),
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
    writeSessionSnapshot(this.files, this.snapshot(false));
  }

  private async interruptAgent(agentId: string, mode: "stop" | "restart"): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    const hadInFlightTurn = agent.draining || Boolean(agent.inFlightDigest);
    if (agent.drainTimer) {
      clearTimeout(agent.drainTimer);
      agent.drainTimer = null;
    }
    if (agent.inFlightDigest) {
      this.restoreFailedInFlightDigest(agent, agent.inFlightDigest);
    }
    agent.retryCount = 0;
    agent.interruptReason = mode;
    await agent.process.stop();
    this.updateAgentSnapshot(agentId, {
      status: mode === "restart" ? "starting" : "stopped",
      waitingForInput: false,
      lastError: "",
      ...(mode === "restart" ? { completion: "continue" } : {}),
    });
    if (!hadInFlightTurn) {
      agent.interruptReason = null;
    }
    if (mode !== "restart") {
      return;
    }
    this.status = "running";
    try {
      await agent.process.start(this.goal);
    } catch (error) {
      agent.interruptReason = null;
      this.updateAgentSnapshot(agentId, {
        status: "error",
        waitingForInput: false,
        lastError: String((error as Error).message || error),
      });
      throw error;
    }
    this.updateAgentSnapshot(agentId, { status: "idle", waitingForInput: false, lastError: "" });
    if (hasPendingDigest(agent.pendingDigest) || this.goalBoardNeedsAttention(agent)) {
      this.scheduleAgentDrain(agentId, true);
    }
  }

  private resetGoalBoard(goal: string, actor: string): void {
    this.subgoalRevision = Math.max(0, this.subgoalRevision) + 1;
    const timestamp = nowIso();
    this.subgoals = [];
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

  private coordinationOwnerIds(): string[] {
    return [...new Set(
      this.config.agents
        .filter((agent) =>
          Array.isArray(agent.policy?.ownedStages) &&
          (agent.policy.ownedStages.includes("ready_for_build") || agent.policy.ownedStages.includes("blocked")),
        )
        .map((agent) => String(agent.id ?? "").trim())
        .filter(Boolean),
    )];
  }

  private agentOwnsStage(agentId: string, stage: SubgoalStage): boolean {
    const runtime = this.agents.get(agentId);
    return Boolean(runtime && Array.isArray(runtime.preset.policy?.ownedStages) && runtime.preset.policy.ownedStages.includes(stage));
  }

  private canCreateSubgoal(agentId: string): boolean {
    const runtime = this.agents.get(agentId);
    const ownedStages = Array.isArray(runtime?.preset.policy?.ownedStages) ? runtime.preset.policy.ownedStages : [];
    return ownedStages.some((stage) => stage === "open" || stage === "researching" || stage === "ready_for_build" || stage === "blocked");
  }

  private canonicalSubgoalForId(subgoalId: string | null | undefined): SessionSubgoal | null {
    const normalizedId = String(subgoalId ?? "").trim();
    if (!normalizedId) {
      return null;
    }
    const visited = new Set<string>();
    let current = this.subgoals.find((subgoal) => subgoal.id === normalizedId) ?? null;
    while (current?.mergedIntoSubgoalId && !visited.has(current.id)) {
      visited.add(current.id);
      const next = this.subgoals.find((subgoal) => subgoal.id === current?.mergedIntoSubgoalId) ?? null;
      if (!next) {
        break;
      }
      current = next;
    }
    return current;
  }

  private deriveSubgoalTopicKey(update: SubgoalUpdate, fallbackKey: string): string {
    return (
      normalizeTopicKey(update.topicKey)
      || normalizeTopicKey([
        update.title,
        update.summary,
        ...(Array.isArray(update.addResolvedDecisions) ? update.addResolvedDecisions : []),
        ...(Array.isArray(update.addOpenQuestions) ? update.addOpenQuestions : []),
        ...(Array.isArray(update.addFacts) ? update.addFacts : []),
      ].filter(Boolean).join(" "))
      || fallbackKey
    );
  }

  private requiresGoalBoardOwnership(agent: RuntimeAgent): boolean {
    const ownedStages = Array.isArray(agent.preset.policy?.ownedStages) ? agent.preset.policy.ownedStages : [];
    return ownedStages.length > 0 && ownedStages.every((stage) => stage === "building" || stage === "ready_for_review");
  }

  private canMutateSubgoal(agentId: string, existing: SessionSubgoal): boolean {
    if (this.isArchivedSubgoal(existing)) {
      return false;
    }
    if (this.coordinationOwnerIds().includes(agentId)) {
      return true;
    }
    if (existing.assigneeAgentId) {
      return existing.assigneeAgentId === agentId;
    }
    return this.agentOwnsStage(agentId, existing.stage);
  }

  private hasStateMutation(update: SubgoalUpdate, existing: SessionSubgoal | null): boolean {
    if (!existing) {
      return Boolean(update.title || update.topicKey || update.summary || update.stage || update.decisionState || update.reopenReason || update.assigneeAgentId || update.mergedIntoSubgoalId);
    }
    return Boolean(
      (update.title && update.title !== existing.title) ||
      (update.topicKey && normalizeTopicKey(update.topicKey) !== existing.topicKey) ||
      (update.summary && update.summary !== existing.summary) ||
      (update.stage && update.stage !== existing.stage) ||
      (update.decisionState && update.decisionState !== existing.decisionState) ||
      (update.reopenReason && update.reopenReason !== existing.lastReopenReason) ||
      (update.assigneeAgentId !== undefined && (update.assigneeAgentId || null) !== (existing.assigneeAgentId || null)) ||
      (update.mergedIntoSubgoalId !== undefined && (update.mergedIntoSubgoalId || null) !== (existing.mergedIntoSubgoalId || null))
    );
  }

  private normalizeAssigneeForStage(explicitAssignee: string | null, stage: SubgoalStage, existingAssignee?: string | null): string | null {
    if (explicitAssignee && this.agentOwnsStage(explicitAssignee, stage)) {
      return explicitAssignee;
    }
    if (existingAssignee && this.agentOwnsStage(existingAssignee, stage)) {
      return existingAssignee;
    }
    return this.defaultAssigneeForStage(stage);
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
    const topicKey = normalizeTopicKey(update.topicKey);
    const summary = String(update.summary ?? "").trim() || null;
    const addFacts = normalizeMemoryList(update.addFacts, SUBGOAL_FACT_LIMIT);
    const addOpenQuestions = normalizeMemoryList(update.addOpenQuestions, SUBGOAL_QUESTION_LIMIT);
    const addResolvedDecisions = normalizeMemoryList(update.addResolvedDecisions, SUBGOAL_DECISION_LIMIT);
    const addAcceptanceCriteria = normalizeMemoryList(update.addAcceptanceCriteria, SUBGOAL_ACCEPTANCE_LIMIT);
    const addRelevantFiles = normalizeMemoryList(update.addRelevantFiles, SUBGOAL_FILE_LIMIT, 120);
    const nextAction = update.nextAction !== undefined ? normalizeNextAction(update.nextAction) : undefined;
    const stage = update.stage ? normalizeSubgoalStage(update.stage, "researching") : null;
    const decisionState = update.decisionState ? normalizeDecisionState(update.decisionState, "open") : null;
    const reopenReason = String(update.reopenReason ?? "").trim() || null;
    const assigneeAgentId = String(update.assigneeAgentId ?? "").trim() || null;
    const mergedIntoSubgoalId = update.mergedIntoSubgoalId !== undefined
      ? (String(update.mergedIntoSubgoalId ?? "").trim() || null)
      : undefined;
    if (!id && mergedIntoSubgoalId !== undefined && mergedIntoSubgoalId !== null) {
      return null;
    }
    if (
      !id &&
      !expectedRevision &&
      !title &&
      !summary &&
      addFacts.length === 0 &&
      addOpenQuestions.length === 0 &&
      addResolvedDecisions.length === 0 &&
      addAcceptanceCriteria.length === 0 &&
      addRelevantFiles.length === 0 &&
      nextAction === undefined &&
      !stage &&
      !decisionState &&
      !reopenReason &&
      !assigneeAgentId &&
      mergedIntoSubgoalId === undefined
    ) {
      return null;
    }
    return {
      id,
      expectedRevision,
      title,
      topicKey,
      summary,
      addFacts,
      addOpenQuestions,
      addResolvedDecisions,
      addAcceptanceCriteria,
      addRelevantFiles,
      ...(nextAction !== undefined ? { nextAction } : {}),
      stage,
      decisionState,
      reopenReason,
      assigneeAgentId,
      ...(mergedIntoSubgoalId !== undefined ? { mergedIntoSubgoalId } : {}),
    };
  }

  private isArchivedSubgoal(subgoal: SessionSubgoal | null | undefined): boolean {
    return Boolean(subgoal && (subgoal.mergedIntoSubgoalId || subgoal.archivedAt));
  }

  private activeSubgoals(): SessionSubgoal[] {
    return this.subgoals.filter((subgoal) => !this.isArchivedSubgoal(subgoal));
  }

  private archivedSubgoals(): SessionSubgoal[] {
    return this.subgoals.filter((subgoal) => this.isArchivedSubgoal(subgoal));
  }

  private discoveryOwnerIds(): string[] {
    return [...new Set(
      this.config.agents
        .filter((agent) =>
          Array.isArray(agent.policy?.ownedStages) &&
          (agent.policy.ownedStages.includes("open") || agent.policy.ownedStages.includes("researching")),
        )
        .map((agent) => String(agent.id ?? "").trim())
        .filter(Boolean),
    )];
  }

  private isDiscoveryOwner(agentId: string): boolean {
    return this.discoveryOwnerIds().includes(agentId);
  }

  private isSettledDownstreamSubgoal(subgoal: SessionSubgoal | null | undefined): boolean {
    if (!subgoal) {
      return false;
    }
    return (
      subgoal.decisionState === "resolved" &&
      (subgoal.stage === "ready_for_build" || subgoal.stage === "building" || subgoal.stage === "ready_for_review" || subgoal.stage === "done")
    );
  }

  private isExplicitReopenUpdate(update: SubgoalUpdate): boolean {
    const requestedStage = update.stage ? normalizeSubgoalStage(update.stage, "researching") : null;
    return Boolean(
      (requestedStage && (requestedStage === "researching" || requestedStage === "blocked")) ||
      update.decisionState === "disputed" ||
      compactWhitespace(update.reopenReason || "")
    );
  }

  private subgoalByExactTopicKey(topicKey: string | null | undefined, stages?: SubgoalStage[]): SessionSubgoal | null {
    const normalized = normalizeTopicKey(topicKey);
    if (!normalized) {
      return null;
    }
    return this.activeSubgoals().find((subgoal) => {
      if (subgoal.topicKey !== normalized) {
        return false;
      }
      if (Array.isArray(stages) && stages.length > 0 && !stages.includes(subgoal.stage)) {
        return false;
      }
      return true;
    }) ?? null;
  }

  private referencedSubgoalIds(
    changedSubgoalIds: string[],
    updates: SubgoalUpdate[] | undefined,
    inFlightSubgoalRefs: TrackedSubgoalRef[] | null,
  ): string[] {
    const ids = new Set<string>(changedSubgoalIds);
    for (const update of Array.isArray(updates) ? updates : []) {
      if (update?.id) {
        const canonical = this.canonicalSubgoalForId(update.id);
        if (canonical?.id) {
          ids.add(canonical.id);
        }
      } else if (update?.topicKey) {
        const exact = this.subgoalByExactTopicKey(update.topicKey);
        if (exact?.id) {
          ids.add(exact.id);
        }
      }
    }
    for (const ref of Array.isArray(inFlightSubgoalRefs) ? inFlightSubgoalRefs : []) {
      const canonical = this.canonicalSubgoalForId(ref.id);
      if (canonical?.id) {
        ids.add(canonical.id);
      }
    }
    return [...ids];
  }

  private coordinationRoutingSignature(subgoalIds: string[], targetAgentIds: string[]): string | null {
    const normalizedSubgoalIds = [...new Set(subgoalIds.map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
    const normalizedTargets = [...new Set(targetAgentIds.map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
    if (normalizedSubgoalIds.length === 0 || normalizedTargets.length === 0) {
      return null;
    }
    const subgoalParts = normalizedSubgoalIds.map((id) => {
      const subgoal = this.canonicalSubgoalForId(id);
      if (!subgoal) {
        return `${id}:missing`;
      }
      return [
        subgoal.id,
        subgoal.stage,
        subgoal.decisionState,
        subgoal.assigneeAgentId || "-",
        compactWhitespace(subgoal.nextAction || "") || "-",
      ].join(":");
    });
    return `targets=${normalizedTargets.join(",")}|subgoals=${subgoalParts.join("|")}`;
  }

  private subgoalStateSignature(subgoalIds: string[]): string | null {
    const normalizedSubgoalIds = [...new Set(subgoalIds.map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
    if (normalizedSubgoalIds.length === 0) {
      return null;
    }
    const parts = normalizedSubgoalIds.map((id) => {
      const subgoal = this.canonicalSubgoalForId(id);
      if (!subgoal) {
        return `${id}:missing`;
      }
      return [
        subgoal.id,
        subgoal.stage,
        subgoal.decisionState,
        subgoal.assigneeAgentId || "-",
        compactWhitespace(subgoal.nextAction || "") || "-",
      ].join(":");
    });
    return parts.join("|");
  }

  private statusEventSignature(agent: RuntimeAgent, changedSubgoalIds: string[], completion: AgentTurnResult["completion"], blockedBuildPromotion: boolean): string | null {
    if (completion === "continue" && changedSubgoalIds.length === 0 && !blockedBuildPromotion) {
      return null;
    }
    const stateSignature = this.subgoalStateSignature(changedSubgoalIds) || "-";
    return `${agent.preset.id}|${completion}|blocked_build=${blockedBuildPromotion ? "1" : "0"}|subgoals=${stateSignature}`;
  }

  private shouldSuppressDuplicateStatusEvent(agent: RuntimeAgent, signature: string | null): boolean {
    if (!signature) {
      return false;
    }
    for (let index = this.recentEvents.length - 1; index >= 0; index -= 1) {
      const event = this.recentEvents[index];
      if (event.sender !== agent.preset.name || event.channel !== "status") {
        continue;
      }
      const previousSignature = compactWhitespace(String(event.metadata?.statusSignature ?? ""));
      if (!previousSignature) {
        return false;
      }
      return previousSignature === signature;
    }
    return false;
  }

  private researchNoteSignature(agent: RuntimeAgent, subgoalIds: string[], targetAgentIds: string[]): string | null {
    if (!this.isDiscoveryOwner(agent.preset.id)) {
      return null;
    }
    const stateSignature = this.subgoalStateSignature(subgoalIds);
    if (!stateSignature) {
      return null;
    }
    const normalizedTargets = [...new Set(targetAgentIds.map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
    return `${agent.preset.id}|targets=${normalizedTargets.join(",") || "-"}|subgoals=${stateSignature}`;
  }

  private shouldSuppressRepeatedResearchNote(agent: RuntimeAgent, subgoalIds: string[], targetAgentIds: string[], hasActualStateChange: boolean): boolean {
    if (hasActualStateChange || !this.isDiscoveryOwner(agent.preset.id)) {
      return false;
    }
    const signature = this.researchNoteSignature(agent, subgoalIds, targetAgentIds);
    if (!signature) {
      return false;
    }
    for (let index = this.recentEvents.length - 1; index >= 0; index -= 1) {
      const event = this.recentEvents[index];
      if (event.sender !== agent.preset.name || event.channel !== agent.preset.publishChannel) {
        continue;
      }
      const previousSignature = compactWhitespace(String(event.metadata?.researchNoteSignature ?? ""));
      if (!previousSignature) {
        return false;
      }
      return previousSignature === signature;
    }
    return false;
  }

  private conflictBurstSignature(conflicts: StaleSubgoalConflict[], targetAgentIds: string[]): string | null {
    if (conflicts.length === 0) {
      return null;
    }
    const normalizedTargets = [...new Set(targetAgentIds.map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
    const latest = conflicts[conflicts.length - 1];
    const reasonFamily = [...new Set(conflicts.map((conflict) => {
      if (conflict.reason === "done_soft_note") {
        return "done_soft_note";
      }
      if (conflict.reason === "done_reopen_suggestion") {
        return "done_reopen_suggestion";
      }
      return "active_conflict";
    }))].sort();
    return [
      latest.subgoalId,
      reasonFamily.join(","),
      latest.agentId,
      latest.currentStage,
      latest.currentAssigneeAgentId || "-",
      normalizedTargets.join(",") || "-",
    ].join("|");
  }

  private shouldSuppressConflictBurst(subgoalId: string, signature: string | null): boolean {
    if (!signature) {
      return false;
    }
    for (let index = this.recentEvents.length - 1; index >= 0; index -= 1) {
      const event = this.recentEvents[index];
      if (event.sender !== "system" || event.channel !== this.operatorChannel()) {
        continue;
      }
      const eventSubgoalIds = Array.isArray(event.metadata?.subgoalIds)
        ? event.metadata.subgoalIds.map((value) => String(value ?? "").trim()).filter(Boolean)
        : [];
      if (!eventSubgoalIds.includes(subgoalId)) {
        continue;
      }
      const previousSignature = compactWhitespace(String(event.metadata?.conflictBurstSignature ?? ""));
      if (!previousSignature) {
        return false;
      }
      return previousSignature === signature;
    }
    return false;
  }

  private shouldSuppressDuplicateCoordinationTurn(agent: RuntimeAgent, subgoalIds: string[], targetAgentIds: string[]): boolean {
    if (!this.canCanonicalizeSubgoal(agent.preset.id)) {
      return false;
    }
    const signature = this.coordinationRoutingSignature(subgoalIds, targetAgentIds);
    if (!signature) {
      return false;
    }
    for (let index = this.recentEvents.length - 1; index >= 0; index -= 1) {
      const event = this.recentEvents[index];
      if (event.sender !== agent.preset.name || event.channel !== agent.preset.publishChannel) {
        continue;
      }
      const previousSignature = String(event.metadata?.routingSignature ?? "").trim();
      if (!previousSignature) {
        return false;
      }
      return previousSignature === signature;
    }
    return false;
  }

  private canCanonicalizeSubgoal(agentId: string): boolean {
    return this.coordinationOwnerIds().includes(agentId);
  }

  private deriveSubgoalTitle(update: SubgoalUpdate, fallbackId: string): string {
    const explicitTitle = compactWhitespace(update.title || "");
    if (explicitTitle) {
      return shortenText(explicitTitle, 90);
    }
    const candidates = [
      compactWhitespace(update.summary || ""),
      ...(Array.isArray(update.addResolvedDecisions) ? update.addResolvedDecisions : []).map((item) => compactWhitespace(String(item ?? ""))),
      ...(Array.isArray(update.addOpenQuestions) ? update.addOpenQuestions : []).map((item) => compactWhitespace(String(item ?? ""))),
      ...(Array.isArray(update.addFacts) ? update.addFacts : []).map((item) => compactWhitespace(String(item ?? ""))),
    ].filter(Boolean);
    if (candidates.length > 0) {
      return shortenText(candidates[0], 90);
    }
    return `Untitled topic ${fallbackId}`;
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
    const reason =
      existing.stage === "done"
        ? ((requestedStage === "researching" || requestedStage === "blocked") ? "done_reopen_suggestion" : "done_soft_note")
        : "stale_update";
    return {
      reason,
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

  private inferNextDecisionState(existing: SessionSubgoal | null, update: SubgoalUpdate, requestedStage: SubgoalStage): SubgoalDecisionState {
    if (update.decisionState) {
      return normalizeDecisionState(update.decisionState, existing?.decisionState ?? defaultDecisionStateForStage(requestedStage));
    }
    if (requestedStage === "researching" || requestedStage === "blocked") {
      return "disputed";
    }
    if (!existing) {
      return defaultDecisionStateForStage(requestedStage);
    }
    if (requestedStage !== existing.stage) {
      return defaultDecisionStateForStage(requestedStage);
    }
    return normalizeDecisionState(existing.decisionState, defaultDecisionStateForStage(existing.stage));
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
      const existing = this.canonicalSubgoalForId(trackedRef.id);
      if (!existing) {
        continue;
      }
      if (existing.id !== trackedRef.id) {
        continue;
      }
      const currentRevision = Number(existing.revision || 0);
      if (currentRevision === trackedRef.revision) {
        continue;
      }
      const reason =
        existing.stage === "done"
          ? ((trackedRef.stage === "researching" || trackedRef.stage === "blocked") ? "done_reopen_suggestion" : "done_soft_note")
          : "obsolete_turn";
      conflicts.push({
        reason,
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

  private isPolicyWriteProbeText(text: string | null | undefined): boolean {
    const normalized = String(text ?? "").trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return /read-only|blocked by policy|rejected by policy|write probe|writable runtime|writable executor|workspace-local write|permission check/.test(normalized);
  }

  private shouldSuppressPolicyWriteProbeBlocker(agent: RuntimeAgent, result: AgentTurnResult): boolean {
    const ownsBuildStage =
      Array.isArray(agent.preset.policy?.ownedStages) &&
      agent.preset.policy.ownedStages.includes("building");
    if (!ownsBuildStage) {
      return false;
    }
    const diagnostics = result.runtimeDiagnostics;
    if (!diagnostics?.sawPolicyWriteBlock || diagnostics.sawFileChange) {
      return false;
    }
    if ((Array.isArray(result.teamMessages) ? result.teamMessages : []).some((message) => this.isPolicyWriteProbeText(message?.content))) {
      return true;
    }
    if ((result.workingNotes || []).some((note) => this.isPolicyWriteProbeText(note))) {
      return true;
    }
    return (result.subgoalUpdates || []).some((update) =>
      String(update?.stage ?? "").trim() === "blocked" ||
      this.isPolicyWriteProbeText(update?.summary) ||
      this.isPolicyWriteProbeText(update?.reopenReason) ||
      this.isPolicyWriteProbeText(update?.nextAction) ||
      (Array.isArray(update?.addFacts) && update.addFacts.some((entry) => this.isPolicyWriteProbeText(entry))) ||
      (Array.isArray(update?.addOpenQuestions) && update.addOpenQuestions.some((entry) => this.isPolicyWriteProbeText(entry))),
    );
  }

  private sanitizePolicyWriteProbeBlocker(result: AgentTurnResult): AgentTurnResult {
    const sanitizedNotes = (result.workingNotes || []).filter((note) => !this.isPolicyWriteProbeText(note));
    const sanitizedUpdates = (result.subgoalUpdates || []).filter((update) => String(update?.stage ?? "").trim() !== "blocked");
    return {
      ...result,
      shouldReply: false,
      workingNotes: [
        ...sanitizedNotes,
        "Ignored a policy-blocked shell write probe as a blocker signal. Keep routing unchanged unless a normal workspace-local edit path actually fails.",
      ],
      teamMessages: [],
      subgoalUpdates: sanitizedUpdates,
      completion: "continue",
    };
  }

  private shouldSuppressBroadDataLoadTurn(agent: RuntimeAgent, result: AgentTurnResult): boolean {
    const ownsDiscoveryStage =
      Array.isArray(agent.preset.policy?.ownedStages) &&
      (agent.preset.policy.ownedStages.includes("open") || agent.preset.policy.ownedStages.includes("researching"));
    const ownsOnlyReviewStage =
      Array.isArray(agent.preset.policy?.ownedStages) &&
      agent.preset.policy.ownedStages.length > 0 &&
      agent.preset.policy.ownedStages.every((stage) => stage === "ready_for_review");
    if (!result.runtimeDiagnostics?.sawBroadDataLoad) {
      return false;
    }
    if (!ownsDiscoveryStage && !ownsOnlyReviewStage) {
      return false;
    }
    if (this.hasOperatorOverride(agent) || this.currentTurnHasTargetedRequest(agent)) {
      return false;
    }
    return !Array.isArray(result.subgoalUpdates) || result.subgoalUpdates.length === 0;
  }

  private sanitizeBroadDataLoadTurn(result: AgentTurnResult): AgentTurnResult {
    return {
      ...result,
      shouldReply: false,
      teamMessages: [],
      workingNotes: [
        ...(Array.isArray(result.workingNotes) ? result.workingNotes : []),
        "Suppressed a turn that relied on a broad dataset or pipeline load without changing the goal board. Reuse existing aggregates or narrow the probe next time.",
      ],
      completion: "continue",
    };
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
      const isDoneSoftNote = conflict.reason === "done_soft_note";
      const isDoneReopenSuggestion = conflict.reason === "done_reopen_suggestion";
      this.subgoals[existingIndex] = {
        ...existing,
        updatedAt: timestamp,
        updatedBy: "system",
        revision: existing.revision,
        conflictCount: Math.max(0, Number(existing.conflictCount || 0)) + 1,
        activeConflict: !(isDoneSoftNote || isDoneReopenSuggestion),
        lastConflictAt: timestamp,
        lastConflictSummary: isDoneReopenSuggestion ? `Reopen suggestion: ${conflict.message}` : conflict.message,
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
      const exactTopicMatch = !update.id && update.topicKey
        ? this.subgoalByExactTopicKey(update.topicKey)
        : null;
      const existingMatch = update.id
        ? this.canonicalSubgoalForId(update.id)
        : exactTopicMatch
          ? this.canonicalSubgoalForId(exactTopicMatch.id)
        : null;
      const redirectedFromMerged = Boolean(update.id && existingMatch && existingMatch.id !== update.id);
      const existingIndex = existingMatch ? this.subgoals.findIndex((subgoal) => subgoal.id === existingMatch.id) : -1;
      const timestamp = nowIso();
      if (existingIndex >= 0) {
        const existing = this.subgoals[existingIndex];
        if (this.isArchivedSubgoal(existing)) {
          continue;
        }
        if (!update.id && existing.stage === "done") {
          continue;
        }
        let canMutateState = !redirectedFromMerged && this.canMutateSubgoal(agentId, existing);
        if (
          !canMutateState &&
          update.id &&
          this.isExplicitReopenUpdate(update) &&
          (this.isDiscoveryOwner(agentId) || this.canCanonicalizeSubgoal(agentId))
        ) {
          canMutateState = true;
        }
        const wantsStateMutation = this.hasStateMutation(update, existing);
        if (
          this.isDiscoveryOwner(agentId) &&
          !update.id &&
          this.isSettledDownstreamSubgoal(existing) &&
          !this.isExplicitReopenUpdate(update)
        ) {
          continue;
        }
        let requestedStage = canMutateState && update.stage ? normalizeSubgoalStage(update.stage, existing.stage) : existing.stage;
        let decisionState = canMutateState ? this.inferNextDecisionState(existing, update, requestedStage) : existing.decisionState;
        let buildGateMessage: string | null = null;
        if (canMutateState && requestedStage === "building" && decisionState !== "resolved") {
          requestedStage = "researching";
          decisionState = "disputed";
          blockedBuildPromotion = true;
          buildGateMessage = `Build promotion blocked for ${existing.id}: unresolved contradictions remain. Mark the subgoal decisionState=resolved before sending it to building.`;
        }
        if (!redirectedFromMerged && this.shouldIgnoreStaleSubgoalUpdate(existing, update) && wantsStateMutation) {
          const conflict = this.buildStaleSubgoalConflict(agentId, existing, update, requestedStage);
          if (conflict) {
            for (const changedId of this.recordSubgoalConflicts([conflict])) {
              changedIds.add(changedId);
            }
            conflicts.push(conflict);
          }
          continue;
        }
        if (!canMutateState && !update.addFacts?.length && !update.addOpenQuestions?.length && !update.addResolvedDecisions?.length && !update.addAcceptanceCriteria?.length && !update.addRelevantFiles?.length) {
          continue;
        }
        const requestedMergeTargetId =
          canMutateState && this.canCanonicalizeSubgoal(agentId) && update.mergedIntoSubgoalId
            ? update.mergedIntoSubgoalId
            : null;
        if (requestedMergeTargetId) {
          const mergeTarget = this.activeSubgoals().find((subgoal) => subgoal.id === requestedMergeTargetId);
          if (!mergeTarget || mergeTarget.id === existing.id) {
            continue;
          }
          if (existing.stage === "building" || existing.stage === "ready_for_review") {
            this.subgoalRevision += 1;
            this.subgoals[existingIndex] = {
              ...existing,
              updatedAt: timestamp,
              updatedBy: agentId,
              revision: this.subgoalRevision,
              activeConflict: true,
              lastConflictAt: timestamp,
              lastConflictSummary: `Merge into ${mergeTarget.id} deferred until the active ${existing.stage} stage finishes.`,
            };
            changedIds.add(existing.id);
            continue;
          }
          this.subgoalRevision += 1;
          this.subgoals[existingIndex] = {
            ...existing,
            mergedIntoSubgoalId: mergeTarget.id,
            archivedAt: timestamp,
            archivedBy: agentId,
            updatedAt: timestamp,
            updatedBy: agentId,
            revision: this.subgoalRevision,
            activeConflict: false,
            lastConflictAt: null,
            lastConflictSummary: null,
          };
          changedIds.add(existing.id);
          continue;
        }
        this.subgoalRevision += 1;
        const explicitAssignee = canMutateState && update.assigneeAgentId != null
          ? (update.assigneeAgentId && this.agents.has(update.assigneeAgentId) ? update.assigneeAgentId : null)
          : null;
        const requestedAssignee = explicitAssignee !== null
          ? explicitAssignee
          : (requestedStage !== existing.stage ? this.defaultAssigneeForStage(requestedStage) : existing.assigneeAgentId);
        const stage = this.normalizeStageForAssignee(requestedAssignee, requestedStage, existing.id);
        const assigneeAgentId = this.normalizeAssigneeForStage(
          explicitAssignee !== null && stage === requestedStage ? explicitAssignee : null,
          stage,
          stage !== existing.stage ? null : existing.assigneeAgentId,
        );
        const reopenReason = !canMutateState
          ? existing.lastReopenReason
          : decisionState === "resolved"
          ? null
          : (update.reopenReason
              || buildGateMessage
              || ((requestedStage === "researching" || requestedStage === "blocked") && (update.summary || existing.summary) ? shortenText(update.summary || existing.summary, 220) : existing.lastReopenReason)
              || null);
        const inferredFact = !canMutateState && update.summary ? [update.summary] : [];
        this.subgoals[existingIndex] = {
          ...existing,
          title: canMutateState ? (update.title || existing.title) : existing.title,
          topicKey: canMutateState ? this.deriveSubgoalTopicKey(update, existing.topicKey) : existing.topicKey,
          summary: canMutateState ? (update.summary || existing.summary) : existing.summary,
          facts: mergeMemoryList(existing.facts, [...inferredFact, ...(update.addFacts || [])], SUBGOAL_FACT_LIMIT),
          openQuestions: mergeMemoryList(existing.openQuestions, update.addOpenQuestions, SUBGOAL_QUESTION_LIMIT),
          resolvedDecisions: mergeMemoryList(existing.resolvedDecisions, update.addResolvedDecisions, SUBGOAL_DECISION_LIMIT),
          acceptanceCriteria: mergeMemoryList(existing.acceptanceCriteria, update.addAcceptanceCriteria, SUBGOAL_ACCEPTANCE_LIMIT),
          relevantFiles: mergeMemoryList(existing.relevantFiles, update.addRelevantFiles, SUBGOAL_FILE_LIMIT, 120),
          nextAction: canMutateState && update.nextAction !== undefined ? normalizeNextAction(update.nextAction) : existing.nextAction,
          stage,
          decisionState,
          lastReopenReason: reopenReason,
          assigneeAgentId,
          mergedIntoSubgoalId: existing.mergedIntoSubgoalId,
          archivedAt: existing.archivedAt,
          archivedBy: existing.archivedBy,
          updatedAt: timestamp,
          updatedBy: agentId,
          revision: this.subgoalRevision,
          conflictCount: Math.max(0, Number(existing.conflictCount || 0)),
          activeConflict: Boolean(buildGateMessage),
          lastConflictAt: buildGateMessage ? timestamp : (decisionState === "resolved" ? null : existing.lastConflictAt ?? null),
          lastConflictSummary: buildGateMessage ? buildGateMessage : (decisionState === "resolved" ? null : existing.lastConflictSummary ?? null),
        };
        changedIds.add(existing.id);
        continue;
      }

      if (!this.canCreateSubgoal(agentId)) {
        continue;
      }

      let requestedStage = normalizeSubgoalStage(update.stage, "researching");
      const id = this.nextSubgoalId();
      this.subgoalRevision += 1;
      let decisionState = this.inferNextDecisionState(null, update, requestedStage);
      let buildGateMessage: string | null = null;
      if (requestedStage === "building" && decisionState !== "resolved") {
        requestedStage = "researching";
        decisionState = "disputed";
        blockedBuildPromotion = true;
        buildGateMessage = `Build promotion blocked for ${id}: unresolved contradictions remain. Mark the subgoal decisionState=resolved before sending it to building.`;
      }
      if (requestedStage === "building" && !this.agentOwnsStage(agentId, "building")) {
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
        title: this.deriveSubgoalTitle(update, id),
        topicKey: this.deriveSubgoalTopicKey(update, `topic-${id}`),
        summary: update.summary || "No summary provided.",
        facts: mergeMemoryList([], update.addFacts, SUBGOAL_FACT_LIMIT),
        openQuestions: mergeMemoryList([], update.addOpenQuestions, SUBGOAL_QUESTION_LIMIT),
        resolvedDecisions: mergeMemoryList([], update.addResolvedDecisions, SUBGOAL_DECISION_LIMIT),
        acceptanceCriteria: mergeMemoryList([], update.addAcceptanceCriteria, SUBGOAL_ACCEPTANCE_LIMIT),
        relevantFiles: mergeMemoryList([], update.addRelevantFiles, SUBGOAL_FILE_LIMIT, 120),
        nextAction: update.nextAction !== undefined ? normalizeNextAction(update.nextAction) : null,
        stage,
        decisionState,
        lastReopenReason: decisionState === "resolved" ? null : (update.reopenReason || buildGateMessage || (update.summary ? shortenText(update.summary, 220) : null)),
        assigneeAgentId: this.normalizeAssigneeForStage(explicitAssignee && stage === requestedStage ? explicitAssignee : null, stage),
        mergedIntoSubgoalId: null,
        archivedAt: null,
        archivedBy: null,
        updatedAt: timestamp,
        updatedBy: agentId,
        revision: this.subgoalRevision,
        conflictCount: 0,
        activeConflict: Boolean(buildGateMessage),
        lastConflictAt: null,
        lastConflictSummary: buildGateMessage,
      });
      changedIds.add(id);
    }
    this.subgoals = [...this.subgoals].sort((left, right) => {
      const leftArchived = this.isArchivedSubgoal(left) ? 1 : 0;
      const rightArchived = this.isArchivedSubgoal(right) ? 1 : 0;
      if (leftArchived !== rightArchived) {
        return leftArchived - rightArchived;
      }
      return Number(left.revision || 0) - Number(right.revision || 0);
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
    return this.activeSubgoals().filter((subgoal) => {
      if (!ownedStages.includes(subgoal.stage)) {
        return false;
      }
      if (subgoal.assigneeAgentId && subgoal.assigneeAgentId !== agent.preset.id) {
        return false;
      }
      return true;
    });
  }

  private relevantSubgoalsForAgent(agent: RuntimeAgent): SessionSubgoal[] {
    const actionable = this.actionableSubgoalsForAgent(agent);
    const ownedStages = Array.isArray(agent.preset.policy?.ownedStages) ? agent.preset.policy.ownedStages : [];
    const ownsDiscoveryStages = ownedStages.includes("open") || ownedStages.includes("researching");
    const ownsRoutingStages = ownedStages.includes("ready_for_build") || ownedStages.includes("blocked");
    const candidates = new Map<string, SessionSubgoal>();
    const push = (subgoal: SessionSubgoal | null | undefined): void => {
      if (!subgoal?.id) {
        return;
      }
      candidates.set(subgoal.id, subgoal);
    };

    for (const subgoal of actionable) {
      push(subgoal);
    }
    if (ownsDiscoveryStages) {
      for (const subgoal of this.activeSubgoals()) {
        if (subgoal.decisionState === "disputed" || subgoal.activeConflict || subgoal.assigneeAgentId === agent.preset.id) {
          push(subgoal);
        }
      }
    } else if (ownsRoutingStages) {
      for (const subgoal of this.activeSubgoals()) {
        if (
          subgoal.activeConflict ||
          subgoal.decisionState === "disputed" ||
          subgoal.stage === "ready_for_build" ||
          subgoal.stage === "blocked" ||
          subgoal.stage === "building" ||
          subgoal.stage === "ready_for_review"
        ) {
          push(subgoal);
        }
      }
    }

    return [...candidates.values()]
      .sort((left, right) => Number(right.revision || 0) - Number(left.revision || 0))
      .slice(0, ownsDiscoveryStages || ownsRoutingStages ? 4 : 2);
  }

  private goalBoardNeedsAttention(agent: RuntimeAgent): boolean {
    if (this.actionableSubgoalsForAgent(agent).length === 0) {
      return false;
    }
    return Number(agent.snapshot.lastSeenSubgoalRevision || 0) < this.subgoalRevision;
  }

  private buildGoalBoardSummary(agent: RuntimeAgent): string {
    const activeSubgoals = this.activeSubgoals();
    if (activeSubgoals.length === 0) {
      return "(no subgoals yet)";
    }
    const lines = activeSubgoals.map((subgoal) => {
      const assignee = subgoal.assigneeAgentId ? ` assignee=${subgoal.assigneeAgentId}` : "";
      const revision = ` rev=${subgoal.revision}`;
      const decision = ` decision=${subgoal.decisionState}`;
      const focus = this.actionableSubgoalsForAgent(agent).some((item) => item.id === subgoal.id) ? " focus=true" : "";
      const conflict = subgoal.activeConflict ? ` conflicts=${Math.max(1, Number(subgoal.conflictCount || 0))}` : "";
      const reopen = subgoal.lastReopenReason ? ` reopen=true` : "";
      return `- ${shortenText(subgoal.title, 90)} (${subgoal.id})${revision} [${subgoal.stage}]${decision}${assignee}${focus}${conflict}${reopen}`;
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
        const reopen = subgoal.lastReopenReason ? ` reopen=${shortenText(subgoal.lastReopenReason, 100)}` : "";
        return `- ${shortenText(subgoal.title, 100)} (${subgoal.id}) rev=${subgoal.revision} [${subgoal.stage}] decision=${subgoal.decisionState} :: ${shortenText(subgoal.summary, 140)}${conflict}${reopen}`;
      })
      .join("\n");
  }

  private buildRelevantSubgoalSummary(agent: RuntimeAgent): string {
    const relevant = this.relevantSubgoalsForAgent(agent);
    if (relevant.length === 0) {
      return "(none)";
    }
    return relevant
      .map((subgoal) => {
        const lines = [
          `- ${shortenText(subgoal.title, 100)} (${subgoal.id}) rev=${subgoal.revision} [${subgoal.stage}] decision=${subgoal.decisionState}${subgoal.assigneeAgentId ? ` assignee=${subgoal.assigneeAgentId}` : ""}`,
          `  summary: ${shortenText(subgoal.summary, 180)}`,
        ];
        if (subgoal.facts.length > 0) {
          lines.push(`  facts: ${subgoal.facts.map((item) => shortenText(item, 120)).join(" | ")}`);
        }
        if (subgoal.openQuestions.length > 0) {
          lines.push(`  open_questions: ${subgoal.openQuestions.map((item) => shortenText(item, 120)).join(" | ")}`);
        }
        if (subgoal.resolvedDecisions.length > 0) {
          lines.push(`  resolved: ${subgoal.resolvedDecisions.map((item) => shortenText(item, 120)).join(" | ")}`);
        }
        if (subgoal.acceptanceCriteria.length > 0) {
          lines.push(`  acceptance: ${subgoal.acceptanceCriteria.map((item) => shortenText(item, 120)).join(" | ")}`);
        }
        if (subgoal.relevantFiles.length > 0) {
          lines.push(`  files: ${subgoal.relevantFiles.join(", ")}`);
        }
        if (subgoal.nextAction) {
          lines.push(`  next_action: ${shortenText(subgoal.nextAction, 140)}`);
        }
        if (subgoal.lastReopenReason) {
          lines.push(`  reopen_reason: ${shortenText(subgoal.lastReopenReason, 140)}`);
        }
        if (subgoal.activeConflict && subgoal.lastConflictSummary) {
          lines.push(`  conflict: ${shortenText(subgoal.lastConflictSummary, 140)}`);
        }
        return lines.join("\n");
      })
      .join("\n\n");
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
    if (this.hasOperatorOverride(agent)) {
      return false;
    }
    if (this.requiresGoalBoardOwnership(agent) && !this.goalBoardNeedsAttention(agent)) {
      return true;
    }
    if (this.currentTurnHasTargetedRequest(agent)) {
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
