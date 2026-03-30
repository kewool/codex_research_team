// @ts-nocheck
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
} from "../../shared/types";
import { CodexAgentProcess } from "../runtime/agent-process";
import {
  AgentFiles,
  SessionFiles,
  appendSessionEvent,
  createAgentFiles,
  createSessionFiles,
} from "../persistence/storage";
import { nowIso, tailText } from "../lib/utils";
import {
  addTokenUsage,
  compactWhitespace,
  DRAIN_DEBOUNCE_MS,
  defaultDecisionStateForStage,
  extractTargetAgentIds,
  normalizeDecisionState,
  normalizeDirectedMessageSubgoalIds,
  normalizeDirectedMessageTargets,
  normalizeExpectedRevision,
  normalizeMemoryList,
  normalizeNextAction,
  normalizeSubgoalStage,
  normalizeTopicKey,
  RECENT_EVENT_LIMIT,
  shortenText,
  SNAPSHOT_STREAM_TAIL,
  SUBGOAL_ACCEPTANCE_LIMIT,
  SUBGOAL_DECISION_LIMIT,
  SUBGOAL_DECISION_STATE_SET,
  SUBGOAL_FACT_LIMIT,
  SUBGOAL_FILE_LIMIT,
  SUBGOAL_QUESTION_LIMIT,
  SUBGOAL_STAGE_SET,
  summarizeDirectedMessages,
  TRANSIENT_TURN_RETRY_LIMIT,
  emptyTokenUsage,
  mergeMemoryList,
} from "./helpers";
import {
  buildTriggerSummary,
  combinePendingDigests,
  digestEvents,
  digestSequences,
  emptyPendingDigest,
  hasPendingDigest,
  maxDigestSequence,
  mergePendingDigest,
  PendingDigest,
  readSessionEvents,
} from "./digest";
import {
  canCanonicalizeSubgoal,
  conflictBurstSignature,
  coordinationRoutingSignature,
  researchNoteSignature,
  shouldSuppressConflictBurst,
  shouldSuppressDuplicateCoordinationTurn,
  shouldSuppressDuplicateStatusEvent,
  shouldSuppressRepeatedResearchNote,
  statusEventSignature,
  subgoalStateSignature,
} from "./signatures";
import {
  applyPeerContextTargetDeferral,
  buildTranscript,
  currentTurnHasTargetedRequest,
  discoveryChannels,
  eventsSinceGoalForChannels,
  hasChannelActivitySinceGoal,
  hasOperatorOverride,
  latestGoalSequence,
  meetsActivationPolicy,
  shouldDeferAgent,
  shouldForceBroadcastOnFirstTurn,
  shouldIgnoreCompletedAgent,
  transcriptChannels,
  transcriptCharLimit,
  transcriptEventLimit,
} from "./routing";
import {
  agentOwnsStage,
  applySubgoalUpdates,
  archivedSubgoals,
  buildObsoleteTurnConflicts,
  buildStaleSubgoalConflict,
  canCreateSubgoal,
  canMutateSubgoal,
  canonicalizeSubgoalIds,
  canonicalSubgoalForId,
  captureTrackedSubgoalRefs,
  coordinationOwnerIds,
  defaultAssigneeForStage,
  deriveSubgoalTitle,
  deriveSubgoalTopicKey,
  discoveryOwnerIds,
  hasStateMutation,
  inferNextDecisionState,
  isArchivedSubgoal,
  isDiscoveryOwner,
  isExplicitReopenUpdate,
  isSettledDownstreamSubgoal,
  nextSubgoalId,
  normalizeAssigneeForStage,
  normalizeStageForAssignee,
  recordSubgoalConflicts,
  referencedSubgoalIds,
  requiresGoalBoardOwnership,
  resetGoalBoard,
  resolveDirectedMessageSubgoalIds,
  sanitizeSubgoalUpdate,
  shouldIgnoreStaleSubgoalUpdate,
  subgoalByExactTopicKey,
} from "./subgoals";
import {
  actionableSubgoalsForAgent,
  actionableSubgoalSignature,
  buildActionableSubgoalSummary,
  buildGoalBoardSummary,
  buildRelevantSubgoalSummary,
  goalBoardNeedsAttention,
  pingGoalBoardOwners,
  relevantSubgoalsForAgent,
} from "./board-view";
import {
  appendAgentHistory as appendRuntimeAgentHistory,
  captureAgentStream,
  interruptAgent,
  persistAgent,
  persistSession,
  restoreFailedInFlightDigest,
  shouldRetryTransientTurnFailure,
  updateAgentSnapshot,
} from "./agent-runtime";
import { activateSession, initializeAgents as initializeLiveAgents } from "./lifecycle";
import {
  clearDeferredPending as clearDeferredAgentPending,
  publishEvent as publishSessionEvent,
  rebuildPendingDigestsFromHistory as rebuildSessionPendingDigestsFromHistory,
  routeEvent as routeSessionEvent,
  scheduleAgentDrain as scheduleLiveAgentDrain,
  shouldRouteEventToAgent as shouldRouteSessionEventToAgent,
} from "./event-router";
import { applyTurnResult as applyTurnResultToSession, drainAgent as drainLiveAgent } from "./turns";

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
  reason: "stale_update" | "obsolete_turn" | "reopen_suggestion" | "done_soft_note" | "done_reopen_suggestion";
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
    return activateSession(this, mode);
  }

  private initializeAgents(): void {
    return initializeLiveAgents(this);
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

  async hibernate(): Promise<void> {
    for (const agent of this.agents.values()) {
      if (agent.drainTimer) {
        clearTimeout(agent.drainTimer);
        agent.drainTimer = null;
      }
      if (agent.inFlightDigest) {
        this.restoreFailedInFlightDigest(agent, agent.inFlightDigest);
      }
      agent.draining = false;
      agent.inFlightDigest = null;
      agent.inFlightSubgoalRefs = null;
      agent.retryCount = 0;
      agent.interruptReason = null;
      await agent.process.stop();
      this.updateAgentSnapshot(agent.preset.id, {
        status: "idle",
        waitingForInput: false,
        ...(agent.snapshot.status === "running" || agent.snapshot.status === "starting"
          ? { completion: "continue" }
          : {}),
      });
    }
    this.status = "idle";
    this.persistSession();
    this.emit({ type: "session", sessionId: this.id, snapshot: this.snapshot(false) });
  }

  async stopAgent(agentId: string): Promise<void> {
    await this.interruptAgent(agentId, "stop");
  }

  async restartAgent(agentId: string): Promise<void> {
    await this.interruptAgent(agentId, "restart");
  }

  private publish(sender: string, channel: SessionChannel, content: string, metadata?: Record<string, unknown>): void {
    return publishSessionEvent(this, sender, channel, content, metadata);
  }

  private shouldRouteEventToAgent(agent: RuntimeAgent, event: SessionEvent): boolean {
    return shouldRouteSessionEventToAgent(this, agent, event);
  }

  private routeEvent(event: SessionEvent): void {
    return routeSessionEvent(this, event);
  }

  private clearDeferredPending(agent: RuntimeAgent): void {
    return clearDeferredAgentPending(this, agent);
  }

  private rebuildPendingDigestsFromHistory(): void {
    return rebuildSessionPendingDigestsFromHistory(this);
  }

  private scheduleAgentDrain(agentId: string, immediate = false): void {
    return scheduleLiveAgentDrain(this, agentId, immediate);
  }

  private shouldRetryTransientTurnFailure(message: string): boolean {
    return shouldRetryTransientTurnFailure(message);
  }

  private restoreFailedInFlightDigest(agent: RuntimeAgent, digest: PendingDigest | null): void {
    return restoreFailedInFlightDigest(this, agent, digest);
  }

  private async drainAgent(agentId: string): Promise<void> {
    return drainLiveAgent(this, agentId);
  }

  private applyTurnResult(agentId: string, result: AgentTurnResult, consumedSequence = 0, inFlightSubgoalRefs: TrackedSubgoalRef[] | null = null): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }
    agent.retryCount = 0;
    const normalizedResult = result;
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
      agent.snapshot.lastSeenActionableSignature = this.actionableSubgoalSignature(agent);
    }
    const rawTeamMessages = Array.isArray(normalizedResult.teamMessages)
      ? normalizedResult.teamMessages
          .filter((message) => message && typeof message === "object")
          .map((message) => {
            const explicitSubgoalIds = normalizeDirectedMessageSubgoalIds(message);
            return {
              content: compactWhitespace(message.content || ""),
              targetAgentId: String(message.targetAgentId ?? "").trim() || null,
              targetAgentIds: normalizeDirectedMessageTargets(message),
              ...(explicitSubgoalIds !== null ? { subgoalIds: explicitSubgoalIds } : {}),
            };
          })
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
      const effectiveSubgoalIds = this.resolveDirectedMessageSubgoalIds(message, referencedSubgoalIds);
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
        subgoalIds: effectiveSubgoalIds,
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
      !shouldSuppressDuplicateCoordinationTurn(this, agent, normalizeDirectedMessageSubgoalIds(message) ?? [], normalizeDirectedMessageTargets(message)) &&
      !shouldSuppressRepeatedResearchNote(this, agent, normalizeDirectedMessageSubgoalIds(message) ?? [], normalizeDirectedMessageTargets(message), actualStateChangeIds.length > 0)
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
      const subgoalIds = normalizeDirectedMessageSubgoalIds(message) ?? [];
      const subgoalPrefix = subgoalIds.length > 0 ? `[${subgoalIds.join(", ")}] ` : "";
      this.appendAgentHistory(agent, "messages", `${subgoalPrefix}${prefix}${message.content}`, `Turn ${agent.snapshot.turnCount}${effectiveTeamMessages.length > 1 ? ` #${index + 1}` : ""}`);
    });

    this.persistAgent(agentId);
    this.emit({ type: "agent", sessionId: this.id, agent: { ...agent.snapshot } });

    const statusSignature = statusEventSignature(this, agent, actualStateChangeIds, normalizedResult.completion, subgoalResult.blockedBuildPromotion);
    const shouldPublishStatus =
      normalizedResult.workingNotes.length > 0 &&
      !shouldSuppressObsoleteTurn &&
      (
        normalizedResult.completion !== "continue" ||
        actualStateChangeIds.length > 0 ||
        subgoalResult.blockedBuildPromotion
      ) &&
      !shouldSuppressDuplicateStatusEvent(this, agent, statusSignature);
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
        const messageSubgoalIds = normalizeDirectedMessageSubgoalIds(message) ?? [];
        const messageResearchNoteSignature = researchNoteSignature(this, agent, messageSubgoalIds, targetIds);
        const eventMetadata = {
          ...baseEventMetadata,
          ...(messageSubgoalIds.length > 0 ? { subgoalIds: messageSubgoalIds } : {}),
          ...(targetIds.length === 1 ? { targetAgentId: targetIds[0] } : {}),
          ...(targetIds.length > 0 ? { targetAgentIds: targetIds } : {}),
          ...(messageResearchNoteSignature ? { researchNoteSignature: messageResearchNoteSignature } : {}),
          ...(canCanonicalizeSubgoal(this, agentId) && messageSubgoalIds.length > 0 && targetIds.length > 0
            ? { routingSignature: coordinationRoutingSignature(this, messageSubgoalIds, targetIds) }
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
        const groupedConflictSignature = conflictBurstSignature(grouped.conflicts, grouped.targets);
        if (shouldSuppressConflictBurst(this, subgoalId, groupedConflictSignature)) {
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
            ...(groupedConflictSignature ? { conflictBurstSignature: groupedConflictSignature } : {}),
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
    return captureAgentStream(this, agentId, stream, text);
  }

  private updateAgentSnapshot(agentId: string, update: Partial<AgentSnapshot>): void {
    return updateAgentSnapshot(this, agentId, update);
  }

  private appendAgentHistory(agent: RuntimeAgent, kind: "notes" | "messages" | "errors", text: string, label?: string | null): void {
    return appendRuntimeAgentHistory(this, agent, kind, text, label);
  }

  private persistAgent(agentId: string): void {
    return persistAgent(this, agentId);
  }

  private persistSession(): void {
    return persistSession(this);
  }

  private async interruptAgent(agentId: string, mode: "stop" | "restart"): Promise<void> {
    return interruptAgent(this, agentId, mode);
  }

  private resetGoalBoard(goal: string, actor: string): void {
    return resetGoalBoard(this, goal, actor);
  }

  private nextSubgoalId(): string {
    return nextSubgoalId(this);
  }

  private defaultAssigneeForStage(stage: SubgoalStage): string | null {
    return defaultAssigneeForStage(this, stage);
  }

  private coordinationOwnerIds(): string[] {
    return coordinationOwnerIds(this);
  }

  private agentOwnsStage(agentId: string, stage: SubgoalStage): boolean {
    return agentOwnsStage(this, agentId, stage);
  }

  private canCreateSubgoal(agentId: string): boolean {
    return canCreateSubgoal(this, agentId);
  }

  private canonicalSubgoalForId(subgoalId: string | null | undefined): SessionSubgoal | null {
    return canonicalSubgoalForId(this, subgoalId);
  }

  private canonicalizeSubgoalIds(subgoalIds: string[] | null | undefined): string[] {
    return canonicalizeSubgoalIds(this, subgoalIds);
  }

  private resolveDirectedMessageSubgoalIds(message: DirectedTeamMessage | null | undefined, fallbackSubgoalIds: string[]): string[] {
    return resolveDirectedMessageSubgoalIds(this, message, fallbackSubgoalIds);
  }

  private deriveSubgoalTopicKey(update: SubgoalUpdate, fallbackKey: string): string {
    return deriveSubgoalTopicKey(this, update, fallbackKey);
  }

  private requiresGoalBoardOwnership(agent: RuntimeAgent): boolean {
    return requiresGoalBoardOwnership(this, agent);
  }

  private canMutateSubgoal(agentId: string, existing: SessionSubgoal): boolean {
    return canMutateSubgoal(this, agentId, existing);
  }

  private hasStateMutation(update: SubgoalUpdate, existing: SessionSubgoal | null): boolean {
    return hasStateMutation(this, update, existing);
  }

  private normalizeAssigneeForStage(explicitAssignee: string | null, stage: SubgoalStage, existingAssignee?: string | null): string | null {
    return normalizeAssigneeForStage(this, explicitAssignee, stage, existingAssignee);
  }

  private normalizeStageForAssignee(id: string | null, stage: SubgoalStage, currentSubgoalId?: string): SubgoalStage {
    return normalizeStageForAssignee(this, id, stage, currentSubgoalId);
  }

  private sanitizeSubgoalUpdate(update: SubgoalUpdate): SubgoalUpdate | null {
    return sanitizeSubgoalUpdate(this, update);
  }

  private isArchivedSubgoal(subgoal: SessionSubgoal | null | undefined): boolean {
    return isArchivedSubgoal(this, subgoal);
  }

  private activeSubgoals(): SessionSubgoal[] {
    return activeSubgoals(this);
  }

  private archivedSubgoals(): SessionSubgoal[] {
    return archivedSubgoals(this);
  }

  private discoveryOwnerIds(): string[] {
    return discoveryOwnerIds(this);
  }

  private isDiscoveryOwner(agentId: string): boolean {
    return isDiscoveryOwner(this, agentId);
  }

  private canCanonicalizeSubgoal(agentId: string): boolean {
    return canCanonicalizeSubgoal(this, agentId);
  }

  private isSettledDownstreamSubgoal(subgoal: SessionSubgoal | null | undefined): boolean {
    return isSettledDownstreamSubgoal(this, subgoal);
  }

  private isExplicitReopenUpdate(update: SubgoalUpdate): boolean {
    return isExplicitReopenUpdate(this, update);
  }

  private subgoalByExactTopicKey(topicKey: string | null | undefined, stages?: SubgoalStage[]): SessionSubgoal | null {
    return subgoalByExactTopicKey(this, topicKey, stages);
  }

  private referencedSubgoalIds(
    changedSubgoalIds: string[],
    updates: SubgoalUpdate[] | undefined,
    inFlightSubgoalRefs: TrackedSubgoalRef[] | null,
  ): string[] {
    return referencedSubgoalIds(this, changedSubgoalIds, updates, inFlightSubgoalRefs);
  }

  private deriveSubgoalTitle(update: SubgoalUpdate, fallbackId: string): string {
    return deriveSubgoalTitle(this, update, fallbackId);
  }

  private shouldIgnoreStaleSubgoalUpdate(existing: SessionSubgoal, update: SubgoalUpdate): boolean {
    return shouldIgnoreStaleSubgoalUpdate(this, existing, update);
  }

  private buildStaleSubgoalConflict(agentId: string, existing: SessionSubgoal, update: SubgoalUpdate, requestedStage: SubgoalStage): StaleSubgoalConflict | null {
    return buildStaleSubgoalConflict(this, agentId, existing, update, requestedStage);
  }

  private inferNextDecisionState(existing: SessionSubgoal | null, update: SubgoalUpdate, requestedStage: SubgoalStage): SubgoalDecisionState {
    return inferNextDecisionState(this, existing, update, requestedStage);
  }

  private captureTrackedSubgoalRefs(agent: RuntimeAgent): TrackedSubgoalRef[] {
    return captureTrackedSubgoalRefs(this, agent);
  }

  private buildObsoleteTurnConflicts(agentId: string, trackedRefs: TrackedSubgoalRef[] | null): StaleSubgoalConflict[] {
    return buildObsoleteTurnConflicts(this, agentId, trackedRefs);
  }

  private recordSubgoalConflicts(conflicts: StaleSubgoalConflict[]): string[] {
    return recordSubgoalConflicts(this, conflicts);
  }

  private applySubgoalUpdates(agentId: string, updates: SubgoalUpdate[] | undefined): SubgoalUpdateResult {
    return applySubgoalUpdates(this, agentId, updates);
  }

  private actionableSubgoalsForAgent(agent: RuntimeAgent): SessionSubgoal[] {
    return actionableSubgoalsForAgent(this, agent);
  }

  private actionableSubgoalSignature(agent: RuntimeAgent): string | null {
    return actionableSubgoalSignature(this, agent);
  }

  private relevantSubgoalsForAgent(agent: RuntimeAgent): SessionSubgoal[] {
    return relevantSubgoalsForAgent(this, agent);
  }

  private goalBoardNeedsAttention(agent: RuntimeAgent): boolean {
    return goalBoardNeedsAttention(this, agent);
  }

  private buildGoalBoardSummary(agent: RuntimeAgent): string {
    return buildGoalBoardSummary(this, agent);
  }

  private buildActionableSubgoalSummary(agent: RuntimeAgent): string {
    return buildActionableSubgoalSummary(this, agent);
  }

  private buildRelevantSubgoalSummary(agent: RuntimeAgent): string {
    return buildRelevantSubgoalSummary(this, agent);
  }

  private pingGoalBoardOwners(): void {
    return pingGoalBoardOwners(this);
  }

  private latestGoalSequence(): number {
    return latestGoalSequence(this);
  }

  private eventsSinceGoalForChannels(channels: SessionChannel[]): SessionEvent[] {
    return eventsSinceGoalForChannels(this, channels);
  }

  private hasChannelActivitySinceGoal(channels: SessionChannel[]): boolean {
    return hasChannelActivitySinceGoal(this, channels);
  }

  private discoveryChannels(): Set<SessionChannel> {
    return discoveryChannels(this);
  }

  private meetsActivationPolicy(agent: RuntimeAgent): boolean {
    return meetsActivationPolicy(this, agent);
  }

  private shouldIgnoreCompletedAgent(agent: RuntimeAgent, event: SessionEvent): boolean {
    return shouldIgnoreCompletedAgent(this, agent, event);
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
    return currentTurnHasTargetedRequest(this, agent);
  }

  private hasOperatorOverride(agent: RuntimeAgent): boolean {
    return hasOperatorOverride(this, agent);
  }

  private applyPeerContextTargetDeferral(agent: RuntimeAgent, targetAgentIds: string[]): string[] {
    return applyPeerContextTargetDeferral(this, agent, targetAgentIds);
  }

  private shouldForceBroadcastOnFirstTurn(agent: RuntimeAgent): boolean {
    return shouldForceBroadcastOnFirstTurn(this, agent);
  }

  private shouldDeferAgent(agent: RuntimeAgent): boolean {
    return shouldDeferAgent(this, agent);
  }

  private transcriptEventLimit(agent: RuntimeAgent): number {
    return transcriptEventLimit(this, agent);
  }

  private transcriptCharLimit(agent: RuntimeAgent): number {
    return transcriptCharLimit(this, agent);
  }

  private transcriptChannels(agent: RuntimeAgent): Set<SessionChannel> {
    return transcriptChannels(this, agent);
  }

  private buildTranscript(agent: RuntimeAgent, digest: PendingDigest): string {
    return buildTranscript(this, agent, digest);
  }

  private emit(payload: unknown): void {
    for (const handler of this.subscribers) {
      handler(payload);
    }
  }
}
