// @ts-nocheck
import { nowIso } from "../lib/utils";
import { appendSessionEvent } from "../persistence/storage";
import { DRAIN_DEBOUNCE_MS, extractTargetAgentIds, RECENT_EVENT_LIMIT, shortenText } from "./helpers";
import { emptyPendingDigest, hasPendingDigest, mergePendingDigest, readSessionEvents } from "./digest";

export function publishEvent(session: any, sender: string, channel: string, content: string, metadata?: Record<string, unknown>): void {
  const event = {
    sequence: ++session.sequence,
    timestamp: nowIso(),
    sender,
    channel,
    content,
    metadata,
  };
  session.updatedAt = event.timestamp;
  session.recentEvents = [...session.recentEvents.slice(-(RECENT_EVENT_LIMIT - 1)), event];
  appendSessionEvent(session.files, event);
  routeEvent(session, event);
  session.persistSession();
  session.emit({ type: "event", sessionId: session.id, event, snapshot: session.snapshot() });
}

export function shouldRouteEventToAgent(session: any, agent: any, event: any): boolean {
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
    agent.preset.policy.ownedStages.every((stage: string) => stage === "ready_for_review");
  if (!session.isGoalEvent(event) && !session.isOperatorEvent(event) && targetIds.length === 0 && !ownsDiscoveryStages && session.discoveryChannels().has(event.channel)) {
    return false;
  }
  if (session.requiresGoalBoardOwnership(agent) && !session.isOperatorEvent(event) && !session.goalBoardNeedsAttention(agent)) {
    return false;
  }
  if (ownsOnlyReviewStage && !session.isOperatorEvent(event) && !session.goalBoardNeedsAttention(agent)) {
    return false;
  }
  if (session.shouldIgnoreCompletedAgent(agent, event)) {
    return false;
  }
  return true;
}

export function routeEvent(session: any, event: any): void {
  for (const agent of session.agents.values()) {
    if (!shouldRouteEventToAgent(session, agent, event)) {
      continue;
    }
    agent.pendingDigest = mergePendingDigest(agent.pendingDigest, event);
    agent.snapshot.pendingSignals = agent.pendingDigest.totalCount;
    const subgoalIds = Array.isArray(event?.metadata?.subgoalIds)
      ? event.metadata.subgoalIds.map((value: unknown) => String(value ?? "").trim()).filter(Boolean)
      : [];
    const targetIds = extractTargetAgentIds(event?.metadata);
    const timestamp = nowIso();
    const summaryParts = [
      `#${event.sequence}`,
      `${event.sender} -> ${event.channel}`,
      targetIds.length > 0 ? `target=${targetIds.join(",")}` : "",
      subgoalIds.length > 0 ? `subgoals=${subgoalIds.join(",")}` : "",
      shortenText(String(event.content ?? "").trim(), 120),
    ].filter(Boolean);
    agent.snapshot.lastWakeReason = `routed event ${summaryParts.join(" | ")}`;
    agent.snapshot.lastWakeAt = timestamp;
    agent.snapshot.lastRoutedEventSummary = summaryParts.join(" | ");
    agent.snapshot.lastRoutedEventAt = timestamp;
    session.persistAgent(agent.preset.id);
    session.scheduleAgentDrain(agent.preset.id);
  }
}

export function clearDeferredPending(session: any, agent: any): void {
  if (!session.requiresGoalBoardOwnership(agent)) {
    return;
  }
  if (session.hasOperatorOverride(agent)) {
    return;
  }
  if (session.goalBoardNeedsAttention(agent)) {
    return;
  }
  if (!hasPendingDigest(agent.pendingDigest)) {
    return;
  }
  agent.pendingDigest = emptyPendingDigest();
  agent.snapshot.pendingSignals = 0;
  session.persistAgent(agent.preset.id);
}

export function rebuildPendingDigestsFromHistory(session: any): void {
  const events = readSessionEvents(session.files.eventsJsonl);
  for (const agent of session.agents.values()) {
    agent.pendingDigest = emptyPendingDigest();
    agent.snapshot.pendingSignals = 0;
    const afterSequence = Number(agent.snapshot.lastConsumedSequence || 0);
    for (const event of events) {
      if (event.sequence <= afterSequence) {
        continue;
      }
      if (!shouldRouteEventToAgent(session, agent, event)) {
        continue;
      }
      agent.pendingDigest = mergePendingDigest(agent.pendingDigest, event);
    }
    agent.snapshot.pendingSignals = agent.pendingDigest.totalCount;
    session.persistAgent(agent.preset.id);
  }
}

export function scheduleAgentDrain(session: any, agentId: string, immediate = false): void {
  const agent = session.agents.get(agentId);
  if (!agent || session.status === "stopped" || agent.snapshot.status === "stopped") {
    return;
  }
  if (agent.drainTimer) {
    clearTimeout(agent.drainTimer);
    agent.drainTimer = null;
  }
  agent.drainTimer = setTimeout(() => {
    const runtime = session.agents.get(agentId);
    if (!runtime) {
      return;
    }
    runtime.drainTimer = null;
    if (session.status !== "stopped") {
      void session.drainAgent(agentId);
    }
  }, immediate ? 0 : DRAIN_DEBOUNCE_MS);
}
