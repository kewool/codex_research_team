const test = require("node:test");
const assert = require("node:assert/strict");

const boardView = require("../dist/server/session/board-view.js");
const { createSessionFixture } = require("./helpers/session-fixture.cjs");

function pushSubgoal(session, overrides = {}) {
  session.subgoals.push({
    id: `sg-${session.subgoals.length + 1}`,
    title: "Test subgoal",
    topicKey: `test-subgoal-${session.subgoals.length + 1}`,
    summary: "Test summary",
    facts: [],
    openQuestions: [],
    resolvedDecisions: [],
    acceptanceCriteria: [],
    relevantFiles: [],
    nextAction: "Do the next thing",
    stage: "researching",
    decisionState: "disputed",
    lastReopenReason: null,
    assigneeAgentId: null,
    mergedIntoSubgoalId: null,
    archivedAt: null,
    archivedBy: null,
    updatedAt: "2026-03-31T00:00:00.000Z",
    updatedBy: "researcher_1",
    revision: 1,
    conflictCount: 0,
    activeConflict: false,
    lastConflictAt: null,
    lastConflictSummary: null,
    ...overrides,
  });
}

test("researchers do not wake when only unrelated downstream cards change", () => {
  const session = createSessionFixture();
  pushSubgoal(session, {
    id: "sg-1",
    title: "Research slice",
    topicKey: "research-slice",
    stage: "researching",
    decisionState: "disputed",
    revision: 4,
  });
  pushSubgoal(session, {
    id: "sg-2",
    title: "Build slice",
    topicKey: "build-slice",
    stage: "building",
    decisionState: "resolved",
    assigneeAgentId: "implementer_1",
    revision: 9,
  });

  const researcher = session.agents.get("researcher_1");
  researcher.snapshot.lastSeenActionableSignature = boardView.actionableSubgoalSignature(session, researcher);

  assert.equal(boardView.goalBoardNeedsAttention(session, researcher), false);

  session.subgoals[1].revision = 10;
  session.subgoals[1].updatedAt = "2026-03-31T00:01:00.000Z";

  assert.equal(boardView.goalBoardNeedsAttention(session, researcher), false);

  session.subgoals[0].revision = 5;
  session.subgoals[0].updatedAt = "2026-03-31T00:02:00.000Z";

  assert.equal(boardView.goalBoardNeedsAttention(session, researcher), true);
});

test("researchers do not wake when a research card is handed off downstream", () => {
  const session = createSessionFixture();
  pushSubgoal(session, {
    id: "sg-1",
    title: "Primary research slice",
    topicKey: "primary-research-slice",
    stage: "researching",
    decisionState: "disputed",
    revision: 4,
  });
  pushSubgoal(session, {
    id: "sg-2",
    title: "Secondary research slice",
    topicKey: "secondary-research-slice",
    stage: "researching",
    decisionState: "open",
    revision: 7,
  });

  const researcher = session.agents.get("researcher_1");
  researcher.snapshot.lastSeenActionableSignature = boardView.actionableSubgoalSignature(session, researcher);

  assert.equal(boardView.goalBoardNeedsAttention(session, researcher), false);

  session.subgoals[0].stage = "building";
  session.subgoals[0].decisionState = "resolved";
  session.subgoals[0].assigneeAgentId = "implementer_1";
  session.subgoals[0].revision = 5;

  assert.equal(boardView.goalBoardNeedsAttention(session, researcher), false);

  session.subgoals[1].revision = 8;

  assert.equal(boardView.goalBoardNeedsAttention(session, researcher), true);
});
