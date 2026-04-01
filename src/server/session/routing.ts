// @ts-nocheck
import { extractTargetAgentIds, compactWhitespace, shortenText, formatTargetSuffix } from "./helpers";
import { digestSequences } from "./digest";

export function latestGoalSequence(session: any): number {
  for (let index = session.recentEvents.length - 1; index >= 0; index -= 1) {
    if (session.isGoalEvent(session.recentEvents[index])) {
      return session.recentEvents[index].sequence;
    }
  }
  return 0;
}

export function eventsSinceGoalForChannels(session: any, channels: string[]): any[] {
  const normalizedChannels = [...new Set(channels.map((channel) => String(channel ?? "").trim()).filter(Boolean))];
  if (normalizedChannels.length === 0) {
    return [];
  }
  const goalSequence = latestGoalSequence(session);
  return session.recentEvents.filter(
    (event: any) =>
      event.sequence > goalSequence &&
      event.sender !== "system" &&
      normalizedChannels.includes(event.channel),
  );
}

export function hasChannelActivitySinceGoal(session: any, channels: string[]): boolean {
  return eventsSinceGoalForChannels(session, channels).length > 0;
}

export function discoveryChannels(session: any): Set<string> {
  return new Set(
    session.config.agents
      .filter((entry: any) => Array.isArray(entry.policy?.ownedStages) && (entry.policy.ownedStages.includes("open") || entry.policy.ownedStages.includes("researching")))
      .map((entry: any) => entry.publishChannel),
  );
}

export function meetsActivationPolicy(session: any, agent: any): boolean {
  return session.goalBoardNeedsAttention(agent);
}

export function shouldIgnoreCompletedAgent(session: any, agent: any, event: any): boolean {
  if (agent.snapshot.completion !== "done") {
    return false;
  }
  const targetIds = extractTargetAgentIds(event.metadata);
  if (targetIds.includes(agent.preset.id)) {
    return false;
  }
  if (session.isGoalEvent(event) || session.isOperatorEvent(event)) {
    return false;
  }
  return !session.goalBoardNeedsAttention(agent);
}

export function currentTurnHasTargetedRequest(session: any, agent: any): boolean {
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
  return events.some((event: any) => extractTargetAgentIds(event.metadata).includes(agent.preset.id));
}

export function hasOperatorOverride(session: any, agent: any): boolean {
  return (
    agent.pendingDigest.operatorEvents.length > 0 ||
    agent.pendingDigest.directInputs.length > 0 ||
    Boolean(agent.inFlightDigest && (agent.inFlightDigest.operatorEvents.length > 0 || agent.inFlightDigest.directInputs.length > 0))
  );
}

export function applyPeerContextTargetDeferral(session: any, agent: any, targetAgentIds: string[]): string[] {
  return targetAgentIds;
}

export function shouldForceBroadcastOnFirstTurn(session: any, agent: any): boolean {
  if (!agent.preset.policy.forceBroadcastOnFirstTurn) {
    return false;
  }
  if (hasOperatorOverride(session, agent)) {
    return false;
  }
  return agent.snapshot.turnCount === 0;
}

export function shouldDeferAgent(session: any, agent: any): boolean {
  if (hasOperatorOverride(session, agent)) {
    return false;
  }
  if (session.requiresGoalBoardOwnership(agent) && !session.goalBoardNeedsAttention(agent)) {
    return true;
  }
  if (currentTurnHasTargetedRequest(session, agent)) {
    return false;
  }
  if (agent.pendingDigest?.totalCount > 0) {
    return false;
  }
  return !meetsActivationPolicy(session, agent);
}

export function transcriptEventLimit(session: any, agent: any): number {
  const configured = Math.max(1, Number(session.config.defaults.historyTail || 0) || 1);
  const ownedStages = Array.isArray(agent.preset.policy?.ownedStages) ? agent.preset.policy.ownedStages : [];
  const ownsRoutingStages = ownedStages.includes("ready_for_build") || ownedStages.includes("blocked");
  const ownsImplementationStages = ownedStages.includes("building") || ownedStages.includes("ready_for_review");
  return Math.min(configured, ownsRoutingStages ? 6 : ownsImplementationStages ? 3 : 4);
}

export function transcriptCharLimit(session: any, agent: any): number {
  const ownedStages = Array.isArray(agent.preset.policy?.ownedStages) ? agent.preset.policy.ownedStages : [];
  const ownsRoutingStages = ownedStages.includes("ready_for_build") || ownedStages.includes("blocked");
  return ownsRoutingStages ? 170 : 140;
}

export function transcriptChannels(session: any, agent: any): Set<string> {
  return new Set<string>([session.goalChannel(), session.operatorChannel(), ...agent.preset.listenChannels]);
}

export function buildTranscript(session: any, agent: any, digest: any): string {
  const goalSequence = latestGoalSequence(session);
  const allowedChannels = transcriptChannels(session, agent);
  const skipSequences = digestSequences(digest);
  const events = session.recentEvents
    .filter((event: any) => {
      const targetIds = extractTargetAgentIds(event.metadata);
      const isTargetedTeamMessage = !session.isOperatorEvent(event) && targetIds.length > 0;
      if (event.sender === agent.preset.name) {
        return false;
      }
      if (event.channel === "status" || event.channel === "system") {
        return false;
      }
      if (!isTargetedTeamMessage && !allowedChannels.has(event.channel)) {
        return false;
      }
      if (session.isOperatorEvent(event) && targetIds.length > 0 && !targetIds.includes(agent.preset.id)) {
        return false;
      }
      if (goalSequence > 0 && event.sequence < goalSequence) {
        return false;
      }
      if (skipSequences.has(event.sequence)) {
        return false;
      }
      return true;
    })
    .slice(-transcriptEventLimit(session, agent));

  if (events.length === 0) {
    return "(no prior transcript)";
  }

  return events
    .map((event: any) => {
      const targetText = formatTargetSuffix(event.metadata);
      return `#${event.sequence} ${event.sender} -> ${event.channel}${targetText}: ${shortenText(event.content, transcriptCharLimit(session, agent))}`;
    })
    .join("\n");
}
