const test = require("node:test");
const assert = require("node:assert/strict");

const subgoals = require("../dist/server/session/subgoals.js");
const { createSessionFixture } = require("./helpers/session-fixture.cjs");

function addBaseSubgoal(session, overrides = {}) {
  session.subgoals.push({
    id: "sg-1",
    title: "Subtitle contract",
    topicKey: "subtitle-contract",
    summary: "Track subtitle behavior",
    facts: [],
    openQuestions: [],
    resolvedDecisions: [],
    acceptanceCriteria: [],
    relevantFiles: [],
    nextAction: "Investigate",
    stage: "researching",
    decisionState: "disputed",
    lastReopenReason: "Need evidence",
    assigneeAgentId: null,
    mergedIntoSubgoalId: null,
    archivedAt: null,
    archivedBy: null,
    updatedAt: "2026-03-28T00:00:00.000Z",
    updatedBy: "researcher_1",
    revision: 1,
    conflictCount: 0,
    activeConflict: false,
    lastConflictAt: null,
    lastConflictSummary: null,
    evidenceRevision: 0,
    pendingEvidence: [],
    ...overrides,
  });
}

test("resetGoalBoard clears subgoals and resets agent revision markers", () => {
  const session = createSessionFixture();
  addBaseSubgoal(session);
  session.agents.get("researcher_1").snapshot.lastSeenSubgoalRevision = 9;
  session.agents.get("coordinator_1").snapshot.lastSeenSubgoalRevision = 4;

  subgoals.resetGoalBoard(session, "new goal", "operator");

  assert.deepEqual(session.subgoals, []);
  assert.equal(session.subgoalRevision, 1);
  assert.equal(session.agents.get("researcher_1").snapshot.lastSeenSubgoalRevision, 0);
  assert.equal(session.agents.get("coordinator_1").snapshot.lastSeenSubgoalRevision, 0);
});

test("applySubgoalUpdates creates subgoals, reuses exact topic keys, and archives merges", () => {
  const session = createSessionFixture();

  let result = subgoals.applySubgoalUpdates(session, "researcher_1", [{
    title: "Subtitle contract",
    topicKey: "subtitle-contract",
    summary: "Investigate subtitle timing",
    addFacts: ["timing drifts"],
    stage: "researching",
  }]);
  assert.deepEqual(result.changedIds, ["sg-1"]);
  assert.equal(session.subgoals.length, 1);
  assert.equal(session.subgoals[0].topicKey, "subtitle-contract");

  result = subgoals.applySubgoalUpdates(session, "researcher_2", [{
    topicKey: "subtitle-contract",
    addFacts: ["second finding"],
  }]);
  assert.deepEqual(result.changedIds, ["sg-1"]);
  assert.deepEqual(result.stateChangedIds, []);
  assert.deepEqual(result.evidenceChangedIds, ["sg-1"]);
  assert.equal(session.subgoals.length, 1);
  assert.deepEqual(session.subgoals[0].facts, ["timing drifts"]);
  assert.equal(session.subgoals[0].evidenceRevision, 1);
  assert.equal(session.subgoals[0].pendingEvidence.length, 1);
  assert.deepEqual(session.subgoals[0].pendingEvidence[0].facts, ["second finding"]);

  result = subgoals.applySubgoalUpdates(session, "researcher_1", [{
    title: "Chat ranking",
    topicKey: "chat-ranking",
    summary: "Investigate chat ranking",
    stage: "ready_for_build",
    decisionState: "resolved",
  }]);
  assert.equal(session.subgoals.length, 2);
  assert.equal(session.subgoals[1].assigneeAgentId, "coordinator_1");

  result = subgoals.applySubgoalUpdates(session, "coordinator_1", [{
    id: "sg-2",
    mergedIntoSubgoalId: "sg-1",
  }]);
  assert.deepEqual(result.changedIds, ["sg-2"]);
  assert.equal(session.subgoals[1].mergedIntoSubgoalId, "sg-1");
  assert.equal(Boolean(session.subgoals[1].archivedAt), true);
  assert.equal(subgoals.canonicalSubgoalForId(session, "sg-2").id, "sg-1");
});

test("research card creator becomes the canonical owner and only that owner sees it as actionable", () => {
  const session = createSessionFixture();

  const result = subgoals.applySubgoalUpdates(session, "researcher_1", [{
    title: "Archive provenance",
    topicKey: "archive-provenance",
    summary: "Check archive provenance",
    stage: "researching",
  }]);

  assert.deepEqual(result.changedIds, ["sg-1"]);
  assert.equal(session.subgoals[0].assigneeAgentId, "researcher_1");
});

test("canonical owner can merge pending evidence into the research card", () => {
  const session = createSessionFixture();
  addBaseSubgoal(session, {
    assigneeAgentId: "researcher_1",
    updatedBy: "researcher_1",
    facts: ["initial fact"],
  });

  subgoals.applySubgoalUpdates(session, "researcher_2", [{
    id: "sg-1",
    expectedRevision: 1,
    summary: "second opinion",
    addFacts: ["second fact"],
    addOpenQuestions: ["does the shard match?"],
  }]);

  assert.equal(session.subgoals[0].pendingEvidence.length, 1);
  assert.equal(session.subgoals[0].revision, 1);

  const merged = subgoals.applySubgoalUpdates(session, "researcher_1", [{
    id: "sg-1",
    expectedRevision: 1,
    summary: "merged canonical summary",
    addFacts: ["merged fact"],
    decisionState: "resolved",
    stage: "ready_for_build",
  }]);

  assert.deepEqual(merged.stateChangedIds, ["sg-1"]);
  assert.equal(session.subgoals[0].pendingEvidence.length, 0);
  assert.equal(session.subgoals[0].summary, "merged canonical summary");
  assert.deepEqual(session.subgoals[0].facts, ["initial fact", "merged fact"]);
  assert.equal(session.subgoals[0].stage, "ready_for_build");
});

test("applySubgoalUpdates records stale conflicts and normalizes build ownership", () => {
  const session = createSessionFixture();
  addBaseSubgoal(session, {
    revision: 3,
    stage: "ready_for_build",
    decisionState: "resolved",
    assigneeAgentId: "coordinator_1",
  });

  const stale = subgoals.applySubgoalUpdates(session, "researcher_1", [{
    id: "sg-1",
    expectedRevision: 2,
    stage: "researching",
    reopenReason: "old branch",
  }]);
  assert.equal(stale.conflicts.length, 1);
  assert.equal(stale.conflicts[0].reason, "stale_update");
  assert.equal(session.subgoals[0].conflictCount, 1);
  assert.equal(session.subgoals[0].activeConflict, true);

  const createBuild = subgoals.applySubgoalUpdates(session, "researcher_1", [{
    title: "Execution slice",
    topicKey: "execution-slice",
    summary: "small implementation task",
    stage: "building",
    decisionState: "resolved",
  }]);
  const created = session.subgoals.find((item) => item.topicKey === "execution-slice");
  assert.equal(created.stage, "ready_for_build");
  assert.equal(created.assigneeAgentId, "coordinator_1");
  assert.equal(createBuild.blockedBuildPromotion, true);
});

test("researchers cannot clear an active conflict on a shared research card", () => {
  const session = createSessionFixture();
  addBaseSubgoal(session, {
    revision: 5,
    stage: "researching",
    decisionState: "disputed",
    assigneeAgentId: "researcher_1",
    activeConflict: true,
    lastConflictAt: "2026-03-28T00:05:00.000Z",
    lastConflictSummary: "Conflict on sg-1: stale research update",
    conflictCount: 3,
  });

  const result = subgoals.applySubgoalUpdates(session, "researcher_3", [{
    id: "sg-1",
    expectedRevision: 5,
    addFacts: ["new supporting evidence"],
    summary: "updated summary from researcher",
    decisionState: "resolved",
  }]);

  assert.deepEqual(result.conflicts, []);
  assert.equal(session.subgoals[0].activeConflict, true);
  assert.equal(session.subgoals[0].lastConflictSummary, "Conflict on sg-1: stale research update");
  assert.equal(session.subgoals[0].conflictCount, 3);
  assert.deepEqual(session.subgoals[0].facts, []);
  assert.equal(session.subgoals[0].pendingEvidence.length, 1);
  assert.equal(session.subgoals[0].pendingEvidence[0].summary, "updated summary from researcher");
  assert.deepEqual(session.subgoals[0].pendingEvidence[0].facts, ["new supporting evidence"]);
});

test("coordinators can clear an active conflict while updating the card", () => {
  const session = createSessionFixture();
  addBaseSubgoal(session, {
    revision: 5,
    stage: "researching",
    decisionState: "disputed",
    activeConflict: true,
    lastConflictAt: "2026-03-28T00:05:00.000Z",
    lastConflictSummary: "Conflict on sg-1: stale research update",
    conflictCount: 3,
  });

  const result = subgoals.applySubgoalUpdates(session, "coordinator_1", [{
    id: "sg-1",
    expectedRevision: 5,
    summary: "coordinator reviewed the conflict and kept the card in research",
    decisionState: "resolved",
    stage: "ready_for_build",
  }]);

  assert.deepEqual(result.conflicts, []);
  assert.equal(session.subgoals[0].activeConflict, false);
  assert.equal(session.subgoals[0].lastConflictSummary, null);
  assert.equal(session.subgoals[0].stage, "ready_for_build");
  assert.equal(session.subgoals[0].decisionState, "resolved");
});

test("coordinator can create a resolved build slice directly in building for the implementer", () => {
  const session = createSessionFixture();

  const result = subgoals.applySubgoalUpdates(session, "coordinator_1", [{
    title: "Execution fallback",
    topicKey: "execution-fallback",
    summary: "Implement the next replay execution fix",
    stage: "building",
    decisionState: "resolved",
    assigneeAgentId: "implementer_1",
  }]);

  const created = session.subgoals.find((item) => item.topicKey === "execution-fallback");
  assert.ok(created);
  assert.equal(created.stage, "building");
  assert.equal(created.assigneeAgentId, "implementer_1");
  assert.equal(result.blockedBuildPromotion, false);
});

test("downstream stale conflicts become reopen suggestions only when a build or review card is pushed upstream", () => {
  const session = createSessionFixture();
  addBaseSubgoal(session, {
    revision: 4,
    stage: "building",
    decisionState: "resolved",
    assigneeAgentId: "implementer_1",
  });

  const stale = subgoals.applySubgoalUpdates(session, "researcher_1", [{
    id: "sg-1",
    expectedRevision: 3,
    stage: "researching",
    reopenReason: "new evidence invalidates the build assumption",
  }]);

  assert.equal(stale.conflicts.length, 1);
  assert.equal(stale.conflicts[0].reason, "reopen_suggestion");
});

test("done stale conflicts become soft notes or reopen suggestions", () => {
  const session = createSessionFixture();
  addBaseSubgoal(session, {
    stage: "done",
    decisionState: "resolved",
    revision: 7,
    assigneeAgentId: null,
  });

  const soft = subgoals.buildStaleSubgoalConflict(session, "reviewer_1", session.subgoals[0], {
    id: "sg-1",
    expectedRevision: 6,
    stage: "done",
  }, "done");
  assert.equal(soft.reason, "done_soft_note");

  const reopen = subgoals.buildStaleSubgoalConflict(session, "researcher_1", session.subgoals[0], {
    id: "sg-1",
    expectedRevision: 6,
    stage: "researching",
  }, "researching");
  assert.equal(reopen.reason, "done_reopen_suggestion");

  subgoals.recordSubgoalConflicts(session, [soft]);
  assert.equal(session.subgoals[0].activeConflict, false);
  assert.match(session.subgoals[0].lastConflictSummary, /rev 6/);
});
