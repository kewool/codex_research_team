const test = require("node:test");
const assert = require("node:assert/strict");

const { createSessionPageRenderers } = require("../dist/client/app/session-page.js");

function createRendererHarness(options = {}) {
  const session = {
    id: "session-1",
    title: "Test Session",
    goal: "Test goal",
    status: "idle",
    isLive: true,
    workspaceName: "workspace",
    workspacePath: "D:/workspace",
    eventCount: 0,
    totalUsage: null,
    subgoalRevision: 3,
    agents: [],
    subgoals: [
      {
        id: "sg-1",
        title: "Active topic",
        summary: "Summary",
        stage: "researching",
        decisionState: "open",
        assigneeAgentId: null,
        revision: 1,
        conflictCount: 0,
        activeConflict: false,
        lastConflictSummary: null,
        conflictHistory: [
          {
            timestamp: "2026-04-03T00:30:00.000Z",
            reason: "stale_update",
            agentId: "researcher_3",
            summary: "researcher_3 proposed researching on rev 1 but the board is now rev 2",
            expectedRevision: 1,
            currentRevision: 2,
            requestedStage: "researching",
            currentStage: "researching",
            currentAssigneeAgentId: "researcher_1",
          },
        ],
        lastReopenReason: null,
        facts: [],
        openQuestions: [],
        resolvedDecisions: [],
        acceptanceCriteria: [],
        relevantFiles: [],
        nextAction: "",
        discussionRevision: 1,
        discussionMessages: [
          {
            id: "discussion-1",
            timestamp: "2026-04-03T00:00:00.000Z",
            agentId: "researcher_2",
            content: "Need to verify the archive mismatch and compare archive/replay_manifest.json",
          },
        ],
        mergedIntoSubgoalId: null,
        archivedAt: null,
      },
      {
        id: "sg-2",
        title: "Merged topic",
        summary: "Merged summary",
        stage: "done",
        decisionState: "resolved",
        assigneeAgentId: null,
        revision: 2,
        conflictCount: 0,
        activeConflict: false,
        lastConflictSummary: null,
        conflictHistory: [],
        lastReopenReason: null,
        facts: [],
        openQuestions: [],
        resolvedDecisions: [],
        acceptanceCriteria: [],
        relevantFiles: [],
        nextAction: "",
        discussionRevision: 0,
        discussionMessages: [],
        mergedIntoSubgoalId: "sg-1",
        archivedAt: "2026-04-03T00:00:00.000Z",
      },
    ],
    ...options.session,
  };
  const state = {
    selectedAgentId: null,
    selectedAgentTab: "notes",
    sessionUi: options.sessionUi || {},
  };
  return createSessionPageRenderers({
    state,
    escapeHtml: (value) => String(value),
    cleanTerminalText: (value) => String(value ?? ""),
    feedCache: () => ({ items: [], loaded: true, loading: false, hasMore: false }),
    agentHistoryCache: () => ({ items: [], loaded: true, loading: false, hasMore: false }),
    currentAgentTab: () => "notes",
    historyKindForTab: () => "notes",
    currentSession: () => session,
    ensureSelectedAgent: () => null,
    ensureSessionPageData: () => {},
    formatTokenUsage: () => "-",
    formatTokenCount: (value) => String(value ?? 0),
    tokenValue: () => 0,
    renderLabel: (text) => text,
  });
}

test("renderSessionPage preserves merged topics open state across rerenders", () => {
  const renderers = createRendererHarness({
    sessionUi: {
      "session-1": {
        mergedTopicsOpen: true,
      },
    },
  });

  const html = renderers.renderSessionPage();

  assert.match(html, /<details class="subgoal-archive"[^>]*data-session-id="session-1"[^>]* open>/);
});

test("renderSessionPage shows discussion threads on subgoal cards", () => {
  const renderers = createRendererHarness();

  const html = renderers.renderSessionPage();

  assert.match(html, /discussion 1/);
  assert.match(html, /Discussion/);
  assert.match(html, /Conflict History/);
  assert.match(html, /owner unassigned/);
  assert.match(html, /researcher_2/);
  assert.match(html, /Need to verify the archive mismatch/);
  assert.match(html, /archive\/replay_manifest\.json/);
});

test("renderSessionPage shows an empty discussion section when a subgoal has no discussion yet", () => {
  const renderers = createRendererHarness();

  const html = renderers.renderSessionPage();

  assert.match(html, /Discussion/);
  assert.match(html, /0 messages/);
  assert.match(html, /No discussion yet\./);
});
