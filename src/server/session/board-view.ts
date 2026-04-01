// @ts-nocheck
import { extractTargetAgentIds, normalizeDirectedMessageSubgoalIds, shortenText } from "./helpers";
import { activeSubgoals } from "./subgoals";

export function actionableSubgoalsForAgent(session: any, agent: any): any[] {
  const ownedStages = Array.isArray(agent.preset.policy?.ownedStages) ? agent.preset.policy.ownedStages : [];
  if (ownedStages.length === 0) {
    return [];
  }
  return activeSubgoals(session).filter((subgoal: any) => {
    if (!ownedStages.includes(subgoal.stage)) {
      return false;
    }
    if (subgoal.assigneeAgentId && subgoal.assigneeAgentId !== agent.preset.id) {
      return false;
    }
    return true;
  });
}

export function actionableSubgoalSignature(session: any, agent: any): string | null {
  const actionable = actionableSubgoalsForAgent(session, agent);
  if (actionable.length === 0) {
    return null;
  }
  return actionable
    .map((subgoal: any) => [
      String(subgoal.id ?? "").trim(),
      String(subgoal.stage ?? "").trim(),
      String(subgoal.decisionState ?? "").trim(),
      String(subgoal.assigneeAgentId ?? "-").trim() || "-",
      String(Number(subgoal.revision || 0)),
    ].join(":"))
    .sort()
    .join("|");
}

export function routingAttentionSignature(session: any, agent: any): string | null {
  if (!isRoutingOwner(agent)) {
    return null;
  }
  const routingRelevant = activeSubgoals(session).filter((subgoal: any) =>
    ["ready_for_build", "blocked", "building", "ready_for_review", "done"].includes(String(subgoal.stage ?? "").trim()),
  );
  if (routingRelevant.length === 0) {
    return null;
  }
  return routingRelevant
    .map((subgoal: any) => [
      String(subgoal.id ?? "").trim(),
      String(subgoal.stage ?? "").trim(),
      String(subgoal.decisionState ?? "").trim(),
      String(subgoal.assigneeAgentId ?? "-").trim() || "-",
      String(Number(subgoal.revision || 0)),
    ].join(":"))
    .sort()
    .join("|");
}

function ownsAnyStage(agent: any, stages: string[]): boolean {
  const ownedStages = Array.isArray(agent.preset.policy?.ownedStages) ? agent.preset.policy.ownedStages : [];
  return stages.some((stage) => ownedStages.includes(stage));
}

function isRoutingOwner(agent: any): boolean {
  return ownsAnyStage(agent, ["ready_for_build", "blocked"]);
}

function isDiscoveryOwner(agent: any): boolean {
  return ownsAnyStage(agent, ["open", "researching"]);
}

function relevantSubgoalIdsFromDigest(session: any, agent: any, digest: any): string[] {
  const events = [
    ...(digest?.latestGoal ? [digest.latestGoal] : []),
    ...(Array.isArray(digest?.operatorEvents) ? digest.operatorEvents : []),
    ...(Array.isArray(digest?.directInputs) ? digest.directInputs : []),
    ...Object.values(digest?.channelEvents ?? {}).flat(),
    ...(Array.isArray(digest?.otherEvents) ? digest.otherEvents : []),
  ];
  const ids = new Set<string>();
  for (const event of events) {
    const targetIds = extractTargetAgentIds(event?.metadata);
    if (targetIds.length > 0 && !targetIds.includes(agent.preset.id)) {
      continue;
    }
    const rawIds = normalizeDirectedMessageSubgoalIds(event?.metadata);
    for (const subgoalId of Array.isArray(rawIds) ? rawIds : []) {
      const canonical = session.canonicalSubgoalForId(subgoalId);
      if (canonical?.id) {
        ids.add(canonical.id);
      }
    }
  }
  return [...ids];
}

export function relevantSubgoalsForAgent(session: any, agent: any, digest: any = null): any[] {
  const actionable = actionableSubgoalsForAgent(session, agent);
  const candidates = new Map<string, any>();
  const push = (subgoal: any | null | undefined): void => {
    if (!subgoal?.id) {
      return;
    }
    candidates.set(subgoal.id, subgoal);
  };

  for (const subgoal of actionable) {
    push(subgoal);
  }
  const targetedSubgoalIds = relevantSubgoalIdsFromDigest(session, agent, digest);
  for (const subgoalId of targetedSubgoalIds) {
    push(session.canonicalSubgoalForId(subgoalId));
  }
  if (isRoutingOwner(agent)) {
    for (const subgoal of activeSubgoals(session)) {
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
    .sort((left: any, right: any) => Number(right.revision || 0) - Number(left.revision || 0))
    .slice(0, isRoutingOwner(agent) ? 6 : isDiscoveryOwner(agent) ? 3 : 2);
}

export function goalBoardNeedsAttention(session: any, agent: any): boolean {
  if (isRoutingOwner(agent)) {
    const signature = routingAttentionSignature(session, agent);
    const previous = String(agent.snapshot.lastSeenRoutingSignature ?? "").trim() || null;
    return signature !== previous;
  }
  const signature = actionableSubgoalSignature(session, agent);
  if (!signature) {
    return false;
  }
  const previousEntries = new Set(
    String(agent.snapshot.lastSeenActionableSignature ?? "")
      .split("|")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const currentEntries = signature
    .split("|")
    .map((value) => value.trim())
    .filter(Boolean);
  return currentEntries.some((entry) => !previousEntries.has(entry));
}

export function buildGoalBoardSummary(session: any, agent: any): string {
  const subgoals = activeSubgoals(session);
  if (subgoals.length === 0) {
    return "(no subgoals yet)";
  }
  const actionableIds = new Set(actionableSubgoalsForAgent(session, agent).map((subgoal: any) => subgoal.id));
  return subgoals
    .map((subgoal: any) => {
      const assignee = subgoal.assigneeAgentId ? ` assignee=${subgoal.assigneeAgentId}` : "";
      const revision = ` rev=${subgoal.revision}`;
      const decision = ` decision=${subgoal.decisionState}`;
      const focus = actionableIds.has(subgoal.id) ? " focus=true" : "";
      const conflict = subgoal.activeConflict ? ` conflicts=${Math.max(1, Number(subgoal.conflictCount || 0))}` : "";
      const reopen = subgoal.lastReopenReason ? " reopen=true" : "";
      return `- ${shortenText(subgoal.title, 90)} (${subgoal.id})${revision} [${subgoal.stage}]${decision}${assignee}${focus}${conflict}${reopen}`;
    })
    .join("\n");
}

export function buildActionableSubgoalSummary(session: any, agent: any): string {
  const actionable = actionableSubgoalsForAgent(session, agent);
  if (actionable.length === 0) {
    return "(none)";
  }
  return actionable
    .map((subgoal: any) => {
      const conflict = subgoal.activeConflict && subgoal.lastConflictSummary
        ? ` !! conflict: ${shortenText(subgoal.lastConflictSummary, 120)}`
        : "";
      const reopen = subgoal.lastReopenReason ? ` reopen=${shortenText(subgoal.lastReopenReason, 100)}` : "";
      return `- ${shortenText(subgoal.title, 100)} (${subgoal.id}) rev=${subgoal.revision} [${subgoal.stage}] decision=${subgoal.decisionState} :: ${shortenText(subgoal.summary, 140)}${conflict}${reopen}`;
    })
    .join("\n");
}

export function buildRelevantSubgoalSummary(session: any, agent: any, digest: any = null): string {
  const relevant = relevantSubgoalsForAgent(session, agent, digest);
  if (relevant.length === 0) {
    return "(none)";
  }
  return relevant
    .map((subgoal: any) => {
      const routingOwner = isRoutingOwner(agent);
      const buildOwner = ownsAnyStage(agent, ["building", "ready_for_review"]);
      const lines = [
        `- ${shortenText(subgoal.title, 100)} (${subgoal.id}) rev=${subgoal.revision} [${subgoal.stage}] decision=${subgoal.decisionState}${subgoal.assigneeAgentId ? ` assignee=${subgoal.assigneeAgentId}` : ""}`,
        `  summary: ${shortenText(subgoal.summary, 180)}`,
      ];
      if (subgoal.facts.length > 0 && !buildOwner) {
        lines.push(`  facts: ${subgoal.facts.slice(0, routingOwner ? 3 : 2).map((item: string) => shortenText(item, 120)).join(" | ")}`);
      }
      if (subgoal.openQuestions.length > 0) {
        lines.push(`  open_questions: ${subgoal.openQuestions.slice(0, 2).map((item: string) => shortenText(item, 120)).join(" | ")}`);
      }
      if (subgoal.resolvedDecisions.length > 0) {
        lines.push(`  resolved: ${subgoal.resolvedDecisions.slice(0, buildOwner ? 2 : 3).map((item: string) => shortenText(item, 120)).join(" | ")}`);
      }
      if (subgoal.acceptanceCriteria.length > 0) {
        lines.push(`  acceptance: ${subgoal.acceptanceCriteria.slice(0, 2).map((item: string) => shortenText(item, 120)).join(" | ")}`);
      }
      if (subgoal.relevantFiles.length > 0) {
        lines.push(`  files: ${subgoal.relevantFiles.slice(0, buildOwner ? 6 : 4).join(", ")}`);
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

export function pingGoalBoardOwners(session: any): void {
  for (const agent of session.agents.values()) {
    if (!goalBoardNeedsAttention(session, agent) || agent.draining || agent.snapshot.status === "starting" || session.status === "stopped") {
      continue;
    }
    session.scheduleAgentDrain(agent.preset.id, true);
  }
}
