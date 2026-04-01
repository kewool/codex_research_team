// @ts-nocheck
import { nowIso } from "../lib/utils";
import {
  compactWhitespace,
  defaultDecisionStateForStage,
  mergeMemoryList,
  normalizeDecisionState,
  normalizeDirectedMessageSubgoalIds,
  normalizeExpectedRevision,
  normalizeMemoryList,
  normalizeNextAction,
  normalizeSubgoalStage,
  normalizeTopicKey,
  SUBGOAL_ACCEPTANCE_LIMIT,
  SUBGOAL_DECISION_LIMIT,
  SUBGOAL_FACT_LIMIT,
  SUBGOAL_FILE_LIMIT,
  SUBGOAL_QUESTION_LIMIT,
} from "./helpers";
import { canCanonicalizeSubgoal } from "./signatures";

export function resetGoalBoard(session: any, goal: string, actor: string): void {
  session.subgoalRevision = Math.max(0, session.subgoalRevision) + 1;
  const timestamp = nowIso();
  session.subgoals = [];
  for (const agent of session.agents.values()) {
    agent.snapshot.lastSeenSubgoalRevision = 0;
    agent.snapshot.lastSeenActionableSignature = null;
    agent.snapshot.lastSeenRoutingSignature = null;
    session.persistAgent(agent.preset.id);
  }
  session.updatedAt = timestamp;
  session.persistSession();
}

export function nextSubgoalId(session: any): string {
  let maxId = 0;
  for (const subgoal of session.subgoals) {
    const match = String(subgoal.id ?? "").match(/^sg-(\d+)$/);
    const parsed = Number(match?.[1] || 0);
    if (parsed > maxId) {
      maxId = parsed;
    }
  }
  return `sg-${maxId + 1}`;
}

export function defaultAssigneeForStage(session: any, stage: string): string | null {
  if (stage === "open" || stage === "researching" || stage === "done") {
    return null;
  }
  const match = session.config.agents.find((agent: any) => Array.isArray(agent.policy?.ownedStages) && agent.policy.ownedStages.includes(stage));
  return match?.id ?? null;
}

export function coordinationOwnerIds(session: any): string[] {
  return [...new Set(
    session.config.agents
      .filter((agent: any) =>
        Array.isArray(agent.policy?.ownedStages) &&
        (agent.policy.ownedStages.includes("ready_for_build") || agent.policy.ownedStages.includes("blocked")),
      )
      .map((agent: any) => String(agent.id ?? "").trim())
      .filter(Boolean),
  )];
}

export function agentOwnsStage(session: any, agentId: string, stage: string): boolean {
  const runtime = session.agents.get(agentId);
  return Boolean(runtime && Array.isArray(runtime.preset.policy?.ownedStages) && runtime.preset.policy.ownedStages.includes(stage));
}

export function canCreateSubgoal(session: any, agentId: string): boolean {
  const runtime = session.agents.get(agentId);
  const ownedStages = Array.isArray(runtime?.preset.policy?.ownedStages) ? runtime.preset.policy.ownedStages : [];
  return ownedStages.some((stage: string) => stage === "open" || stage === "researching" || stage === "ready_for_build" || stage === "blocked");
}

export function canonicalSubgoalForId(session: any, subgoalId: string | null | undefined): any | null {
  const normalizedId = String(subgoalId ?? "").trim();
  if (!normalizedId) {
    return null;
  }
  const visited = new Set<string>();
  let current = session.subgoals.find((subgoal: any) => subgoal.id === normalizedId) ?? null;
  while (current?.mergedIntoSubgoalId && !visited.has(current.id)) {
    visited.add(current.id);
    const next = session.subgoals.find((subgoal: any) => subgoal.id === current?.mergedIntoSubgoalId) ?? null;
    if (!next) {
      break;
    }
    current = next;
  }
  return current;
}

export function canonicalizeSubgoalIds(session: any, subgoalIds: string[] | null | undefined): string[] {
  const ids = new Set<string>();
  for (const subgoalId of Array.isArray(subgoalIds) ? subgoalIds : []) {
    const canonical = canonicalSubgoalForId(session, subgoalId);
    if (canonical?.id) {
      ids.add(canonical.id);
    }
  }
  return [...ids];
}

export function resolveDirectedMessageSubgoalIds(session: any, message: any, fallbackSubgoalIds: string[]): string[] {
  const explicitSubgoalIds = normalizeDirectedMessageSubgoalIds(message);
  if (explicitSubgoalIds !== null) {
    return canonicalizeSubgoalIds(session, explicitSubgoalIds);
  }
  return canonicalizeSubgoalIds(session, fallbackSubgoalIds);
}

export function deriveSubgoalTopicKey(session: any, update: any, fallbackKey: string): string {
  return update.topicKey || fallbackKey;
}

export function requiresGoalBoardOwnership(session: any, agent: any): boolean {
  const ownedStages = Array.isArray(agent.preset.policy?.ownedStages) ? agent.preset.policy.ownedStages : [];
  return ownedStages.length > 0 && ownedStages.every((stage: string) => stage === "building" || stage === "ready_for_review");
}

export function canMutateSubgoal(session: any, agentId: string, existing: any): boolean {
  if (isArchivedSubgoal(session, existing)) {
    return false;
  }
  if (coordinationOwnerIds(session).includes(agentId)) {
    return true;
  }
  if (existing.assigneeAgentId) {
    return existing.assigneeAgentId === agentId;
  }
  return agentOwnsStage(session, agentId, existing.stage);
}

export function hasStateMutation(session: any, update: any, existing: any | null): boolean {
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

export function normalizeAssigneeForStage(session: any, explicitAssignee: string | null, stage: string, existingAssignee?: string | null): string | null {
  if (explicitAssignee && agentOwnsStage(session, explicitAssignee, stage)) {
    return explicitAssignee;
  }
  if (existingAssignee && agentOwnsStage(session, existingAssignee, stage)) {
    return existingAssignee;
  }
  return defaultAssigneeForStage(session, stage);
}

export function normalizeStageForAssignee(session: any, id: string | null, stage: string, currentSubgoalId?: string): string {
  if (!id || stage !== "building") {
    return stage;
  }
  const hasOtherBuildingSubgoal = session.subgoals.some(
    (subgoal: any) =>
      subgoal.id !== currentSubgoalId &&
      subgoal.assigneeAgentId === id &&
      subgoal.stage === "building",
  );
  if (hasOtherBuildingSubgoal) {
    return "ready_for_build";
  }
  return stage;
}

export function sanitizeSubgoalUpdate(session: any, update: any): any | null {
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

export function isArchivedSubgoal(session: any, subgoal: any | null | undefined): boolean {
  return Boolean(subgoal && (subgoal.mergedIntoSubgoalId || subgoal.archivedAt));
}

export function activeSubgoals(session: any): any[] {
  return session.subgoals.filter((subgoal: any) => !isArchivedSubgoal(session, subgoal));
}

export function archivedSubgoals(session: any): any[] {
  return session.subgoals.filter((subgoal: any) => isArchivedSubgoal(session, subgoal));
}

export function discoveryOwnerIds(session: any): string[] {
  return [...new Set(
    session.config.agents
      .filter((agent: any) =>
        Array.isArray(agent.policy?.ownedStages) &&
        (agent.policy.ownedStages.includes("open") || agent.policy.ownedStages.includes("researching")),
      )
      .map((agent: any) => String(agent.id ?? "").trim())
      .filter(Boolean),
  )];
}

export function isDiscoveryOwner(session: any, agentId: string): boolean {
  return discoveryOwnerIds(session).includes(agentId);
}

export function isSettledDownstreamSubgoal(session: any, subgoal: any | null | undefined): boolean {
  if (!subgoal) {
    return false;
  }
  return (
    subgoal.decisionState === "resolved" &&
    (subgoal.stage === "ready_for_build" || subgoal.stage === "building" || subgoal.stage === "ready_for_review" || subgoal.stage === "done")
  );
}

export function isExplicitReopenUpdate(session: any, update: any): boolean {
  const requestedStage = update.stage ? normalizeSubgoalStage(update.stage, "researching") : null;
  return Boolean(
    (requestedStage && (requestedStage === "researching" || requestedStage === "blocked")) ||
    update.decisionState === "disputed" ||
    compactWhitespace(update.reopenReason || "")
  );
}

export function subgoalByExactTopicKey(session: any, topicKey: string | null | undefined, stages?: string[]): any | null {
  const normalized = normalizeTopicKey(topicKey);
  if (!normalized) {
    return null;
  }
  return activeSubgoals(session).find((subgoal: any) => {
    if (subgoal.topicKey !== normalized) {
      return false;
    }
    if (Array.isArray(stages) && stages.length > 0 && !stages.includes(subgoal.stage)) {
      return false;
    }
    return true;
  }) ?? null;
}

export function referencedSubgoalIds(
  session: any,
  changedSubgoalIds: string[],
  updates: any[] | undefined,
  inFlightSubgoalRefs: any[] | null,
): string[] {
  const ids = new Set<string>(changedSubgoalIds);
  for (const update of Array.isArray(updates) ? updates : []) {
    if (update?.id) {
      const canonical = canonicalSubgoalForId(session, update.id);
      if (canonical?.id) {
        ids.add(canonical.id);
      }
    } else if (update?.topicKey) {
      const exact = subgoalByExactTopicKey(session, update.topicKey);
      if (exact?.id) {
        ids.add(exact.id);
      }
    }
  }
  for (const ref of Array.isArray(inFlightSubgoalRefs) ? inFlightSubgoalRefs : []) {
    const canonical = canonicalSubgoalForId(session, ref.id);
    if (canonical?.id) {
      ids.add(canonical.id);
    }
  }
  return [...ids];
}

export function deriveSubgoalTitle(session: any, update: any, fallbackId: string): string {
  return update.title || `Untitled ${fallbackId}`;
}

export function shouldIgnoreStaleSubgoalUpdate(session: any, existing: any, update: any): boolean {
  if (!update.id) {
    return false;
  }
  const expectedRevision = normalizeExpectedRevision(update.expectedRevision);
  if (!expectedRevision) {
    return false;
  }
  return expectedRevision !== Number(existing.revision || 0);
}

function isUpstreamConflictStage(stage: string): boolean {
  return stage === "open" || stage === "researching" || stage === "ready_for_build" || stage === "blocked";
}

function isDownstreamConflictStage(stage: string): boolean {
  return stage === "building" || stage === "ready_for_review";
}

function classifyStaleConflictReason(currentStage: string, requestedStage: string, nonReopenReason: "stale_update" | "obsolete_turn"): string {
  const requestsUpstream = requestedStage === "researching" || requestedStage === "blocked";
  if (currentStage === "done") {
    return requestsUpstream ? "done_reopen_suggestion" : "done_soft_note";
  }
  if (requestsUpstream && isDownstreamConflictStage(currentStage)) {
    return "reopen_suggestion";
  }
  if (isUpstreamConflictStage(currentStage)) {
    return nonReopenReason;
  }
  return nonReopenReason;
}

export function buildStaleSubgoalConflict(session: any, agentId: string, existing: any, update: any, requestedStage: string): any | null {
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
  const reason = classifyStaleConflictReason(existing.stage, requestedStage, "stale_update");
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

export function inferNextDecisionState(session: any, existing: any | null, update: any, requestedStage: string): string {
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

export function captureTrackedSubgoalRefs(session: any, agent: any): any[] {
  return session.actionableSubgoalsForAgent(agent).map((subgoal: any) => ({
    id: subgoal.id,
    revision: Number(subgoal.revision || 0),
    stage: subgoal.stage,
    assigneeAgentId: subgoal.assigneeAgentId ?? null,
  }));
}

export function buildObsoleteTurnConflicts(session: any, agentId: string, trackedRefs: any[] | null): any[] {
  if (!trackedRefs || trackedRefs.length === 0) {
    return [];
  }
  const conflicts: any[] = [];
  for (const trackedRef of trackedRefs) {
    const existing = canonicalSubgoalForId(session, trackedRef.id);
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
    const reason = classifyStaleConflictReason(existing.stage, trackedRef.stage, "obsolete_turn");
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

export function recordSubgoalConflicts(session: any, conflicts: any[]): string[] {
  const changedIds = new Set<string>();
  for (const conflict of conflicts) {
    const existingIndex = session.subgoals.findIndex((subgoal: any) => subgoal.id === conflict.subgoalId);
    if (existingIndex < 0) {
      continue;
    }
    const existing = session.subgoals[existingIndex];
    const timestamp = nowIso();
    const isDoneSoftNote = conflict.reason === "done_soft_note";
    const isReopenSuggestion = conflict.reason === "done_reopen_suggestion" || conflict.reason === "reopen_suggestion";
    session.subgoals[existingIndex] = {
      ...existing,
      updatedAt: timestamp,
      updatedBy: "system",
      revision: existing.revision,
      conflictCount: Math.max(0, Number(existing.conflictCount || 0)) + 1,
      activeConflict: !isDoneSoftNote,
      lastConflictAt: timestamp,
      lastConflictSummary: isReopenSuggestion ? `Reopen suggestion: ${conflict.message}` : conflict.message,
    };
    changedIds.add(existing.id);
  }
  if (changedIds.size > 0) {
    session.updatedAt = nowIso();
    session.persistSession();
  }
  return [...changedIds];
}

export function applySubgoalUpdates(session: any, agentId: string, updates: any[] | undefined): any {
  const normalized = Array.isArray(updates) ? updates.map((update) => sanitizeSubgoalUpdate(session, update)).filter(Boolean) : [];
  if (normalized.length === 0) {
    return { changedIds: [], blockedBuildPromotion: false, conflicts: [] };
  }

  const changedIds = new Set<string>();
  let blockedBuildPromotion = false;
  const conflicts: any[] = [];
  for (const update of normalized.slice(0, 8)) {
    const exactTopicMatch = !update.id && update.topicKey
      ? subgoalByExactTopicKey(session, update.topicKey)
      : null;
    const existingMatch = update.id
      ? canonicalSubgoalForId(session, update.id)
      : exactTopicMatch
        ? canonicalSubgoalForId(session, exactTopicMatch.id)
      : null;
    const redirectedFromMerged = Boolean(update.id && existingMatch && existingMatch.id !== update.id);
    const existingIndex = existingMatch ? session.subgoals.findIndex((subgoal: any) => subgoal.id === existingMatch.id) : -1;
    const timestamp = nowIso();
    if (existingIndex >= 0) {
      const existing = session.subgoals[existingIndex];
      if (isArchivedSubgoal(session, existing)) {
        continue;
      }
      if (!update.id && existing.stage === "done") {
        continue;
      }
      let canMutateState = !redirectedFromMerged && canMutateSubgoal(session, agentId, existing);
      if (
        !canMutateState &&
        update.id &&
        isExplicitReopenUpdate(session, update) &&
        (isDiscoveryOwner(session, agentId) || canCanonicalizeSubgoal(session, agentId))
      ) {
        canMutateState = true;
      }
      const wantsStateMutation = hasStateMutation(session, update, existing);
      if (
        isDiscoveryOwner(session, agentId) &&
        !update.id &&
        isSettledDownstreamSubgoal(session, existing) &&
        !isExplicitReopenUpdate(session, update)
      ) {
        continue;
      }
      let requestedStage = canMutateState && update.stage ? normalizeSubgoalStage(update.stage, existing.stage) : existing.stage;
      let decisionState = canMutateState ? inferNextDecisionState(session, existing, update, requestedStage) : existing.decisionState;
      let buildGateMessage: string | null = null;
      if (canMutateState && requestedStage === "building" && decisionState !== "resolved") {
        requestedStage = "researching";
        decisionState = "disputed";
        blockedBuildPromotion = true;
        buildGateMessage = `Build promotion blocked for ${existing.id}: unresolved contradictions remain. Mark the subgoal decisionState=resolved before sending it to building.`;
      }
      if (!redirectedFromMerged && shouldIgnoreStaleSubgoalUpdate(session, existing, update) && wantsStateMutation) {
        const conflict = buildStaleSubgoalConflict(session, agentId, existing, update, requestedStage);
        if (conflict) {
          for (const changedId of recordSubgoalConflicts(session, [conflict])) {
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
        canMutateState && canCanonicalizeSubgoal(session, agentId) && update.mergedIntoSubgoalId
          ? update.mergedIntoSubgoalId
          : null;
      if (requestedMergeTargetId) {
        const mergeTarget = activeSubgoals(session).find((subgoal: any) => subgoal.id === requestedMergeTargetId);
        if (!mergeTarget || mergeTarget.id === existing.id) {
          continue;
        }
        if (existing.stage === "building" || existing.stage === "ready_for_review") {
          session.subgoalRevision += 1;
          session.subgoals[existingIndex] = {
            ...existing,
            updatedAt: timestamp,
            updatedBy: agentId,
            revision: session.subgoalRevision,
            activeConflict: true,
            lastConflictAt: timestamp,
            lastConflictSummary: `Merge into ${mergeTarget.id} deferred until the active ${existing.stage} stage finishes.`,
          };
          changedIds.add(existing.id);
          continue;
        }
        session.subgoalRevision += 1;
        session.subgoals[existingIndex] = {
          ...existing,
          mergedIntoSubgoalId: mergeTarget.id,
          archivedAt: timestamp,
          archivedBy: agentId,
          updatedAt: timestamp,
          updatedBy: agentId,
          revision: session.subgoalRevision,
          activeConflict: false,
          lastConflictAt: null,
          lastConflictSummary: null,
        };
        changedIds.add(existing.id);
        continue;
      }
      session.subgoalRevision += 1;
      const explicitAssignee = canMutateState && update.assigneeAgentId != null
        ? (update.assigneeAgentId && session.agents.has(update.assigneeAgentId) ? update.assigneeAgentId : null)
        : null;
      const requestedAssignee = explicitAssignee !== null
        ? explicitAssignee
        : (requestedStage !== existing.stage ? defaultAssigneeForStage(session, requestedStage) : existing.assigneeAgentId);
      const stage = normalizeStageForAssignee(session, requestedAssignee, requestedStage, existing.id);
      const assigneeAgentId = normalizeAssigneeForStage(
        session,
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
            || ((requestedStage === "researching" || requestedStage === "blocked") && (update.summary || existing.summary)
              ? compactWhitespace(update.summary || existing.summary).slice(0, 220) || null
              : existing.lastReopenReason)
            || null);
      const inferredFact = !canMutateState && update.summary ? [update.summary] : [];
      session.subgoals[existingIndex] = {
        ...existing,
        title: canMutateState ? (update.title || existing.title) : existing.title,
        topicKey: canMutateState ? (update.topicKey || existing.topicKey) : existing.topicKey,
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
        revision: session.subgoalRevision,
        conflictCount: Math.max(0, Number(existing.conflictCount || 0)),
        activeConflict: Boolean(buildGateMessage),
        lastConflictAt: buildGateMessage ? timestamp : (decisionState === "resolved" ? null : existing.lastConflictAt ?? null),
        lastConflictSummary: buildGateMessage ? buildGateMessage : (decisionState === "resolved" ? null : existing.lastConflictSummary ?? null),
      };
      changedIds.add(existing.id);
      continue;
    }

    if (!canCreateSubgoal(session, agentId)) {
      continue;
    }

    let requestedStage = normalizeSubgoalStage(update.stage, "researching");
    const id = nextSubgoalId(session);
    session.subgoalRevision += 1;
    let decisionState = inferNextDecisionState(session, null, update, requestedStage);
    let buildGateMessage: string | null = null;
    if (requestedStage === "building" && decisionState !== "resolved") {
      requestedStage = "researching";
      decisionState = "disputed";
      blockedBuildPromotion = true;
      buildGateMessage = `Build promotion blocked for ${id}: unresolved contradictions remain. Mark the subgoal decisionState=resolved before sending it to building.`;
    }
    if (
      requestedStage === "building" &&
      !agentOwnsStage(session, agentId, "building") &&
      !coordinationOwnerIds(session).includes(agentId)
    ) {
      requestedStage = "ready_for_build";
      blockedBuildPromotion = true;
    }
    const explicitAssignee = update.assigneeAgentId && session.agents.has(update.assigneeAgentId)
      ? update.assigneeAgentId
      : null;
    const requestedAssignee = explicitAssignee ?? defaultAssigneeForStage(session, requestedStage);
    const stage = normalizeStageForAssignee(session, requestedAssignee, requestedStage, id);
    session.subgoals.push({
      id,
      title: update.title || `Untitled ${id}`,
      topicKey: update.topicKey || `topic-${id}`,
      summary: update.summary || "No summary provided.",
      facts: mergeMemoryList([], update.addFacts, SUBGOAL_FACT_LIMIT),
      openQuestions: mergeMemoryList([], update.addOpenQuestions, SUBGOAL_QUESTION_LIMIT),
      resolvedDecisions: mergeMemoryList([], update.addResolvedDecisions, SUBGOAL_DECISION_LIMIT),
      acceptanceCriteria: mergeMemoryList([], update.addAcceptanceCriteria, SUBGOAL_ACCEPTANCE_LIMIT),
      relevantFiles: mergeMemoryList([], update.addRelevantFiles, SUBGOAL_FILE_LIMIT, 120),
      nextAction: update.nextAction !== undefined ? normalizeNextAction(update.nextAction) : null,
      stage,
      decisionState,
      lastReopenReason: decisionState === "resolved" ? null : (update.reopenReason || buildGateMessage || (update.summary ? compactWhitespace(update.summary).slice(0, 220) || null : null)),
      assigneeAgentId: normalizeAssigneeForStage(session, explicitAssignee && stage === requestedStage ? explicitAssignee : null, stage),
      mergedIntoSubgoalId: null,
      archivedAt: null,
      archivedBy: null,
      updatedAt: timestamp,
      updatedBy: agentId,
      revision: session.subgoalRevision,
      conflictCount: 0,
      activeConflict: Boolean(buildGateMessage),
      lastConflictAt: null,
      lastConflictSummary: buildGateMessage,
    });
    changedIds.add(id);
  }
  session.subgoals = [...session.subgoals].sort((left: any, right: any) => {
    const leftArchived = isArchivedSubgoal(session, left) ? 1 : 0;
    const rightArchived = isArchivedSubgoal(session, right) ? 1 : 0;
    if (leftArchived !== rightArchived) {
      return leftArchived - rightArchived;
    }
    return Number(left.revision || 0) - Number(right.revision || 0);
  });
  session.updatedAt = nowIso();
  session.persistSession();
  return {
    changedIds: [...changedIds],
    blockedBuildPromotion,
    conflicts,
  };
}
