const test = require("node:test");
const assert = require("node:assert/strict");

const {
  callSessionStateTool,
  sessionStateToolDefinitions,
} = require("../dist/server/runtime/session-mcp.js");

function createEnv() {
  return {
    CRT_SERVER_URL: "http://127.0.0.1:4280",
    CRT_SESSION_ID: "session-1",
    CRT_AGENT_ID: "researcher_1",
  };
}

function createSnapshot() {
  return {
    id: "session-1",
    subgoals: [
      {
        id: "sg-1",
        title: "Archive provenance",
        topicKey: "archive-provenance",
        summary: "Check whether the archive manifests still match the recorded run.",
        facts: ["resolved manifest sha does not match current files"],
        openQuestions: ["which manifest is canonical?"],
        resolvedDecisions: [],
        acceptanceCriteria: [],
        relevantFiles: ["flow_runtime/replay_manifest.json"],
        nextAction: "confirm the canonical manifest source",
        stage: "researching",
        decisionState: "disputed",
        assigneeAgentId: "researcher_2",
        revision: 12,
        discussionRevision: 4,
        conflictCount: 2,
        activeConflict: true,
        mergedIntoSubgoalId: null,
        archivedAt: null,
        discussionMessages: [
          {
            id: "msg-1",
            timestamp: "2026-04-09T00:00:00.000Z",
            agentId: "researcher_3",
            content: "local archive scan still mismatches both recorded digests",
          },
        ],
        conflictHistory: [
          {
            timestamp: "2026-04-09T00:01:00.000Z",
            reason: "stale_update",
            agentId: "researcher_1",
            summary: "researcher_1 used rev 10 while the card was already rev 12",
            expectedRevision: 10,
            currentRevision: 12,
            requestedStage: "researching",
            currentStage: "researching",
            currentAssigneeAgentId: "researcher_2",
          },
        ],
      },
      {
        id: "sg-2",
        title: "Archived duplicate",
        topicKey: "archive-provenance-duplicate",
        summary: "superseded duplicate",
        stage: "done",
        decisionState: "resolved",
        assigneeAgentId: null,
        revision: 3,
        discussionRevision: 0,
        discussionMessages: [],
        conflictHistory: [],
        conflictCount: 0,
        activeConflict: false,
        mergedIntoSubgoalId: "sg-1",
        archivedAt: "2026-04-09T00:02:00.000Z",
      },
    ],
  };
}

function createEventPage() {
  return {
    items: [
      {
        sequence: 41,
        timestamp: "2026-04-09T00:03:00.000Z",
        sender: "researcher_3",
        channel: "research",
        content: "archive mismatch still unresolved",
        metadata: {
          targetAgentId: "coordinator_1",
          targetAgentIds: ["coordinator_1"],
          subgoalIds: ["sg-1"],
        },
      },
      {
        sequence: 40,
        timestamp: "2026-04-09T00:02:30.000Z",
        sender: "system",
        channel: "system",
        content: "Conflict on sg-1",
        metadata: {
          subgoalIds: ["sg-1"],
        },
      },
    ],
    nextBefore: null,
    hasMore: false,
  };
}

function createHistoryPage() {
  return {
    items: [
      {
        id: "notes-1",
        timestamp: "2026-04-09T00:04:00.000Z",
        kind: "notes",
        label: "Turn 9",
        text: "Need to verify the archived manifest lineage.",
        metadata: {
          subgoalIds: ["sg-1"],
        },
      },
    ],
    nextBefore: null,
    hasMore: false,
  };
}

function fetchHarness(snapshot, options = {}) {
  return async (url, init = {}) => {
    const normalized = String(url);
    assert.match(normalized, /session-1/);
    if (normalized.includes("/feed?")) {
      return {
        ok: true,
        async json() {
          return options.eventPage ?? createEventPage();
        },
      };
    }
    if (normalized.includes("/history?")) {
      return {
        ok: true,
        async json() {
          return options.historyPage ?? createHistoryPage();
        },
      };
    }
    if (normalized.includes("/discussion") && String(init?.method || "GET").toUpperCase() === "POST") {
      const payload = JSON.parse(String(init?.body || "{}"));
      return {
        ok: true,
        async json() {
          return { ok: true, appended: payload };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return { session: snapshot };
      },
    };
  };
}

test("session-state MCP tools are advertised", () => {
  const tools = sessionStateToolDefinitions().map((tool) => tool.name);
  assert.deepEqual(tools, [
    "list_session_events",
    "get_agent_history",
    "list_subgoals",
    "get_subgoal",
    "list_subgoal_discussion",
    "append_subgoal_discussion",
    "get_subgoal_conflicts",
  ]);
});

test("list_subgoals returns compact live subgoal state and hides archived cards by default", async () => {
  const snapshot = createSnapshot();
  const result = await callSessionStateTool("list_subgoals", {}, {
    env: createEnv(),
    fetchImpl: fetchHarness(snapshot),
  });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.sessionId, "session-1");
  assert.equal(payload.subgoals.length, 1);
  assert.equal(payload.subgoals[0].id, "sg-1");
  assert.equal(payload.subgoals[0].discussionCount, 1);
});

test("list_subgoal_discussion and get_subgoal_conflicts return detailed append-only state", async () => {
  const snapshot = createSnapshot();
  const env = createEnv();

  const discussionResult = await callSessionStateTool("list_subgoal_discussion", { subgoal_id: "sg-1" }, {
    env,
    fetchImpl: fetchHarness(snapshot),
  });
  const conflictResult = await callSessionStateTool("get_subgoal_conflicts", { subgoal_id: "sg-1" }, {
    env,
    fetchImpl: fetchHarness(snapshot),
  });

  const discussionPayload = JSON.parse(discussionResult.content[0].text);
  const conflictPayload = JSON.parse(conflictResult.content[0].text);

  assert.equal(discussionPayload.total, 1);
  assert.equal(discussionPayload.discussion[0].agentId, "researcher_3");
  assert.equal(conflictPayload.total, 1);
  assert.equal(conflictPayload.conflicts[0].reason, "stale_update");
});

test("append_subgoal_discussion posts one discussion message for the current agent", async () => {
  const snapshot = createSnapshot();
  const result = await callSessionStateTool("append_subgoal_discussion", {
    subgoal_id: "sg-1",
    content: "please double-check the archive provenance",
  }, {
    env: createEnv(),
    fetchImpl: fetchHarness(snapshot),
  });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.subgoalId, "sg-1");
  assert.equal(payload.agentId, "researcher_1");
  assert.equal(payload.appended, true);
});

test("list_session_events returns filtered feed events", async () => {
  const snapshot = createSnapshot();
  const result = await callSessionStateTool("list_session_events", {
    target_agent_id: "coordinator_1",
    subgoal_id: "sg-1",
    limit: 5,
  }, {
    env: createEnv(),
    fetchImpl: fetchHarness(snapshot),
  });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.total, 1);
  assert.equal(payload.events[0].sequence, 41);
  assert.deepEqual(payload.events[0].targetAgentIds, ["coordinator_1"]);
  assert.deepEqual(payload.events[0].subgoalIds, ["sg-1"]);
  assert.equal(payload.hasMore, false);
});

test("get_agent_history returns persisted agent-local history", async () => {
  const snapshot = createSnapshot();
  const result = await callSessionStateTool("get_agent_history", {
    agent_id: "researcher_1",
    kind: "notes",
    limit: 5,
  }, {
    env: createEnv(),
    fetchImpl: fetchHarness(snapshot),
  });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.agentId, "researcher_1");
  assert.equal(payload.kind, "notes");
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].label, "Turn 9");
});
