// @ts-nocheck
import {
  compactWhitespace,
  extractTargetAgentIds,
  normalizeDirectedMessageSubgoalIds,
  normalizeDirectedMessageTargets,
  shortenText,
  summarizeDirectedMessages,
  TRANSIENT_TURN_RETRY_LIMIT,
} from "./helpers";
import {
  buildTriggerSummary,
  emptyPendingDigest,
  hasPendingDigest,
  maxDigestSequence,
} from "./digest";
import {
  canCanonicalizeSubgoal,
  conflictBurstSignature,
  coordinationRoutingSignature,
  shouldSuppressConflictBurst,
  shouldSuppressDuplicateCoordinationTurn,
  shouldSuppressDuplicateStatusEvent,
  statusEventSignature,
} from "./signatures";
import { nowIso } from "../lib/utils";

function ownsOnlyReviewStage(agent: any): boolean {
  return (
    Array.isArray(agent?.preset?.policy?.ownedStages) &&
    agent.preset.policy.ownedStages.length > 0 &&
    agent.preset.policy.ownedStages.every((stage: string) => stage === "ready_for_review")
  );
}

function rewriteReviewerReopenSuggestions(session: any, agentId: string, agent: any, result: any, rawTeamMessages: any[]): { teamMessages: any[]; subgoalUpdates: any[] } {
  if (!ownsOnlyReviewStage(agent)) {
    return {
      teamMessages: rawTeamMessages,
      subgoalUpdates: Array.isArray(result.subgoalUpdates) ? result.subgoalUpdates : [],
    };
  }
  const coordinationOwnerId = session.defaultAssigneeForStage("ready_for_build") || session.defaultAssigneeForStage("blocked");
  const retainedUpdates: any[] = [];
  const nextMessages = [...rawTeamMessages];
  for (const update of Array.isArray(result.subgoalUpdates) ? result.subgoalUpdates : []) {
    const subgoalId = String(update?.id ?? "").trim();
    const existing = subgoalId ? session.canonicalSubgoalForId(subgoalId) : null;
    const wantsUpstreamReopen =
      Boolean(existing) &&
      session.isExplicitReopenUpdate(update) &&
      String(update?.stage ?? "").trim() !== "building";
    if (!wantsUpstreamReopen) {
      retainedUpdates.push(update);
      continue;
    }
    const reason = compactWhitespace(String(update?.reopenReason ?? update?.summary ?? "").trim()) || "review found a contract issue that needs coordination";
    const alreadyTargetedCoordinator = nextMessages.some((message) => {
      const targetIds = normalizeDirectedMessageTargets(message);
      const subgoalIds = normalizeDirectedMessageSubgoalIds(message) ?? [];
      return Boolean(coordinationOwnerId) && targetIds.includes(coordinationOwnerId) && subgoalIds.includes(existing.id);
    });
    if (!alreadyTargetedCoordinator) {
      nextMessages.push({
        content: `Review suggests reopening ${existing.id}: ${reason}`,
        ...(coordinationOwnerId ? { targetAgentId: coordinationOwnerId, targetAgentIds: [coordinationOwnerId] } : { targetAgentIds: [] }),
        subgoalIds: [existing.id],
      });
      result.shouldReply = true;
    }
  }
  return { teamMessages: nextMessages, subgoalUpdates: retainedUpdates };
}

function conflictTargetIds(session: any, conflict: any, sourceAgentId: string): string[] {
  const coordinatorId = session.defaultAssigneeForStage("ready_for_build") || session.defaultAssigneeForStage("blocked");
  const targets = new Set<string>();
  if (conflict.reason === "stale_update" || conflict.reason === "obsolete_turn") {
    if (coordinatorId && session.agents.has(coordinatorId)) {
      targets.add(coordinatorId);
    }
  } else if (conflict.reason === "reopen_suggestion" || conflict.reason === "done_reopen_suggestion") {
    if (coordinatorId && session.agents.has(coordinatorId)) {
      targets.add(coordinatorId);
    }
    const assigneeId = String(conflict.currentAssigneeAgentId ?? "").trim();
    if (assigneeId && session.agents.has(assigneeId)) {
      targets.add(assigneeId);
    }
  }
  return [...targets];
}

function hasTargetedOperatorRequest(agent: any): boolean {
  const digest = agent?.inFlightDigest;
  if (!digest) {
    return false;
  }
  const operatorEvents = [
    ...(Array.isArray(digest.operatorEvents) ? digest.operatorEvents : []),
    ...(Array.isArray(digest.directInputs) ? digest.directInputs : []),
  ];
  return operatorEvents.some((event: any) => extractTargetAgentIds(event?.metadata).includes(agent.preset.id));
}

function hasTargetedRequest(agent: any): boolean {
  const digest = agent?.inFlightDigest;
  if (!digest) {
    return false;
  }
  const events = [
    ...(Array.isArray(digest.operatorEvents) ? digest.operatorEvents : []),
    ...(Array.isArray(digest.directInputs) ? digest.directInputs : []),
    ...Object.values(digest.channelEvents || {}).flat(),
    ...(Array.isArray(digest.otherEvents) ? digest.otherEvents : []),
  ];
  return events.some((event: any) => extractTargetAgentIds(event?.metadata).includes(agent.preset.id));
}

function hasTargetedCoordinatorOrOwnerMessage(session: any, effectiveTeamMessages: any[]): boolean {
  if (!Array.isArray(effectiveTeamMessages) || effectiveTeamMessages.length === 0) {
    return false;
  }
  const coordinatorIds = [
    session.defaultAssigneeForStage("ready_for_build"),
    session.defaultAssigneeForStage("blocked"),
  ]
    .map((value: unknown) => String(value ?? "").trim())
    .filter(Boolean);
  return effectiveTeamMessages.some((message) => {
    const targetIds = normalizeDirectedMessageTargets(message);
    if (targetIds.length === 0) {
      return false;
    }
    if (targetIds.some((targetId) => coordinatorIds.includes(targetId))) {
      return true;
    }
    const subgoalIds = normalizeDirectedMessageSubgoalIds(message) ?? [];
    if (subgoalIds.length === 0) {
      return false;
    }
    const ownerIds = subgoalIds
      .map((subgoalId) => session.canonicalSubgoalForId(subgoalId))
      .map((subgoal) => String(subgoal?.assigneeAgentId ?? "").trim())
      .filter(Boolean);
    return targetIds.some((targetId) => ownerIds.includes(targetId));
  });
}

function ownsAnyStage(agent: any, stages: string[]): boolean {
  const ownedStages = Array.isArray(agent?.preset?.policy?.ownedStages) ? agent.preset.policy.ownedStages : [];
  return stages.some((stage) => ownedStages.includes(stage));
}

export async function drainAgent(session: any, agentId: string): Promise<void> {
  const agent = session.agents.get(agentId);
  if (!agent || agent.draining || agent.snapshot.status === "error" || agent.snapshot.status === "starting" || agent.snapshot.status === "stopped") {
    return;
  }
  if (!hasPendingDigest(agent.pendingDigest) && !session.goalBoardNeedsAttention(agent)) {
    return;
  }
  if (agent.preset.maxTurns > 0 && agent.snapshot.turnCount >= agent.preset.maxTurns) {
    return;
  }
  if (session.shouldDeferAgent(agent)) {
    session.clearDeferredPending(agent);
    session.updateAgentSnapshot(agentId, { status: "idle" });
    return;
  }

  agent.draining = true;
  const digest = agent.pendingDigest;
  agent.pendingDigest = emptyPendingDigest();
  agent.inFlightDigest = digest;
  agent.inFlightSubgoalRefs = session.captureTrackedSubgoalRefs(agent);
  agent.snapshot.pendingSignals = 0;
  session.updateAgentSnapshot(agentId, { status: "running" });
  const transcript = session.buildTranscript(agent, digest);
  const digestSummary = buildTriggerSummary(digest);
  const ownsRoutingStages = ownsAnyStage(agent, ["ready_for_build", "blocked"]);
  const triggerSections = ownsRoutingStages
    ? [
        "Goal board overview:",
        session.buildGoalBoardSummary(agent),
        "",
        "Relevant subgoal memory for you:",
        session.buildRelevantSubgoalSummary(agent, digest),
        "",
        "Actionable subgoals for you:",
        session.buildActionableSubgoalSummary(agent),
        "",
        "Message triggers for this turn:",
        digestSummary || "(no new message triggers)",
      ]
    : [
        "Relevant subgoal memory for you:",
        session.buildRelevantSubgoalSummary(agent, digest),
        "",
        "Actionable subgoals for you:",
        session.buildActionableSubgoalSummary(agent),
        "",
        "Message triggers for this turn:",
        digestSummary || "(no new message triggers)",
      ];
  const triggerSummary = triggerSections.join("\n");

  try {
    const result = await agent.process.runTurn(session.goal, transcript, triggerSummary);
    applyTurnResult(session, agentId, result, maxDigestSequence(digest), agent.inFlightSubgoalRefs);
  } catch (error) {
    const message = String((error as Error).message || "");
    if (message.includes("Codex run stopped") && agent.interruptReason) {
      return;
    }
    if ((session.status === "stopping" || session.status === "stopped") && message.includes("Codex run stopped")) {
      return;
    }
    if (session.shouldRetryTransientTurnFailure(message) && agent.retryCount < TRANSIENT_TURN_RETRY_LIMIT) {
      agent.retryCount += 1;
      session.restoreFailedInFlightDigest(agent, digest);
      agent.snapshot.status = "idle";
      agent.snapshot.waitingForInput = false;
      agent.snapshot.lastError = "";
      agent.snapshot.lastResponseAt = nowIso();
      agent.snapshot.workingNotes = [
        `Transient Codex turn failure, retrying ${agent.retryCount}/${TRANSIENT_TURN_RETRY_LIMIT}: ${shortenText(message, 240)}`,
      ];
      agent.snapshot.teamMessages = [];
      session.appendAgentHistory(agent, "notes", agent.snapshot.workingNotes[0], `Retry ${agent.retryCount}`);
      session.persistAgent(agentId);
      session.emit({ type: "agent", sessionId: session.id, agent: { ...agent.snapshot } });
      return;
    }
    agent.retryCount = 0;
    applyTurnResult(session, agentId, {
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
    if (hasPendingDigest(agent.pendingDigest) && session.status !== "stopped") {
      session.scheduleAgentDrain(agentId, true);
    } else if (session.status === "running") {
      const pendingGoalBoardAgent = [...session.agents.values()].find((entry) => !entry.draining && session.goalBoardNeedsAttention(entry));
      if (pendingGoalBoardAgent) {
        session.scheduleAgentDrain(pendingGoalBoardAgent.preset.id, true);
      } else if ([...session.agents.values()].every((entry) => !entry.draining && !hasPendingDigest(entry.pendingDigest))) {
        session.status = "idle";
        session.persistSession();
        session.emit({ type: "session", sessionId: session.id, snapshot: session.snapshot() });
      }
    }
  }
}

export function applyTurnResult(session: any, agentId: string, result: any, consumedSequence = 0, inFlightSubgoalRefs: any[] | null = null): void {
  const agent = session.agents.get(agentId);
  if (!agent) {
    return;
  }
  agent.retryCount = 0;
  const normalizedResult = result;
  const parsedRawTeamMessages = Array.isArray(normalizedResult.teamMessages)
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
  const reviewerReopenRewrite = rewriteReviewerReopenSuggestions(session, agentId, agent, normalizedResult, parsedRawTeamMessages);
  const rawTeamMessages = reviewerReopenRewrite.teamMessages;
  normalizedResult.subgoalUpdates = reviewerReopenRewrite.subgoalUpdates;
  const requestedReply = Boolean(normalizedResult.shouldReply);
  const obsoleteConflicts = session.buildObsoleteTurnConflicts(agentId, inFlightSubgoalRefs);
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
  const obsoleteChangedIds = shouldSuppressObsoleteTurn ? session.recordSubgoalConflicts(obsoleteConflicts) : [];
  const subgoalResult = shouldSuppressObsoleteTurn
    ? { changedIds: obsoleteChangedIds, stateChangedIds: obsoleteChangedIds, discussionChangedIds: [], blockedBuildPromotion: false, conflicts: [] }
    : session.applySubgoalUpdates(agentId, normalizedResult.subgoalUpdates);
  const changedSubgoalIds = [...new Set([...subgoalResult.changedIds, ...obsoleteConflicts.map((conflict) => conflict.subgoalId)])];
  const conflictOnlyIds = new Set([
    ...subgoalResult.conflicts.map((conflict) => conflict.subgoalId),
    ...obsoleteConflicts.map((conflict) => conflict.subgoalId),
  ]);
  const actualStateChangeIds = (Array.isArray(subgoalResult.stateChangedIds) ? subgoalResult.stateChangedIds : subgoalResult.changedIds)
    .filter((id) => !conflictOnlyIds.has(id));
  const referencedSubgoalIds = session.referencedSubgoalIds(changedSubgoalIds, normalizedResult.subgoalUpdates, inFlightSubgoalRefs);
  if (!shouldSuppressObsoleteTurn) {
    agent.snapshot.lastSeenSubgoalRevision = session.subgoalRevision;
    agent.snapshot.lastSeenActionableSignature = session.actionableSubgoalSignature(agent);
    agent.snapshot.lastSeenRoutingSignature = session.routingAttentionSignature(agent);
  }
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
  const reviewerId = session.defaultAssigneeForStage("ready_for_review");
  const builderId = session.defaultAssigneeForStage("building");
  const routingOwnerIds = [
    session.defaultAssigneeForStage("ready_for_build"),
    session.defaultAssigneeForStage("blocked"),
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
  const materializeTeamMessage = (message: any): any => {
    const effectiveSubgoalIds = session.resolveDirectedMessageSubgoalIds(message, referencedSubgoalIds);
    const hadExplicitTargets = normalizeDirectedMessageTargets(message).length > 0;
    const normalizedTargetAgentIds = [...new Set(
      normalizeDirectedMessageTargets(message)
        .map((value) => String(value ?? "").trim())
        .filter((value) => value && value !== agentId && session.agents.has(value)),
    )];
    const restrictedTargetAgentIds = allowedTargetSet.size > 0
      ? normalizedTargetAgentIds.filter((value) => allowedTargetSet.has(value))
      : normalizedTargetAgentIds;
    const peerDeferredTargetAgentIds = session.applyPeerContextTargetDeferral(agent, restrictedTargetAgentIds);
    let effectiveTargetAgentIds = session.shouldForceBroadcastOnFirstTurn(agent) ? [] : peerDeferredTargetAgentIds;
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
      const target = session.agents.get(value);
      if (!target) {
        return false;
      }
      const listensToChannel = Array.isArray(target.preset.listenChannels) && target.preset.listenChannels.includes(agent.preset.publishChannel);
      if (!listensToChannel) {
        return false;
      }
      if (!session.requiresGoalBoardOwnership(target)) {
        return true;
      }
      return session.goalBoardNeedsAttention(target);
    });
    if (hadExplicitTargets && effectiveTargetAgentIds.length === 0) {
      return null;
    }
    return {
      content: message.content,
      ...(effectiveTargetAgentIds.length === 1 ? { targetAgentId: effectiveTargetAgentIds[0] } : {}),
      ...(effectiveTargetAgentIds.length > 0 ? { targetAgentIds: effectiveTargetAgentIds } : { targetAgentIds: [] }),
      subgoalIds: effectiveSubgoalIds,
    };
  };
  let effectiveTeamMessages = normalizedResult.shouldReply && !shouldSuppressObsoleteTurn
    ? rawTeamMessages
        .map((message) => materializeTeamMessage(message))
        .filter(Boolean)
    : [];
  const hasEscalatedTargetedMessage = hasTargetedCoordinatorOrOwnerMessage(session, effectiveTeamMessages);
  if (
    session.isDiscoveryOwner(agentId) &&
    !session.hasOperatorOverride(agent) &&
    !session.currentTurnHasTargetedRequest(agent) &&
    session.actionableSubgoalsForAgent(agent).length === 0 &&
    (!Array.isArray(normalizedResult.subgoalUpdates) || normalizedResult.subgoalUpdates.length === 0) &&
    !hasEscalatedTargetedMessage
  ) {
    normalizedResult.shouldReply = false;
    effectiveTeamMessages = [];
    normalizedResult.workingNotes = [];
  }
  effectiveTeamMessages = effectiveTeamMessages.filter((message) =>
    !shouldSuppressDuplicateCoordinationTurn(session, agent, normalizeDirectedMessageSubgoalIds(message) ?? [], normalizeDirectedMessageTargets(message))
  );
  if (normalizedResult.shouldReply && effectiveTeamMessages.length === 0) {
    normalizedResult.shouldReply = false;
  }
  if (ownsReviewStageOnly && requestedStages.has("done") && effectiveTeamMessages.every((message) => normalizeDirectedMessageTargets(message).length === 0)) {
    normalizedResult.shouldReply = false;
    effectiveTeamMessages = [];
  }
  const notesOnlyOperatorReply =
    requestedReply &&
    hasTargetedOperatorRequest(agent) &&
    !shouldSuppressObsoleteTurn &&
    effectiveTeamMessages.length === 0 &&
    normalizedResult.workingNotes.length > 0;
  const notesOnlyTargetedReply =
    requestedReply &&
    hasTargetedRequest(agent) &&
    !shouldSuppressObsoleteTurn &&
    effectiveTeamMessages.length === 0 &&
    normalizedResult.workingNotes.length > 0;

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
    session.appendAgentHistory(agent, "notes", normalizedResult.workingNotes.join("\n"), `Turn ${agent.snapshot.turnCount}`);
  }
  effectiveTeamMessages.forEach((message, index) => {
    const targetIds = normalizeDirectedMessageTargets(message);
    const prefix = targetIds.length > 0 ? `[target ${targetIds.join(", ")}] ` : "";
    const subgoalIds = normalizeDirectedMessageSubgoalIds(message) ?? [];
    const subgoalPrefix = subgoalIds.length > 0 ? `[${subgoalIds.join(", ")}] ` : "";
    session.appendAgentHistory(agent, "messages", `${subgoalPrefix}${prefix}${message.content}`, `Turn ${agent.snapshot.turnCount}${effectiveTeamMessages.length > 1 ? ` #${index + 1}` : ""}`);
  });

  session.persistAgent(agentId);
  session.persistSession();
  session.emit({ type: "agent", sessionId: session.id, agent: { ...agent.snapshot } });

  const statusSignature = notesOnlyOperatorReply
    ? `operator-reply|${agent.preset.id}|turn=${agent.snapshot.turnCount}`
    : notesOnlyTargetedReply
      ? `targeted-reply|${agent.preset.id}|turn=${agent.snapshot.turnCount}`
    : statusEventSignature(session, agent, actualStateChangeIds, normalizedResult.completion, subgoalResult.blockedBuildPromotion);
  const shouldPublishStatus =
    normalizedResult.workingNotes.length > 0 &&
    !shouldSuppressObsoleteTurn &&
    (
      notesOnlyTargetedReply ||
      normalizedResult.completion !== "continue" ||
      actualStateChangeIds.length > 0 ||
      subgoalResult.blockedBuildPromotion
    ) &&
    !shouldSuppressDuplicateStatusEvent(session, agent, statusSignature);
  if (shouldPublishStatus) {
    session.publish(agent.preset.name, "status", normalizedResult.workingNotes.join(" | "), {
      ...baseEventMetadata,
      ...(notesOnlyOperatorReply ? { shouldReply: requestedReply, operatorReplyEvent: true } : {}),
      ...(!notesOnlyOperatorReply && notesOnlyTargetedReply ? { shouldReply: requestedReply, targetedReplyEvent: true } : {}),
      ...(statusSignature ? { statusSignature } : {}),
    });
  }
    if (normalizedResult.shouldReply && effectiveTeamMessages.length > 0 && !shouldSuppressObsoleteTurn) {
    session.status = "running";
    for (const message of effectiveTeamMessages) {
      const targetIds = normalizeDirectedMessageTargets(message);
      const messageSubgoalIds = normalizeDirectedMessageSubgoalIds(message) ?? [];
      const eventMetadata = {
        ...baseEventMetadata,
        ...(messageSubgoalIds.length > 0 ? { subgoalIds: messageSubgoalIds } : {}),
        ...(targetIds.length === 1 ? { targetAgentId: targetIds[0] } : {}),
        ...(targetIds.length > 0 ? { targetAgentIds: targetIds } : {}),
        ...(canCanonicalizeSubgoal(session, agentId) && messageSubgoalIds.length > 0 && targetIds.length > 0
          ? { routingSignature: coordinationRoutingSignature(session, messageSubgoalIds, targetIds) }
          : {}),
      };
      session.publish(agent.preset.name, agent.preset.publishChannel, message.content, eventMetadata);
    }
  }
  const allConflicts = [...subgoalResult.conflicts, ...obsoleteConflicts];
  if (allConflicts.length > 0) {
    const groupedConflicts = new Map<string, { conflicts: any[]; targets: string[] }>();
    for (const conflict of allConflicts) {
      const key = conflict.subgoalId;
      const current = groupedConflicts.get(key) || { conflicts: [], targets: [] };
      current.conflicts.push(conflict);
      current.targets = [...new Set([...current.targets, ...conflictTargetIds(session, conflict, agentId)])];
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
      const hasReopenSuggestion = grouped.conflicts.some((conflict) => conflict.reason === "done_reopen_suggestion" || conflict.reason === "reopen_suggestion");
      const groupedConflictSignature = conflictBurstSignature(grouped.conflicts, grouped.targets);
      if (shouldSuppressConflictBurst(session, subgoalId, groupedConflictSignature)) {
        continue;
      }
      session.status = "running";
      session.publish(
        "system",
        session.operatorChannel(),
        onlyDoneSoftNotes
          ? `Stale note on ${subgoalId}: ${shortenText(conflictSummary, 320)}`
          : hasReopenSuggestion
            ? `Reopen suggestion on ${subgoalId}: ${shortenText(conflictSummary, 320)} Re-check whether the card should reopen upstream.`
            : shouldSuppressObsoleteTurn && hasObsoleteTurn && summarizeDirectedMessages(rawTeamMessages)
              ? `Conflict on ${subgoalId}: ${shortenText(conflictSummary, 320)} Suppressed stale handoff: ${shortenText(summarizeDirectedMessages(rawTeamMessages), 220)} Re-read the latest goal board before changing this subgoal again.`
              : `Conflict on ${subgoalId}: ${shortenText(conflictSummary, 320)} Re-read the latest goal board before changing this subgoal again.`,
        {
          operatorEvent: true,
          conflictEvent: !onlyDoneSoftNotes && !hasReopenSuggestion,
          staleNoteEvent: onlyDoneSoftNotes,
          reopenSuggestionEvent: hasReopenSuggestion,
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
    session.status = "running";
    session.pingGoalBoardOwners();
  }
}
