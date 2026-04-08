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
    conflictHistory: [],
    evidenceRevision: 0,
    pendingEvidence: [],
    lastMergedEvidenceAt: null,
    lastMergedEvidenceBy: null,
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

test("researchers only see actionable and directly targeted subgoals in relevant memory", () => {
  const session = createSessionFixture();
  pushSubgoal(session, {
    id: "sg-1",
    title: "Owned research slice",
    topicKey: "owned-research-slice",
    stage: "researching",
    decisionState: "open",
    revision: 4,
  });
  pushSubgoal(session, {
    id: "sg-2",
    title: "Targeted disputed slice",
    topicKey: "targeted-disputed-slice",
    stage: "researching",
    decisionState: "disputed",
    revision: 7,
  });
  pushSubgoal(session, {
    id: "sg-3",
    title: "Unrelated disputed slice",
    topicKey: "unrelated-disputed-slice",
    stage: "ready_for_build",
    decisionState: "disputed",
    assigneeAgentId: "coordinator_1",
    revision: 9,
  });

  const researcher = session.agents.get("researcher_1");
  const digest = {
    latestGoal: null,
    operatorEvents: [],
    directInputs: [],
    channelEvents: {
      research: [{
        sequence: 10,
        sender: "coordinator_1",
        channel: "research",
        content: "Look at sg-2",
        metadata: {
          targetAgentId: "researcher_1",
          targetAgentIds: ["researcher_1"],
          subgoalIds: ["sg-2"],
        },
      }],
    },
    otherEvents: [],
    totalCount: 1,
    maxSequence: 10,
  };

  const relevant = boardView.relevantSubgoalsForAgent(session, researcher, digest).map((subgoal) => subgoal.id).sort();
  assert.deepEqual(relevant, ["sg-1", "sg-2"]);
});

test("only the canonical research owner sees a researching card as actionable", () => {
  const session = createSessionFixture();
  pushSubgoal(session, {
    id: "sg-1",
    title: "Owned research slice",
    topicKey: "owned-research-slice",
    stage: "researching",
    decisionState: "open",
    assigneeAgentId: "researcher_1",
    updatedBy: "researcher_1",
    revision: 4,
  });

  const researcher1 = session.agents.get("researcher_1");
  const researcher2 = session.agents.get("researcher_2");

  assert.deepEqual(boardView.actionableSubgoalsForAgent(session, researcher1).map((subgoal) => subgoal.id), ["sg-1"]);
  assert.deepEqual(boardView.actionableSubgoalsForAgent(session, researcher2).map((subgoal) => subgoal.id), []);
});

test("routing owners wake when downstream review work closes and frees the next queue decision", () => {
  const session = createSessionFixture();
  pushSubgoal(session, {
    id: "sg-1",
    title: "Queued build slice",
    topicKey: "queued-build-slice",
    stage: "ready_for_build",
    decisionState: "resolved",
    assigneeAgentId: "coordinator_1",
    revision: 10,
  });
  pushSubgoal(session, {
    id: "sg-2",
    title: "Active review slice",
    topicKey: "active-review-slice",
    stage: "ready_for_review",
    decisionState: "resolved",
    assigneeAgentId: "reviewer_1",
    revision: 12,
  });

  const coordinator = session.agents.get("coordinator_1");
  coordinator.snapshot.lastSeenRoutingSignature = boardView.routingAttentionSignature(session, coordinator);

  assert.equal(boardView.goalBoardNeedsAttention(session, coordinator), false);

  session.subgoals[1].stage = "done";
  session.subgoals[1].assigneeAgentId = null;
  session.subgoals[1].revision = 13;

  assert.equal(boardView.goalBoardNeedsAttention(session, coordinator), true);
});
