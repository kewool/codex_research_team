// @ts-nocheck
import { shortenText } from "./helpers";
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

export function relevantSubgoalsForAgent(session: any, agent: any): any[] {
  const actionable = actionableSubgoalsForAgent(session, agent);
  const ownedStages = Array.isArray(agent.preset.policy?.ownedStages) ? agent.preset.policy.ownedStages : [];
  const ownsDiscoveryStages = ownedStages.includes("open") || ownedStages.includes("researching");
  const ownsRoutingStages = ownedStages.includes("ready_for_build") || ownedStages.includes("blocked");
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
  if (ownsDiscoveryStages) {
    for (const subgoal of activeSubgoals(session)) {
      if (subgoal.decisionState === "disputed" || subgoal.activeConflict || subgoal.assigneeAgentId === agent.preset.id) {
        push(subgoal);
      }
    }
  } else if (ownsRoutingStages) {
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
    .slice(0, ownsDiscoveryStages || ownsRoutingStages ? 4 : 2);
}

export function goalBoardNeedsAttention(session: any, agent: any): boolean {
  if (actionableSubgoalsForAgent(session, agent).length === 0) {
    return false;
  }
  return Number(agent.snapshot.lastSeenSubgoalRevision || 0) < session.subgoalRevision;
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

export function buildRelevantSubgoalSummary(session: any, agent: any): string {
  const relevant = relevantSubgoalsForAgent(session, agent);
  if (relevant.length === 0) {
    return "(none)";
  }
  return relevant
    .map((subgoal: any) => {
      const lines = [
        `- ${shortenText(subgoal.title, 100)} (${subgoal.id}) rev=${subgoal.revision} [${subgoal.stage}] decision=${subgoal.decisionState}${subgoal.assigneeAgentId ? ` assignee=${subgoal.assigneeAgentId}` : ""}`,
        `  summary: ${shortenText(subgoal.summary, 180)}`,
      ];
      if (subgoal.facts.length > 0) {
        lines.push(`  facts: ${subgoal.facts.map((item: string) => shortenText(item, 120)).join(" | ")}`);
      }
      if (subgoal.openQuestions.length > 0) {
        lines.push(`  open_questions: ${subgoal.openQuestions.map((item: string) => shortenText(item, 120)).join(" | ")}`);
      }
      if (subgoal.resolvedDecisions.length > 0) {
        lines.push(`  resolved: ${subgoal.resolvedDecisions.map((item: string) => shortenText(item, 120)).join(" | ")}`);
      }
      if (subgoal.acceptanceCriteria.length > 0) {
        lines.push(`  acceptance: ${subgoal.acceptanceCriteria.map((item: string) => shortenText(item, 120)).join(" | ")}`);
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

export function pingGoalBoardOwners(session: any): void {
  for (const agent of session.agents.values()) {
    if (!goalBoardNeedsAttention(session, agent) || agent.draining || agent.snapshot.status === "starting" || session.status === "stopped") {
      continue;
    }
    session.scheduleAgentDrain(agent.preset.id, true);
  }
}
