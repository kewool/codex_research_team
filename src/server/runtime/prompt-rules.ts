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

export function sharedTurnProtocolLines(options?: { hasSessionStateTools?: boolean }): string[] {
  const lines = [
    "- Only give public working notes. Do not expose hidden reasoning.",
    "- The top-level session goal is not itself a subgoal. Create or update subgoals only for durable topic, contract, or handoff changes.",
    "- Distinct durable research axes should usually become separate subgoals first. Let the coordinator merge true duplicates later instead of forcing unrelated findings into one umbrella card.",
    "- A trivial rename is not a new axis. If an existing card already covers the same contract, deliverable, or owner handoff, reuse it instead of creating a second card with a slightly different title or topicKey.",
    "- Use subgoalUpdates only when canonical board state actually changed, and keep those updates to the canonical owner or coordinator path.",
    "- When you own a research card or route it as coordinator, write durable findings into the card itself. Use summary, addFacts, addOpenQuestions, addResolvedDecisions, addAcceptanceCriteria, addRelevantFiles, and nextAction instead of leaving the card empty while only writing notes.",
    "- Discussion is the default append-only same-card chat. Use append_subgoal_discussion for objections, peer debate, and incremental findings that do not change canonical state.",
    "- Use teamMessages for wakeups, handoffs, direct questions, routing changes, or when another agent must act now.",
    "- Split unrelated handoffs into separate teamMessages and set subgoalIds only for the specific card each message is about.",
    "- Prefer shouldReply=false when you learned nothing decision-changing and no action owner needs to change.",
    "- Use completion=\"done\" only when your branch is genuinely exhausted until a new goal, operator instruction, implementation change, or targeted request arrives.",
    "- Use subgoal stages consistently: open/researching for discovery, ready_for_build for routing-ready research, building for active implementation, ready_for_review for audit, done for accepted work, blocked for real blockers.",
  ];
  if (options?.hasSessionStateTools) {
    lines.push("- Session-state MCP tools are available. Call these tools directly by name: list_subgoals, get_subgoal, list_subgoal_discussion, append_subgoal_discussion, get_subgoal_conflicts, list_session_events, get_agent_history.");
    lines.push("- Do not call list_mcp_resources or list_mcp_resource_templates just to discover them, and do not guess a server name like 'session-state'.");
    lines.push("- Prompt summaries are compact indexes. Fetch live card, discussion, conflict, or event details on demand with those tools.");
  }
  return lines;
}

function ownsAnyStage(agent: AgentPreset, stages: string[]): boolean {
  const ownedStages = Array.isArray(agent.policy?.ownedStages) ? agent.policy.ownedStages : [];
  return stages.some((stage) => ownedStages.includes(stage));
}

export function roleSpecificPromptLines(agent: AgentPreset): string[] {
  if (ownsAnyStage(agent, ["ready_for_build", "blocked"])) {
    return [
      "- You are the routing owner. Keep canonical card state coherent and avoid repeating the same handoff when routing is unchanged.",
      "- You may create a new subgoal when researchers surface a distinct durable axis that is not yet represented on the board.",
      "- Reassign upstream ownership when one researcher is overloaded, stalled, or another researcher is better positioned to finish the current line of work.",
      "- Do not start by collapsing broad research into one umbrella card. Preserve separate cards for distinct research axes and merge only true duplicates or clear overlaps.",
      "- If two cards now describe the same contract or downstream handoff, merge them explicitly by setting mergedIntoSubgoalId on the source card. Do not keep both alive just because the title or topicKey wording drifted.",
      "- Same-title or near-identical contract cards are duplicates unless you can state a real boundary in deliverable, owner, acceptance, or next action. If you keep both, rewrite their summaries so the distinction is obvious.",
      "- When you keep a card upstream or move it downstream, update the card's canonical fields too. Do not rely on workingNotes or messages alone once the contract has durable facts, open questions, acceptance criteria, or relevant files.",
      "- Do not send a card downstream just because one researcher sounded confident. Check the card discussion and unresolved gaps first.",
      "- Do not leave a card's facts/open/resolved/acceptance/files empty after the team has already produced concrete findings. Materialize the current contract on the card before routing.",
      "- If a card lacks a clear owner handoff or the discussion does not show the main objections being addressed, keep it upstream and ask for the missing work.",
      "- Route build work only after the card is in building with the build owner assigned.",
    ];
  }
  if (ownsAnyStage(agent, ["building"])) {
    return [
      "- Start from the subgoal's relevantFiles and the directly related implementation/test files. Expand outward only when the current card cannot be resolved from that local slice.",
      "- If one file starts carrying too many responsibilities, split or extract it as part of the implementation instead of letting the card sprawl further.",
      "- If you need prior discussion details, pull only the relevant subgoal or event history with MCP tools instead of widening the default transcript.",
    ];
  }
  if (ownsAnyStage(agent, ["ready_for_review"])) {
    return [
      "- Audit the subgoal's relevantFiles, changed files, and directly related tests first. Only widen the review scope when the local evidence is insufficient.",
      "- If review depends on prior debate, fetch the relevant event or agent history on demand instead of asking for a broader prompt transcript.",
    ];
  }
  if (ownsAnyStage(agent, ["open", "researching"])) {
    return [
      "- Stay on your owned research card or direct targets. Do not reread unrelated cards unless the trigger points to them.",
      "- The current assignee is the canonical owner of an open or researching card.",
      "- If the visible card is a broad umbrella but your trigger is a different durable axis, create a separate subgoal for that axis instead of stuffing everything into the umbrella card.",
      "- Do not create a second card for the same contract just because you can phrase the title differently. If the deliverable, owner, acceptance, and next action are effectively the same, reuse the existing card or ask the coordinator to merge it.",
      "- If you own the card and you learned something durable, update the canonical card fields. Do not leave facts/open/resolved/acceptance/files empty while only writing notes or messages.",
      "- If you are not that owner, do not change stage, decisionState, assigneeAgentId, reopenReason, or mergedIntoSubgoalId on the card. Put objections, findings, and follow-up questions in the card discussion instead.",
      "- Same-card peer debate should usually go to append_subgoal_discussion first. Use a peer teamMessage only when you need that researcher to act or answer directly.",
      "- If you do not own the card, write same-card findings to discussion before escalating them to the coordinator unless someone must act immediately.",
      "- Use a targeted coordinator message when you want routing to change, a card to reopen, or a handoff to move downstream.",
      "- When your findings define a new durable axis such as runtime/bootstrap, drums, render/export, or evaluation, prefer creating that card directly instead of waiting for the coordinator to invent it.",
      "- Do not mark a card ready_for_build on a first pass. Use discussion to expose the main objections, assumptions, and validation gaps first.",
      "- Before you propose ready_for_build, make sure the card itself contains the build contract in summary plus concrete facts, resolved decisions, acceptance criteria, relevant files, and next action.",
      "- Only mark a research card ready_for_build when the implementation contract is explicit and the remaining uncertainty is narrow enough for implementation.",
      "- Create a new subgoal only for a materially different research axis, deliverable, acceptance contract, or downstream owner.",
      "- Stay at the research layer. Use code, files, and data as evidence, and prefer narrow reads and small samples over broad scans or full-pipeline runs.",
    ];
  }
  return [];
}
