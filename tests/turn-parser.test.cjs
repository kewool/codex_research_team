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

test("turn parser helpers detect envelopes and command patterns", () => {
  assert.equal(hasStructuredResponseEnvelope("x<codex_research_team-response>{}</codex_research_team-response>y"), true);
  assert.equal(looksLikeWriteProbeCommand('powershell -Command "New-Item foo.txt"'), true);
  assert.equal(looksLikeWriteProbeCommand('rg "TODO" src'), false);
  assert.equal(looksLikeBroadDataLoadCommand("python -c \"import pandas as pd; pd.read_csv('big.csv')\""), true);
  assert.equal(looksLikeBroadDataLoadCommand("pytest tests/test_small.py"), false);
});
