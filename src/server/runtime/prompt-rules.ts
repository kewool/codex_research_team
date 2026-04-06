// @ts-nocheck
import { AgentPreset } from "../../shared/types";
import { normalizePath } from "../lib/utils";

export function operatingModeLines(agent: AgentPreset): string[] {
  const customLines = Array.isArray(agent.policy?.promptGuidance)
    ? agent.policy.promptGuidance.map((line) => `- ${String(line ?? "").trim()}`).filter((line) => line !== "-")
    : [];
  if (customLines.length > 0) {
    return customLines;
  }
  return [
    "- Work according to your standing brief and the current trigger.",
    "- Use your configured channels and the visible team transcript to decide what to publish or who to target next.",
  ];
}

export function workspaceGuardrailLines(workspacePath: string): string[] {
  const normalizedWorkspacePath = normalizePath(workspacePath);
  return [
    `- Your allowed working scope is the selected workspace only: ${normalizedWorkspacePath}. Treat paths outside this workspace as out-of-scope.`,
    "- Use filesystem writes only for this workspace. Do not create, modify, delete, or publish files outside it, and keep outputs workspace-relative.",
    "- Do not treat synthetic write probes as proof that the workspace is blocked; prefer the normal edit/apply path for actionable work.",
    "- Do not open or dump raw binary/media files directly.",
    "- Prefer targeted reads and small samples over broad scans, full structured-data loads, or repeated rereads of unchanged large files.",
    "- Reuse already-established aggregates from the transcript or goal board instead of recomputing them.",
  ];
}

export function routingGuidanceLines(agent: AgentPreset, allAgents: AgentPreset[]): string[] {
  const agentIds = allAgents.map((entry) => entry.id).join(", ");
  const lines = [
    `- Available agent ids for targeted team messages: ${agentIds}.`,
    "- Inside each teamMessages entry, you may optionally set targetAgentId for one recipient or targetAgentIds for multiple recipients. Leave them empty to broadcast normally.",
    "- Use targeted messages only when one or more specific agents need to act. Otherwise broadcast to the team channel you publish on.",
  ];
  const allowedTargets = Array.isArray(agent.policy?.allowedTargetAgentIds)
    ? agent.policy.allowedTargetAgentIds.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
  if (allowedTargets.length > 0) {
    lines.push(`- If you target another agent, you may only target these agent ids: ${allowedTargets.join(", ")}.`);
  }
  return lines;
}

export function sharedTurnProtocolLines(): string[] {
  return [
    "- Only give public working notes. Do not expose hidden reasoning.",
    "- The top-level session goal is not itself a subgoal. Create or update subgoals only for durable topic, contract, or handoff changes.",
    "- Use subgoalUpdates only when canonical board state or durable subgoal memory changed. Commentary, objections, and extra evidence can stay in teamMessages.",
    "- Split unrelated handoffs into separate teamMessages and set subgoalIds only for the specific card each message is about.",
    "- Prefer shouldReply=false when you learned nothing decision-changing and no action owner needs to change.",
    "- Use completion=\"done\" only when your branch is genuinely exhausted until a new goal, operator instruction, implementation change, or targeted request arrives.",
    "- Use subgoal stages consistently: open/researching for discovery, ready_for_build for routing-ready research, building for active implementation, ready_for_review for audit, done for accepted work, blocked for real blockers.",
  ];
}

function ownsAnyStage(agent: AgentPreset, stages: string[]): boolean {
  const ownedStages = Array.isArray(agent.policy?.ownedStages) ? agent.policy.ownedStages : [];
  return stages.some((stage) => ownedStages.includes(stage));
}

export function roleSpecificPromptLines(agent: AgentPreset): string[] {
  if (ownsAnyStage(agent, ["ready_for_build", "blocked"])) {
    return [
      "- You are the routing owner. Keep the full board coherent, merge or reroute only when the actual contract changes, and avoid repeating the same handoff when routing is unchanged.",
    ];
  }
  if (ownsAnyStage(agent, ["building"])) {
    return [
      "- Start from the subgoal's relevantFiles and the directly related implementation/test files. Expand outward only when the current card cannot be resolved from that local slice.",
      "- If one file starts carrying too many responsibilities, split or extract it as part of the implementation instead of letting the card sprawl further.",
    ];
  }
  if (ownsAnyStage(agent, ["ready_for_review"])) {
    return [
      "- Audit the subgoal's relevantFiles, changed files, and directly related tests first. Only widen the review scope when the local evidence is insufficient.",
    ];
  }
  if (ownsAnyStage(agent, ["open", "researching"])) {
    return [
      "- Stay on your current research card or direct targets. Do not reread unrelated disputed cards unless the trigger explicitly points to them.",
      "- Prefer narrow probes, existing artifacts, and append-only evidence over broad rediscovery of the same topic.",
    ];
  }
  return [];
}
