// @ts-nocheck
import {
  DirectedTeamMessage,
  SessionEvent,
  SubgoalDecisionState,
  SubgoalStage,
  TokenUsage,
} from "../../shared/types";

export const SUBGOAL_STAGE_SET = new Set<SubgoalStage>([
  "open",
  "researching",
  "ready_for_build",
  "building",
  "ready_for_review",
  "done",
  "blocked",
]);
export const SUBGOAL_DECISION_STATE_SET = new Set<SubgoalDecisionState>(["open", "disputed", "resolved"]);

export const RECENT_EVENT_LIMIT = 40;
export const SNAPSHOT_STREAM_TAIL = 2400;
export const DRAIN_DEBOUNCE_MS = 350;
export const SUBGOAL_FACT_LIMIT = 6;
export const SUBGOAL_QUESTION_LIMIT = 4;
export const SUBGOAL_DECISION_LIMIT = 4;
export const SUBGOAL_ACCEPTANCE_LIMIT = 4;
export const SUBGOAL_FILE_LIMIT = 6;
export const TRANSIENT_TURN_RETRY_LIMIT = 3;

export function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
}

export function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: Number(left?.inputTokens || 0) + Number(right?.inputTokens || 0),
    cachedInputTokens: Number(left?.cachedInputTokens || 0) + Number(right?.cachedInputTokens || 0),
    outputTokens: Number(left?.outputTokens || 0) + Number(right?.outputTokens || 0),
  };
}

export function compactWhitespace(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function shortenText(text: string, maxChars = 160): string {
  const normalized = compactWhitespace(text);
  if (!normalized) {
    return "-";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function defaultDecisionStateForStage(stage: SubgoalStage): SubgoalDecisionState {
  switch (stage) {
    case "ready_for_build":
    case "building":
    case "ready_for_review":
    case "done":
      return "resolved";
    case "blocked":
      return "disputed";
    default:
      return "open";
  }
}

export function normalizeDecisionState(state: unknown, fallback: SubgoalDecisionState): SubgoalDecisionState {
  return SUBGOAL_DECISION_STATE_SET.has(state as SubgoalDecisionState) ? (state as SubgoalDecisionState) : fallback;
}

export function normalizeMemoryList(values: unknown, limit: number, itemLimit = 180): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const items = values
    .map((value) => shortenText(String(value ?? "").trim(), itemLimit))
    .filter(Boolean);
  return [...new Set(items)].slice(0, limit);
}

export function mergeMemoryList(existing: string[], additions: unknown, limit: number, itemLimit = 180): string[] {
  const merged = [
    ...(Array.isArray(existing) ? existing.map((value) => shortenText(String(value ?? "").trim(), itemLimit)).filter(Boolean) : []),
    ...normalizeMemoryList(additions, limit, itemLimit),
  ];
  return [...new Set(merged)].slice(-limit);
}

export function normalizeNextAction(value: unknown): string | null {
  const normalized = shortenText(String(value ?? "").trim(), 200);
  return normalized || null;
}

export function extractTargetAgentIds(metadata: Record<string, unknown> | undefined): string[] {
  const multi = Array.isArray(metadata?.targetAgentIds)
    ? metadata.targetAgentIds.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  if (multi.length > 0) {
    return [...new Set(multi)];
  }
  const single = typeof metadata?.targetAgentId === "string" ? metadata.targetAgentId.trim() : "";
  return single ? [single] : [];
}

export function normalizeDirectedMessageTargets(message: DirectedTeamMessage | null | undefined): string[] {
  const multi = Array.isArray(message?.targetAgentIds)
    ? message.targetAgentIds.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  if (multi.length > 0) {
    return [...new Set(multi)];
  }
  const single = typeof message?.targetAgentId === "string" ? message.targetAgentId.trim() : "";
  return single ? [single] : [];
}

export function normalizeDirectedMessageSubgoalIds(message: DirectedTeamMessage | null | undefined): string[] | null {
  if (!message || typeof message !== "object" || !Object.prototype.hasOwnProperty.call(message, "subgoalIds")) {
    return null;
  }
  return Array.isArray(message.subgoalIds)
    ? [...new Set(message.subgoalIds.map((item) => String(item ?? "").trim()).filter(Boolean))]
    : [];
}

export function summarizeDirectedMessages(messages: DirectedTeamMessage[] | null | undefined, maxChars = 220): string {
  const items = (Array.isArray(messages) ? messages : [])
    .map((message) => {
      const content = compactWhitespace(message?.content || "");
      if (!content) {
        return "";
      }
      const targetIds = normalizeDirectedMessageTargets(message);
      const targetText = targetIds.length > 0 ? ` target=${targetIds.join(",")}` : "";
      return `${targetText}: ${shortenText(content, maxChars)}`.trim();
    })
    .filter(Boolean);
  return items.join(" | ");
}

export function formatTargetSuffix(metadata: Record<string, unknown> | undefined): string {
  const targetIds = extractTargetAgentIds(metadata);
  return targetIds.length > 0 ? ` target=${targetIds.join(",")}` : "";
}

export function formatSubgoalSuffix(metadata: Record<string, unknown> | undefined): string {
  const subgoalIds = Array.isArray(metadata?.subgoalIds)
    ? metadata.subgoalIds.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
  return subgoalIds.length > 0 ? ` subgoals=${[...new Set(subgoalIds)].join(",")}` : "";
}

export function formatDigestEvent(event: SessionEvent, maxChars = 220): string {
  const targetText = formatTargetSuffix(event.metadata);
  const directText = event.metadata?.directInput ? " direct-input" : "";
  const subgoalText = formatSubgoalSuffix(event.metadata);
  return `- #${event.sequence} ${event.sender} -> ${event.channel}${targetText}${subgoalText}${directText}: ${shortenText(event.content, maxChars)}`;
}

export function normalizeSubgoalStage(value: unknown, fallback: SubgoalStage = "researching"): SubgoalStage {
  const stage = String(value ?? "").trim();
  return SUBGOAL_STAGE_SET.has(stage as SubgoalStage) ? (stage as SubgoalStage) : fallback;
}

export function normalizeExpectedRevision(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : null;
}

export function normalizeTopicKey(value: unknown): string | null {
  const normalized = compactWhitespace(String(value ?? ""))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!normalized) {
    return null;
  }
  const parts = normalized.split("-").filter(Boolean).slice(0, 6);
  return parts.length > 0 ? parts.join("-") : null;
}
