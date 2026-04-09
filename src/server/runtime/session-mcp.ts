// @ts-nocheck
import { stdin as input, stdout as output, stderr, env as processEnv } from "node:process";

export const INTERNAL_SESSION_MCP_SERVER_NAME = "codex-research-team-session";
const MCP_PROTOCOL_VERSION = "2025-11-25";

function trimText(value: unknown): string {
  return String(value ?? "").trim();
}

function nowIso(): string {
  return new Date().toISOString();
}

function sessionServerUrl(env = processEnv): string {
  const explicit = trimText(env.CRT_SERVER_URL);
  return explicit || "http://127.0.0.1:4280";
}

function sessionIdFromEnv(env = processEnv): string {
  return trimText(env.CRT_SESSION_ID);
}

function agentIdFromEnv(env = processEnv): string {
  return trimText(env.CRT_AGENT_ID);
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

function normalizeCursor(value: unknown): string | null {
  const normalized = trimText(value);
  return normalized || null;
}

function targetAgentIdsFromMetadata(metadata: any): string[] {
  const multi = Array.isArray(metadata?.targetAgentIds)
    ? metadata.targetAgentIds.map((item: unknown) => trimText(item)).filter(Boolean)
    : [];
  if (multi.length > 0) {
    return [...new Set(multi)];
  }
  const single = trimText(metadata?.targetAgentId);
  return single ? [single] : [];
}

function subgoalIdsFromMetadata(metadata: any): string[] {
  return Array.isArray(metadata?.subgoalIds)
    ? [...new Set(metadata.subgoalIds.map((item: unknown) => trimText(item)).filter(Boolean))]
    : [];
}

function compactEventRecord(event: any): any {
  return {
    sequence: Number(event?.sequence || 0),
    timestamp: trimText(event?.timestamp) || null,
    sender: trimText(event?.sender),
    channel: trimText(event?.channel),
    content: trimText(event?.content),
    targetAgentIds: targetAgentIdsFromMetadata(event?.metadata),
    subgoalIds: subgoalIdsFromMetadata(event?.metadata),
    metadata: event?.metadata && typeof event.metadata === "object" ? event.metadata : {},
  };
}

function compactHistoryRecord(entry: any): any {
  return {
    id: trimText(entry?.id),
    timestamp: trimText(entry?.timestamp) || null,
    kind: trimText(entry?.kind),
    label: trimText(entry?.label) || null,
    text: trimText(entry?.text),
    metadata: entry?.metadata && typeof entry.metadata === "object" ? entry.metadata : {},
  };
}

async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<any> {
  const response = await fetchImpl(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(trimText(payload?.error) || `Request failed with ${response.status}`);
  }
  return payload;
}

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown): Promise<any> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  } as any);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(trimText(payload?.error) || `Request failed with ${response.status}`);
  }
  return payload;
}

async function fetchSessionSnapshot(fetchImpl: typeof fetch, env = processEnv): Promise<any> {
  const sessionId = sessionIdFromEnv(env);
  if (!sessionId) {
    throw new Error("CRT_SESSION_ID is not set for the session-state MCP server.");
  }
  const payload = await fetchJson(fetchImpl, `${sessionServerUrl(env)}/api/sessions/${encodeURIComponent(sessionId)}`);
  if (!payload?.session) {
    throw new Error("Session lookup returned no session snapshot.");
  }
  return payload.session;
}

async function fetchSessionEventPage(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv, before: string | null, limit: number): Promise<any> {
  const sessionId = sessionIdFromEnv(env);
  if (!sessionId) {
    throw new Error("CRT_SESSION_ID is not set for the session-state MCP server.");
  }
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (before) {
    params.set("before", before);
  }
  return fetchJson(fetchImpl, `${sessionServerUrl(env)}/api/sessions/${encodeURIComponent(sessionId)}/feed?${params.toString()}`);
}

async function fetchAgentHistoryPage(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv, agentId: string, kind: string, before: string | null, limit: number): Promise<any> {
  const sessionId = sessionIdFromEnv(env);
  if (!sessionId) {
    throw new Error("CRT_SESSION_ID is not set for the session-state MCP server.");
  }
  const params = new URLSearchParams();
  params.set("kind", kind);
  params.set("limit", String(limit));
  if (before) {
    params.set("before", before);
  }
  return fetchJson(fetchImpl, `${sessionServerUrl(env)}/api/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/history?${params.toString()}`);
}

function activeSubgoals(snapshot: any, includeArchived: boolean): any[] {
  const subgoals = Array.isArray(snapshot?.subgoals) ? snapshot.subgoals : [];
  if (includeArchived) {
    return subgoals;
  }
  return subgoals.filter((subgoal) => !trimText(subgoal?.mergedIntoSubgoalId) && !trimText(subgoal?.archivedAt));
}

function compactSubgoalRecord(subgoal: any): any {
  return {
    id: trimText(subgoal?.id),
    title: trimText(subgoal?.title),
    topicKey: trimText(subgoal?.topicKey),
    stage: trimText(subgoal?.stage),
    decisionState: trimText(subgoal?.decisionState),
    assigneeAgentId: trimText(subgoal?.assigneeAgentId) || null,
    revision: Number(subgoal?.revision || 0),
    discussionRevision: Number(subgoal?.discussionRevision || 0),
    discussionCount: Array.isArray(subgoal?.discussionMessages) ? subgoal.discussionMessages.length : 0,
    conflictCount: Number(subgoal?.conflictCount || 0),
    activeConflict: Boolean(subgoal?.activeConflict),
    mergedIntoSubgoalId: trimText(subgoal?.mergedIntoSubgoalId) || null,
    archivedAt: trimText(subgoal?.archivedAt) || null,
    nextAction: trimText(subgoal?.nextAction) || null,
    summary: trimText(subgoal?.summary),
  };
}

function fullSubgoalRecord(subgoal: any): any {
  return {
    id: trimText(subgoal?.id),
    title: trimText(subgoal?.title),
    topicKey: trimText(subgoal?.topicKey),
    summary: trimText(subgoal?.summary),
    facts: Array.isArray(subgoal?.facts) ? subgoal.facts : [],
    openQuestions: Array.isArray(subgoal?.openQuestions) ? subgoal.openQuestions : [],
    resolvedDecisions: Array.isArray(subgoal?.resolvedDecisions) ? subgoal.resolvedDecisions : [],
    acceptanceCriteria: Array.isArray(subgoal?.acceptanceCriteria) ? subgoal.acceptanceCriteria : [],
    relevantFiles: Array.isArray(subgoal?.relevantFiles) ? subgoal.relevantFiles : [],
    nextAction: trimText(subgoal?.nextAction) || null,
    stage: trimText(subgoal?.stage),
    decisionState: trimText(subgoal?.decisionState),
    assigneeAgentId: trimText(subgoal?.assigneeAgentId) || null,
    lastReopenReason: trimText(subgoal?.lastReopenReason) || null,
    revision: Number(subgoal?.revision || 0),
    discussionRevision: Number(subgoal?.discussionRevision || 0),
    conflictCount: Number(subgoal?.conflictCount || 0),
    activeConflict: Boolean(subgoal?.activeConflict),
    lastConflictAt: trimText(subgoal?.lastConflictAt) || null,
    lastConflictSummary: trimText(subgoal?.lastConflictSummary) || null,
    mergedIntoSubgoalId: trimText(subgoal?.mergedIntoSubgoalId) || null,
    archivedAt: trimText(subgoal?.archivedAt) || null,
    archivedBy: trimText(subgoal?.archivedBy) || null,
    updatedAt: trimText(subgoal?.updatedAt) || null,
    updatedBy: trimText(subgoal?.updatedBy) || null,
    discussionCount: Array.isArray(subgoal?.discussionMessages) ? subgoal.discussionMessages.length : 0,
  };
}

function findSubgoal(snapshot: any, subgoalId: unknown): any | null {
  const wanted = trimText(subgoalId);
  if (!wanted) {
    return null;
  }
  const subgoals = Array.isArray(snapshot?.subgoals) ? snapshot.subgoals : [];
  return subgoals.find((subgoal) => trimText(subgoal?.id) === wanted) ?? null;
}

function textResult(payload: unknown): any {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function sessionStateToolDefinitions(): any[] {
  return [
    {
      name: "list_session_events",
      description: "List persisted session feed events with optional filters for channel, sender, targets, or subgoal ids.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string" },
          sender: { type: "string" },
          target_agent_id: { type: "string" },
          subgoal_id: { type: "string" },
          include_system: { type: "boolean" },
          before: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
    },
    {
      name: "get_agent_history",
      description: "Return persisted per-agent history entries such as notes, messages, prompts, stdout, stderr, or errors.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          kind: { type: "string", enum: ["notes", "messages", "prompts", "stdout", "stderr", "errors"] },
          before: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        required: ["agent_id", "kind"],
      },
    },
    {
      name: "list_subgoals",
      description: "List current subgoals for the active session with compact state fields.",
      inputSchema: {
        type: "object",
        properties: {
          include_archived: { type: "boolean" },
          stage: { type: "string" },
          decision_state: { type: "string" },
          assignee_agent_id: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
    },
    {
      name: "get_subgoal",
      description: "Return the full canonical state for one subgoal in the active session.",
      inputSchema: {
        type: "object",
        properties: {
          subgoal_id: { type: "string" },
        },
        required: ["subgoal_id"],
      },
    },
    {
      name: "list_subgoal_discussion",
      description: "Return append-only discussion messages for one subgoal.",
      inputSchema: {
        type: "object",
        properties: {
          subgoal_id: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        required: ["subgoal_id"],
      },
    },
    {
      name: "append_subgoal_discussion",
      description: "Append one discussion message to a subgoal thread for the current agent.",
      inputSchema: {
        type: "object",
        properties: {
          subgoal_id: { type: "string" },
          content: { type: "string" },
        },
        required: ["subgoal_id", "content"],
      },
    },
    {
      name: "get_subgoal_conflicts",
      description: "Return conflict history entries for one subgoal.",
      inputSchema: {
        type: "object",
        properties: {
          subgoal_id: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        required: ["subgoal_id"],
      },
    },
  ];
}

export async function callSessionStateTool(toolName: string, args: any, options?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): Promise<any> {
  const env = options?.env ?? processEnv;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const base = {
    sessionId: sessionIdFromEnv(env),
    agentId: agentIdFromEnv(env) || null,
    fetchedAt: nowIso(),
  };

  if (toolName === "list_session_events") {
    const channel = trimText(args?.channel);
    const sender = trimText(args?.sender);
    const targetAgentId = trimText(args?.target_agent_id);
    const subgoalId = trimText(args?.subgoal_id);
    const includeSystem = Boolean(args?.include_system);
    const requestedLimit = clampLimit(args?.limit, 12, 50);
    const pageLimit = Math.min(200, Math.max(40, requestedLimit * 4));
    let before = normalizeCursor(args?.before);
    const items: any[] = [];
    let nextBefore: string | number | null = before;
    let hasMore = false;

    for (let pageIndex = 0; pageIndex < 5 && items.length < requestedLimit; pageIndex += 1) {
      const page = await fetchSessionEventPage(fetchImpl, env, before, pageLimit);
      const pageItems = Array.isArray(page?.items) ? page.items : [];
      for (const event of pageItems) {
        const normalized = compactEventRecord(event);
        if (!includeSystem && (normalized.channel === "system" || normalized.channel === "status")) {
          continue;
        }
        if (channel && normalized.channel !== channel) {
          continue;
        }
        if (sender && normalized.sender !== sender) {
          continue;
        }
        if (targetAgentId && !normalized.targetAgentIds.includes(targetAgentId)) {
          continue;
        }
        if (subgoalId && !normalized.subgoalIds.includes(subgoalId)) {
          continue;
        }
        items.push(normalized);
        if (items.length >= requestedLimit) {
          break;
        }
      }
      nextBefore = page?.nextBefore ?? null;
      hasMore = Boolean(page?.hasMore && nextBefore != null);
      if (!page?.hasMore || nextBefore == null) {
        break;
      }
      before = String(nextBefore);
    }

    return textResult({
      ...base,
      total: items.length,
      nextBefore,
      hasMore,
      events: items,
    });
  }

  if (toolName === "get_agent_history") {
    const agentId = trimText(args?.agent_id);
    const kind = trimText(args?.kind);
    if (!agentId || !kind) {
      return {
        isError: true,
        ...textResult({
          ...base,
          error: "agent_id and kind are required.",
        }),
      };
    }
    const limit = clampLimit(args?.limit, 12, 50);
    const before = normalizeCursor(args?.before);
    const page = await fetchAgentHistoryPage(fetchImpl, env, agentId, kind, before, limit);
    return textResult({
      ...base,
      agentId,
      kind,
      nextBefore: page?.nextBefore ?? null,
      hasMore: Boolean(page?.hasMore),
      items: Array.isArray(page?.items) ? page.items.map(compactHistoryRecord) : [],
    });
  }

  const snapshot = await fetchSessionSnapshot(fetchImpl, env);
  base.sessionId = trimText(snapshot?.id);

  if (toolName === "list_subgoals") {
    const includeArchived = Boolean(args?.include_archived);
    const stage = trimText(args?.stage);
    const decisionState = trimText(args?.decision_state);
    const assigneeAgentId = trimText(args?.assignee_agent_id);
    const limit = clampLimit(args?.limit, 12, 50);
    let subgoals = activeSubgoals(snapshot, includeArchived);
    if (stage) {
      subgoals = subgoals.filter((subgoal) => trimText(subgoal?.stage) === stage);
    }
    if (decisionState) {
      subgoals = subgoals.filter((subgoal) => trimText(subgoal?.decisionState) === decisionState);
    }
    if (assigneeAgentId) {
      subgoals = subgoals.filter((subgoal) => trimText(subgoal?.assigneeAgentId) === assigneeAgentId);
    }
    return textResult({
      ...base,
      total: subgoals.length,
      subgoals: subgoals.slice(0, limit).map(compactSubgoalRecord),
    });
  }

  if (toolName === "get_subgoal") {
    const subgoal = findSubgoal(snapshot, args?.subgoal_id);
    if (!subgoal) {
      return {
        isError: true,
        ...textResult({
          ...base,
          error: `Unknown subgoal: ${trimText(args?.subgoal_id)}`,
        }),
      };
    }
    return textResult({
      ...base,
      subgoal: fullSubgoalRecord(subgoal),
    });
  }

  if (toolName === "list_subgoal_discussion") {
    const subgoal = findSubgoal(snapshot, args?.subgoal_id);
    if (!subgoal) {
      return {
        isError: true,
        ...textResult({
          ...base,
          error: `Unknown subgoal: ${trimText(args?.subgoal_id)}`,
        }),
      };
    }
    const limit = clampLimit(args?.limit, 10, 50);
    const discussion = Array.isArray(subgoal?.discussionMessages) ? subgoal.discussionMessages.slice(-limit) : [];
    return textResult({
      ...base,
      subgoalId: trimText(subgoal.id),
      total: Array.isArray(subgoal?.discussionMessages) ? subgoal.discussionMessages.length : 0,
      discussion,
    });
  }

  if (toolName === "append_subgoal_discussion") {
    const subgoalId = trimText(args?.subgoal_id);
    const content = trimText(args?.content);
    const agentId = agentIdFromEnv(env);
    if (!subgoalId || !content || !agentId) {
      return {
        isError: true,
        ...textResult({
          ...base,
          error: "subgoal_id, content, and CRT_AGENT_ID are required.",
        }),
      };
    }
    const sessionId = sessionIdFromEnv(env);
    await postJson(fetchImpl, `${sessionServerUrl(env)}/api/sessions/${encodeURIComponent(sessionId)}/subgoals/${encodeURIComponent(subgoalId)}/discussion`, {
      agentId,
      content,
    });
    return textResult({
      ...base,
      subgoalId,
      agentId,
      appended: true,
    });
  }

  if (toolName === "get_subgoal_conflicts") {
    const subgoal = findSubgoal(snapshot, args?.subgoal_id);
    if (!subgoal) {
      return {
        isError: true,
        ...textResult({
          ...base,
          error: `Unknown subgoal: ${trimText(args?.subgoal_id)}`,
        }),
      };
    }
    const limit = clampLimit(args?.limit, 10, 50);
    const conflicts = Array.isArray(subgoal?.conflictHistory) ? subgoal.conflictHistory.slice(-limit) : [];
    return textResult({
      ...base,
      subgoalId: trimText(subgoal.id),
      total: Array.isArray(subgoal?.conflictHistory) ? subgoal.conflictHistory.length : 0,
      conflicts,
    });
  }

  return {
    isError: true,
    ...textResult({
      ...base,
      error: `Unknown tool: ${toolName}`,
    }),
  };
}

function writeMessage(stream: NodeJS.WriteStream, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  stream.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
  stream.write(body);
}

function writeResponse(id: unknown, result: unknown): void {
  writeMessage(output, { jsonrpc: "2.0", id, result });
}

function writeError(id: unknown, code: number, message: string): void {
  writeMessage(output, {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

async function handleRequest(message: any): Promise<void> {
  const id = message?.id ?? null;
  const method = trimText(message?.method);
  if (!method) {
    if (id !== null) {
      writeError(id, -32600, "Invalid request");
    }
    return;
  }
  if (method === "initialize") {
    writeResponse(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo: {
        name: INTERNAL_SESSION_MCP_SERVER_NAME,
        title: "Codex Research Team Session State",
        version: "0.2.0",
      },
      instructions: "Use these tools to inspect the current session's subgoals, discussion threads, history, and conflicts on demand instead of relying on copied prompt state.",
    });
    return;
  }
  if (method === "ping") {
    writeResponse(id, {});
    return;
  }
  if (method === "tools/list") {
    writeResponse(id, { tools: sessionStateToolDefinitions() });
    return;
  }
  if (method === "tools/call") {
    const name = trimText(message?.params?.name);
    try {
      const result = await callSessionStateTool(name, message?.params?.arguments ?? {});
      writeResponse(id, result);
    } catch (error) {
      writeResponse(id, {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: String((error as Error)?.message || error),
              sessionId: sessionIdFromEnv(),
              agentId: agentIdFromEnv() || null,
            }, null, 2),
          },
        ],
      });
    }
    return;
  }
  if (method === "notifications/initialized") {
    return;
  }
  if (method.startsWith("notifications/")) {
    return;
  }
  if (id !== null) {
    writeError(id, -32601, `Method not found: ${method}`);
  }
}

export async function runSessionStateMcpServer(options?: {
  inputStream?: NodeJS.ReadStream;
  errorStream?: NodeJS.WriteStream;
}): Promise<void> {
  const inputStream = options?.inputStream ?? input;
  const errorStream = options?.errorStream ?? stderr;
  let buffer = Buffer.alloc(0);
  let chain = Promise.resolve();

  const processBuffer = (): void => {
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const headerText = buffer.slice(0, headerEnd).toString("utf8");
      const contentLengthMatch = headerText.match(/content-length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const contentLength = Number(contentLengthMatch[1] || 0);
      const frameEnd = headerEnd + 4 + contentLength;
      if (buffer.length < frameEnd) {
        return;
      }
      const body = buffer.slice(headerEnd + 4, frameEnd).toString("utf8");
      buffer = buffer.slice(frameEnd);
      chain = chain.then(async () => {
        try {
          await handleRequest(JSON.parse(body));
        } catch (error) {
          errorStream.write(`${String((error as Error)?.message || error)}\n`);
        }
      });
    }
  };

  inputStream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    processBuffer();
  });

  await new Promise<void>((resolve) => {
    inputStream.on("end", () => {
      void chain.finally(resolve);
    });
  });
}
