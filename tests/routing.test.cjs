const test = require("node:test");
const assert = require("node:assert/strict");

const { buildTranscript } = require("../dist/server/session/routing.js");
const { emptyPendingDigest } = require("../dist/server/session/digest.js");

function createAgent() {
  return {
    preset: {
      id: "researcher_1",
      name: "researcher_1",
      listenChannels: ["research", "operator", "goal"],
      policy: {
        ownedStages: ["researching"],
      },
    },
  };
}

function createSession(events) {
  return {
    recentEvents: events,
    goalChannel() {
      return "goal";
    },
    operatorChannel() {
      return "operator";
    },
    isGoalEvent(event) {
      return Boolean(event?.metadata?.goalEvent);
    },
    isOperatorEvent(event) {
      return Boolean(event?.metadata?.operatorEvent);
    },
    config: {
      defaults: {
        historyTail: 10,
      },
    },
  };
}

test("buildTranscript keeps operator context and targeted team messages only", () => {
  const transcript = buildTranscript(createSession([
    {
      sequence: 1,
      timestamp: "2026-04-09T00:00:00.000Z",
      sender: "researcher_2",
      channel: "research",
      content: "broadcast research note",
      metadata: {},
    },
    {
      sequence: 2,
      timestamp: "2026-04-09T00:00:01.000Z",
      sender: "researcher_3",
      channel: "research",
      content: "targeted research note",
      metadata: {
        targetAgentId: "researcher_1",
        targetAgentIds: ["researcher_1"],
      },
    },
    {
      sequence: 3,
      timestamp: "2026-04-09T00:00:02.000Z",
      sender: "operator",
      channel: "operator",
      content: "global operator note",
      metadata: {
        operatorEvent: true,
      },
    },
    {
      sequence: 4,
      timestamp: "2026-04-09T00:00:03.000Z",
      sender: "operator",
      channel: "operator",
      content: "targeted elsewhere",
      metadata: {
        operatorEvent: true,
        targetAgentId: "researcher_2",
        targetAgentIds: ["researcher_2"],
      },
    },
    {
      sequence: 5,
      timestamp: "2026-04-09T00:00:04.000Z",
      sender: "system",
      channel: "status",
      content: "status update",
      metadata: {},
    },
  ]), createAgent(), emptyPendingDigest());

  assert.match(transcript, /#2 researcher_3 -> research target=researcher_1: targeted research note/);
  assert.match(transcript, /#3 operator -> operator: global operator note/);
  assert.doesNotMatch(transcript, /broadcast research note/);
  assert.doesNotMatch(transcript, /targeted elsewhere/);
  assert.doesNotMatch(transcript, /status update/);
});

