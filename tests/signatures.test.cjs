const test = require("node:test");
const assert = require("node:assert/strict");

const signatures = require("../dist/server/session/signatures.js");
const { createSessionFixture } = require("./helpers/session-fixture.cjs");

function addSubgoal(session, subgoal) {
  session.subgoals.push({
    id: "sg-1",
    title: "Topic",
    topicKey: "topic",
    summary: "Summary",
    facts: [],
    openQuestions: [],
    resolvedDecisions: [],
    acceptanceCriteria: [],
    relevantFiles: [],
    nextAction: "Implement",
    stage: "ready_for_build",
    decisionState: "resolved",
    lastReopenReason: null,
    assigneeAgentId: "coordinator_1",
    mergedIntoSubgoalId: null,
    archivedAt: null,
    archivedBy: null,
    updatedAt: "2026-03-28T00:00:00.000Z",
    updatedBy: "researcher_1",
    revision: 3,
    conflictCount: 0,
    activeConflict: false,
    lastConflictAt: null,
    lastConflictSummary: null,
    ...subgoal,
  });
}

test("routing and state signatures are stable across ordering", () => {
  const session = createSessionFixture();
  addSubgoal(session, { id: "sg-1" });
  addSubgoal(session, { id: "sg-2", stage: "building", assigneeAgentId: "implementer_1", revision: 4 });

  const routing = signatures.coordinationRoutingSignature(session, ["sg-2", "sg-1"], ["implementer_1", "researcher_1"]);
  const routingReordered = signatures.coordinationRoutingSignature(session, ["sg-1", "sg-2"], ["researcher_1", "implementer_1"]);
  assert.equal(routing, routingReordered);

  const state = signatures.subgoalStateSignature(session, ["sg-2", "sg-1"]);
  assert.match(state, /sg-1:ready_for_build:resolved:coordinator_1:Implement/);
  assert.match(state, /sg-2:building:resolved:implementer_1:Implement/);
});

test("status, coordination, and conflict dedupe use recent event metadata", () => {
  const session = createSessionFixture();
  const researcher = session.agents.get("researcher_1");
  const coordinator = session.agents.get("coordinator_1");
  addSubgoal(session, { id: "sg-1", stage: "researching", decisionState: "disputed", assigneeAgentId: null });

  const statusSignature = signatures.statusEventSignature(session, researcher, ["sg-1"], "blocked", false);
  session.recentEvents.push({
    sequence: 1,
    timestamp: "2026-03-28T00:00:01.000Z",
    sender: researcher.preset.name,
    channel: "status",
    content: "blocked",
    metadata: { statusSignature },
  });
  assert.equal(signatures.shouldSuppressDuplicateStatusEvent(session, researcher, statusSignature), true);

  const routingSignature = signatures.coordinationRoutingSignature(session, ["sg-1"], ["implementer_1"]);
  session.recentEvents.push({
    sequence: 2,
    timestamp: "2026-03-28T00:00:03.000Z",
    sender: coordinator.preset.name,
    channel: coordinator.preset.publishChannel,
    content: "route",
    metadata: { routingSignature },
  });
  assert.equal(signatures.shouldSuppressDuplicateCoordinationTurn(session, coordinator, ["sg-1"], ["implementer_1"]), true);

  const burstSignature = signatures.conflictBurstSignature([{
    reason: "reopen_suggestion",
    subgoalId: "sg-1",
    agentId: "researcher_2",
    currentStage: "researching",
    currentAssigneeAgentId: null,
  }], ["coordinator_1"]);
  session.recentEvents.push({
    sequence: 3,
    timestamp: "2026-03-28T00:00:04.000Z",
    sender: "system",
    channel: session.operatorChannel(),
    content: "conflict",
    metadata: {
      subgoalIds: ["sg-1"],
      conflictBurstSignature: burstSignature,
    },
  });
  assert.equal(signatures.shouldSuppressConflictBurst(session, "sg-1", burstSignature), true);
});
