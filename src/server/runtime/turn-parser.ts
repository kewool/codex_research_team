// @ts-nocheck
import { AgentTurnResult, DirectedTeamMessage } from "../../shared/types";
import { emptyTokenUsage } from "./token-usage";

export function hasStructuredResponseEnvelope(rawText: string): boolean {
  return /<codex_research_team-response>[\s\S]*?<\/codex_research_team-response>/i.test(String(rawText ?? ""));
}

export function looksLikeWriteProbeCommand(command: string): boolean {
  const normalized = String(command ?? "").toLowerCase();
  return /(new-item|set-content|add-content|out-file|copy-item|move-item|remove-item|mkdir|md |ni |touch|>>|>\s*[^|]|apply_patch|write)/.test(normalized);
}

export function looksLikeBroadDataLoadCommand(command: string): boolean {
  const normalized = String(command ?? "").toLowerCase();
  return /(load_chat_log\s*\(|pandas\.read_csv|pd\.read_csv|csv\.dictreader|import-csv\b|chathighlightdetector\s*\(|find_highlights\s*\(|highlightrescorer\s*\(|shortsgenerator\s*\(|generator\.generate\s*\()/i.test(normalized);
}

function normalizeDirectedTeamMessages(parsed: Partial<AgentTurnResult> & { teamMessage?: string; targetAgentId?: string | null; targetAgentIds?: string[] | null }): DirectedTeamMessage[] {
  const normalizeTargetIds = (value: unknown): string[] =>
    Array.isArray(value)
      ? [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))]
      : [];
  const normalizeSubgoalIds = (value: unknown): string[] =>
    Array.isArray(value)
      ? [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))]
      : [];
  const fromArray = Array.isArray(parsed.teamMessages)
    ? parsed.teamMessages
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const record = item as Record<string, unknown>;
        const content = String(record.content ?? record.message ?? "").trim();
        const parsedTargetAgentIds = normalizeTargetIds(record.targetAgentIds);
        const singleTargetAgentId = String(record.targetAgentId ?? "").trim() || null;
        const targetAgentIds = parsedTargetAgentIds.length > 0
          ? parsedTargetAgentIds
          : singleTargetAgentId
            ? [singleTargetAgentId]
            : [];
        return {
          content,
          targetAgentId: targetAgentIds.length === 1 ? targetAgentIds[0] : null,
          targetAgentIds,
          ...(Object.prototype.hasOwnProperty.call(record, "subgoalIds")
            ? { subgoalIds: normalizeSubgoalIds(record.subgoalIds) }
            : {}),
        };
      })
      .filter((message) => message.content)
    : [];
  if (fromArray.length > 0) {
    return fromArray;
  }
  const legacyMessage = String(parsed.teamMessage ?? "").trim();
  if (!legacyMessage) {
    return [];
  }
  const targetAgentIds = normalizeTargetIds(parsed.targetAgentIds);
  const singleTargetAgentId = String(parsed.targetAgentId ?? "").trim() || null;
  const finalTargetAgentIds = targetAgentIds.length > 0
    ? targetAgentIds
    : singleTargetAgentId
      ? [singleTargetAgentId]
      : [];
  return [{
    content: legacyMessage,
    targetAgentId: finalTargetAgentIds.length === 1 ? finalTargetAgentIds[0] : null,
    targetAgentIds: finalTargetAgentIds,
  }];
}

function normalizeParsedTurnResult(
  parsed: Partial<AgentTurnResult> & { teamMessage?: string; targetAgentId?: string | null; targetAgentIds?: string[] | null },
  rawText: string,
): AgentTurnResult {
  const normalizeAssigneeAlias = (update: Record<string, unknown>): string | null => {
    const aliases = [
      update.assigneeAgentId,
      update.ownerAgentId,
      update.assignee,
      update.owner,
    ];
    for (const alias of aliases) {
      const normalized = String(alias ?? "").trim();
      if (normalized) {
        return normalized;
      }
    }
    return null;
  };
  const teamMessages = normalizeDirectedTeamMessages(parsed);
  const normalizedSubgoalUpdates = Array.isArray(parsed.subgoalUpdates)
    ? parsed.subgoalUpdates
        .filter((item) => item && typeof item === "object")
        .map((item) => {
          const update = item as Record<string, unknown>;
          const normalizedAssignee = normalizeAssigneeAlias(update);
          return {
            ...(String(update.id ?? "").trim() ? { id: String(update.id).trim() } : {}),
            ...(String(update.subgoalId ?? "").trim() ? { id: String(update.subgoalId).trim() } : {}),
            ...(String(update.title ?? "").trim() ? { title: String(update.title).trim() } : {}),
            ...(String(update.topicKey ?? "").trim() ? { topicKey: String(update.topicKey).trim() } : {}),
            ...(String(update.summary ?? "").trim() ? { summary: String(update.summary).trim() } : {}),
            ...(Array.isArray(update.addFacts) ? { addFacts: update.addFacts.map((entry) => String(entry ?? "").trim()).filter(Boolean) } : {}),
            ...(Array.isArray(update.addOpenQuestions) ? { addOpenQuestions: update.addOpenQuestions.map((entry) => String(entry ?? "").trim()).filter(Boolean) } : {}),
            ...(Array.isArray(update.addResolvedDecisions) ? { addResolvedDecisions: update.addResolvedDecisions.map((entry) => String(entry ?? "").trim()).filter(Boolean) } : {}),
            ...(Array.isArray(update.addAcceptanceCriteria) ? { addAcceptanceCriteria: update.addAcceptanceCriteria.map((entry) => String(entry ?? "").trim()).filter(Boolean) } : {}),
            ...(Array.isArray(update.addRelevantFiles) ? { addRelevantFiles: update.addRelevantFiles.map((entry) => String(entry ?? "").trim()).filter(Boolean) } : {}),
            ...(Object.prototype.hasOwnProperty.call(update, "nextAction") ? { nextAction: String(update.nextAction ?? "").trim() } : {}),
            ...(String(update.stage ?? "").trim() ? { stage: String(update.stage).trim() } : {}),
            ...(String(update.decisionState ?? "").trim() ? { decisionState: String(update.decisionState).trim() } : {}),
            ...(normalizedAssignee !== null ? { assigneeAgentId: normalizedAssignee || null } : {}),
            ...(Object.prototype.hasOwnProperty.call(update, "mergedIntoSubgoalId") ? { mergedIntoSubgoalId: update.mergedIntoSubgoalId == null ? null : String(update.mergedIntoSubgoalId).trim() || null } : {}),
            ...(String(update.reopenReason ?? "").trim() ? { reopenReason: String(update.reopenReason).trim() } : {}),
            ...(Object.prototype.hasOwnProperty.call(update, "expectedRevision") ? { expectedRevision: Number(update.expectedRevision) } : {}),
          };
        })
        .filter((update) => Object.keys(update).length > 0)
    : [];

  return {
    shouldReply: Boolean(parsed.shouldReply),
    workingNotes: Array.isArray(parsed.workingNotes)
      ? parsed.workingNotes.map((note) => String(note ?? "").trim()).filter(Boolean)
      : [],
    teamMessages,
    subgoalUpdates: normalizedSubgoalUpdates,
    completion: parsed.completion === "done" || parsed.completion === "blocked" ? parsed.completion : "continue",
    rawText,
    tokenUsage: parsed.tokenUsage ?? emptyTokenUsage(),
    runtimeDiagnostics: parsed.runtimeDiagnostics ?? {
      sawFileChange: false,
      sawPolicyWriteBlock: false,
      sawBroadDataLoad: false,
    },
  };
}

function repairMalformedResponseJson(payloadText: string): string {
  return repairRepeatedArrayProperties(payloadText
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":')
    .replace(/:\s*'([^']*)'/g, (_match, value: string) => `: ${JSON.stringify(value)}`));
}

function findMatchingBracket(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "[") {
      depth += 1;
      continue;
    }
    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function repairRepeatedArrayKey(payloadText: string, key: string): string {
  const marker = `"${key}"`;
  let text = payloadText;
  let changed = true;
  while (changed) {
    changed = false;
    let searchFrom = 0;
    while (true) {
      const propertyIndex = text.indexOf(marker, searchFrom);
      if (propertyIndex < 0) {
        break;
      }
      const arrayStart = text.indexOf("[", propertyIndex + marker.length);
      if (arrayStart < 0) {
        break;
      }
      const colonSlice = text.slice(propertyIndex + marker.length, arrayStart);
      if (!/^\s*:\s*$/.test(colonSlice)) {
        searchFrom = propertyIndex + marker.length;
        continue;
      }
      const arrayEnd = findMatchingBracket(text, arrayStart);
      if (arrayEnd < 0) {
        break;
      }
      const nestedPropertyIndex = text.indexOf(marker, arrayStart + 1);
      if (nestedPropertyIndex < 0 || nestedPropertyIndex > arrayEnd) {
        searchFrom = arrayEnd + 1;
        continue;
      }
      const nestedArrayStart = text.indexOf("[", nestedPropertyIndex + marker.length);
      if (nestedArrayStart < 0 || nestedArrayStart > arrayEnd) {
        searchFrom = arrayEnd + 1;
        continue;
      }
      const nestedColonSlice = text.slice(nestedPropertyIndex + marker.length, nestedArrayStart);
      if (!/^\s*:\s*$/.test(nestedColonSlice)) {
        searchFrom = nestedPropertyIndex + marker.length;
        continue;
      }
      const nestedArrayEnd = findMatchingBracket(text, nestedArrayStart);
      if (nestedArrayEnd < 0) {
        break;
      }
      const nestedContents = text.slice(nestedArrayStart + 1, nestedArrayEnd);
      text = `${text.slice(0, nestedPropertyIndex)}${nestedContents}${text.slice(nestedArrayEnd + 1)}`;
      changed = true;
      break;
    }
  }
  return text;
}

function repairRepeatedArrayProperties(payloadText: string): string {
  const repeatedArrayKeys = [
    "workingNotes",
    "teamMessages",
    "subgoalUpdates",
    "addFacts",
    "addOpenQuestions",
    "addResolvedDecisions",
    "addAcceptanceCriteria",
    "addRelevantFiles",
  ];
  return repeatedArrayKeys.reduce((current, key) => repairRepeatedArrayKey(current, key), payloadText);
}

export function parseAgentTurnResult(rawText: string): AgentTurnResult {
  const match = String(rawText ?? "").match(/<codex_research_team-response>([\s\S]*?)<\/codex_research_team-response>/i);
  if (!match) {
    throw new Error("Codex response did not include <codex_research_team-response>.");
  }
  const payloadText = match[1].trim();
  try {
    const parsed = JSON.parse(payloadText) as Partial<AgentTurnResult> & { teamMessage?: string; targetAgentId?: string | null; targetAgentIds?: string[] | null };
    return normalizeParsedTurnResult(parsed, rawText);
  } catch (error) {
    try {
      const repaired = repairMalformedResponseJson(payloadText);
      const parsed = JSON.parse(repaired) as Partial<AgentTurnResult> & { teamMessage?: string; targetAgentId?: string | null; targetAgentIds?: string[] | null };
      return normalizeParsedTurnResult(parsed, rawText);
    } catch {
      throw new Error(`Failed to parse Codex JSON payload: ${(error as Error).message}`);
    }
  }
}
