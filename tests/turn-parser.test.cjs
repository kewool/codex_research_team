const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hasStructuredResponseEnvelope,
  looksLikeBroadDataLoadCommand,
  looksLikeWriteProbeCommand,
  parseAgentTurnResult,
} = require("../dist/server/runtime/turn-parser.js");

function wrap(payload) {
  return `<codex_research_team-response>${payload}</codex_research_team-response>`;
}

test("turn parser accepts multi-message payloads with per-message subgoal ids", () => {
  const result = parseAgentTurnResult(wrap(JSON.stringify({
    shouldReply: true,
    workingNotes: ["note"],
    teamMessages: [
      { content: "build handoff", targetAgentId: "implementer_1", subgoalIds: ["sg-1"] },
      { content: "research follow-up", targetAgentIds: ["researcher_2", "researcher_3"], subgoalIds: ["sg-2"] },
    ],
    subgoalUpdates: [
      { subgoalId: "sg-1", stage: "building", expectedRevision: 4 },
    ],
    completion: "continue",
  })));

  assert.equal(result.shouldReply, true);
  assert.deepEqual(result.teamMessages.map((item) => item.subgoalIds), [["sg-1"], ["sg-2"]]);
  assert.deepEqual(result.subgoalUpdates[0], { id: "sg-1", expectedRevision: 4, stage: "building" });
});

test("turn parser accepts message as a legacy alias for teamMessages content", () => {
  const result = parseAgentTurnResult(wrap(JSON.stringify({
    shouldReply: true,
    workingNotes: ["note"],
    teamMessages: [
      { targetAgentId: "coordinator_1", message: "handoff from legacy field" },
    ],
    completion: "continue",
  })));

  assert.deepEqual(result.teamMessages, [{
    content: "handoff from legacy field",
    targetAgentId: "coordinator_1",
    targetAgentIds: ["coordinator_1"],
  }]);
});

test("turn parser accepts owner and assignee aliases for subgoal assignees", () => {
  const result = parseAgentTurnResult(wrap(JSON.stringify({
    shouldReply: true,
    subgoalUpdates: [
      { subgoalId: "sg-1", owner: "researcher_3", stage: "researching" },
      { subgoalId: "sg-2", ownerAgentId: "researcher_2", stage: "researching" },
      { subgoalId: "sg-3", assignee: "implementer_1", stage: "building" },
    ],
    completion: "continue",
  })));

  assert.deepEqual(result.subgoalUpdates, [
    { id: "sg-1", stage: "researching", assigneeAgentId: "researcher_3" },
    { id: "sg-2", stage: "researching", assigneeAgentId: "researcher_2" },
    { id: "sg-3", stage: "building", assigneeAgentId: "implementer_1" },
  ]);
});

test("turn parser falls back to legacy teamMessage fields", () => {
  const result = parseAgentTurnResult(wrap(JSON.stringify({
    shouldReply: true,
    teamMessage: "legacy message",
    targetAgentIds: ["coordinator_1"],
    completion: "done",
  })));

  assert.deepEqual(result.teamMessages, [{
    content: "legacy message",
    targetAgentId: "coordinator_1",
    targetAgentIds: ["coordinator_1"],
  }]);
  assert.equal(result.completion, "done");
});

test("turn parser repairs malformed json payloads", () => {
  const malformed = wrap("{shouldReply:true,teamMessage:'hi',completion:'blocked',}");
  const result = parseAgentTurnResult(malformed);
  assert.equal(result.teamMessages[0].content, "hi");
  assert.equal(result.completion, "blocked");
});

test("turn parser repairs duplicated array keys inside subgoal updates", () => {
  const malformed = wrap(
    '{"shouldReply":true,"workingNotes":["note"],"teamMessages":[],"subgoalUpdates":[{"id":"sg-12","expectedRevision":159,"summary":"Route the narrow shared-input reuse slice into implementation for the several-thousand-case direct batch path.","addFacts":["The canonical build contract is the rev159 shared-input amortization handoff, not the stale rev152 build-ready note.","addFacts":["Replay should inherit the same reuse through batch.main rather than a separate replay-only cache surface."]],"nextAction":"implementer_1 should add batch-local distinct-input reuse plus the counted 40-case shared-corpus regression, then hand sg-12 to review.","stage":"building","decisionState":"resolved","assigneeAgentId":"implementer_1"}],"completion":"continue"}',
  );
  const result = parseAgentTurnResult(malformed);
  assert.equal(result.subgoalUpdates.length, 1);
  assert.deepEqual(result.subgoalUpdates[0].addFacts, [
    "The canonical build contract is the rev159 shared-input amortization handoff, not the stale rev152 build-ready note.",
    "Replay should inherit the same reuse through batch.main rather than a separate replay-only cache surface.",
  ]);
});

test("turn parser helpers detect envelopes and command patterns", () => {
  assert.equal(hasStructuredResponseEnvelope("x<codex_research_team-response>{}</codex_research_team-response>y"), true);
  assert.equal(looksLikeWriteProbeCommand('powershell -Command "New-Item foo.txt"'), true);
  assert.equal(looksLikeWriteProbeCommand('rg "TODO" src'), false);
  assert.equal(looksLikeBroadDataLoadCommand("python -c \"import pandas as pd; pd.read_csv('big.csv')\""), true);
  assert.equal(looksLikeBroadDataLoadCommand("pytest tests/test_small.py"), false);
});
