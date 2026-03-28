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
    "- The runtime may permit real filesystem writes so you can modify the selected workspace directly. Treat that as execution capability for this workspace only, not permission to inspect or modify unrelated files.",
    "- Do not create, modify, delete, or publish files outside the selected workspace.",
    "- Do not introduce or normalize repo-root output trees such as exports/, release/, publish/, or other sibling directories.",
    "- If existing workspace code tries to write outside the selected workspace, do not implement or preserve that behavior. Treat it as a workflow risk to report and keep outputs workspace-relative instead.",
    "- Do not use synthetic write probes as proof that the workspace is blocked. If you already have an actionable workspace-local task, prefer the normal edit/apply path first.",
    "- Do not open, print, or dump raw binary/media files directly. Treat audio, wav, mp3, image, and other large binaries as opaque assets unless a specific tool is required.",
    "- Prefer metadata, filenames, directory listings, and targeted text/code reads over broad workspace scans.",
    "- Treat large structured data files and logs as expensive context. Do not fully load or print them by default; prefer schema/header checks, row counts, targeted filters, sampled slices, or narrow aggregations first.",
    "- Do not materialize full stream/chat datasets into memory by default with helpers like load_chat_log, pandas.read_csv, or csv.DictReader over the entire file. Only do that after smaller probes prove it is necessary for the current subgoal.",
    "- Do not run full-dataset pipeline paths like ChatHighlightDetector, HighlightRescorer, or ShortsGenerator against project-scale assets by default. Prefer smaller fixtures, bounded slices, or existing regressions first.",
    "- Reuse already-established aggregates from the transcript or goal board instead of recomputing the same full-file statistics on later turns.",
    "- Avoid generated artifacts and scratch directories such as tmp_*, output folders, caches, or derived stems unless they are the explicit subject of the turn.",
    "- Do not repeatedly reread unchanged large files just to restate prior findings. Reuse the transcript and current trigger as the primary context.",
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
