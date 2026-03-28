// @ts-nocheck
import { compactWhitespace } from "./helpers";

export function coordinationRoutingSignature(session: any, subgoalIds: string[], targetAgentIds: string[]): string | null {
  const normalizedSubgoalIds = [...new Set(subgoalIds.map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
  const normalizedTargets = [...new Set(targetAgentIds.map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
  if (normalizedSubgoalIds.length === 0 || normalizedTargets.length === 0) {
    return null;
  }
  const subgoalParts = normalizedSubgoalIds.map((id) => {
    const subgoal = session.canonicalSubgoalForId(id);
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

export function subgoalStateSignature(session: any, subgoalIds: string[]): string | null {
  const normalizedSubgoalIds = [...new Set(subgoalIds.map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
  if (normalizedSubgoalIds.length === 0) {
    return null;
  }
  const parts = normalizedSubgoalIds.map((id) => {
    const subgoal = session.canonicalSubgoalForId(id);
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

export function statusEventSignature(
  session: any,
  agent: any,
  changedSubgoalIds: string[],
  completion: string,
  blockedBuildPromotion: boolean,
): string | null {
  if (completion === "continue" && changedSubgoalIds.length === 0 && !blockedBuildPromotion) {
    return null;
  }
  const stateSignature = subgoalStateSignature(session, changedSubgoalIds) || "-";
  return `${agent.preset.id}|${completion}|blocked_build=${blockedBuildPromotion ? "1" : "0"}|subgoals=${stateSignature}`;
}

export function shouldSuppressDuplicateStatusEvent(session: any, agent: any, signature: string | null): boolean {
  if (!signature) {
    return false;
  }
  for (let index = session.recentEvents.length - 1; index >= 0; index -= 1) {
    const event = session.recentEvents[index];
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

export function researchNoteSignature(session: any, agent: any, subgoalIds: string[], targetAgentIds: string[]): string | null {
  if (!session.isDiscoveryOwner(agent.preset.id)) {
    return null;
  }
  const stateSignature = subgoalStateSignature(session, subgoalIds);
  if (!stateSignature) {
    return null;
  }
  const normalizedTargets = [...new Set(targetAgentIds.map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
  return `${agent.preset.id}|targets=${normalizedTargets.join(",") || "-"}|subgoals=${stateSignature}`;
}

export function shouldSuppressRepeatedResearchNote(
  session: any,
  agent: any,
  subgoalIds: string[],
  targetAgentIds: string[],
  hasActualStateChange: boolean,
): boolean {
  if (hasActualStateChange || !session.isDiscoveryOwner(agent.preset.id)) {
    return false;
  }
  const signature = researchNoteSignature(session, agent, subgoalIds, targetAgentIds);
  if (!signature) {
    return false;
  }
  for (let index = session.recentEvents.length - 1; index >= 0; index -= 1) {
    const event = session.recentEvents[index];
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

export function conflictBurstSignature(conflicts: any[], targetAgentIds: string[]): string | null {
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

export function shouldSuppressConflictBurst(session: any, subgoalId: string, signature: string | null): boolean {
  if (!signature) {
    return false;
  }
  for (let index = session.recentEvents.length - 1; index >= 0; index -= 1) {
    const event = session.recentEvents[index];
    if (event.sender !== "system" || event.channel !== session.operatorChannel()) {
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

export function shouldSuppressDuplicateCoordinationTurn(session: any, agent: any, subgoalIds: string[], targetAgentIds: string[]): boolean {
  if (!session.canCanonicalizeSubgoal(agent.preset.id)) {
    return false;
  }
  const signature = coordinationRoutingSignature(session, subgoalIds, targetAgentIds);
  if (!signature) {
    return false;
  }
  for (let index = session.recentEvents.length - 1; index >= 0; index -= 1) {
    const event = session.recentEvents[index];
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

export function canCanonicalizeSubgoal(session: any, agentId: string): boolean {
  return session.coordinationOwnerIds().includes(agentId);
}
