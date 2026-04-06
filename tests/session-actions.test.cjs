const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createSessionActionTools,
  shouldTriggerBottomLoad,
} = require("../dist/client/app/session-actions.js");

function createHarness(overrides = {}) {
  const commandInput = { value: "send this" };
  const targetInput = { value: "coordinator_1" };
  const calls = {
    api: [],
    bindSessionStream: 0,
    loadSessionFeed: [],
    upsertSession: [],
    clearFlash: 0,
    render: 0,
    setFlash: [],
  };
  const state = {
    stream: overrides.stream ?? null,
    sessionUi: {},
  };
  const session = overrides.session ?? { id: "session-1", isLive: true };
  const deps = {
    state,
    currentSession: () => session,
    currentAgentTab: () => "notes",
    historyKindForTab: () => "notes",
    feedCache: () => ({ loading: false, hasMore: false }),
    agentHistoryCache: () => ({ loading: false, hasMore: false }),
    saveElementScrollAnchor() {},
    loadSessionFeed: async (sessionId, options) => {
      calls.loadSessionFeed.push([sessionId, options]);
    },
    loadAgentHistory: async () => {},
    loadVisibleAgentHistory: async () => {},
    setFlash: (kind, text) => {
      calls.setFlash.push([kind, text]);
    },
    clearFlash: () => {
      calls.clearFlash += 1;
    },
    api: async (path, init) => {
      calls.api.push([path, init]);
      return { session: overrides.responseSession ?? { id: "session-1", isLive: true } };
    },
    qs: (selector) => {
      if (selector === "#session-command") {
        return commandInput;
      }
      if (selector === "#session-target") {
        return targetInput;
      }
      throw new Error(`Unexpected selector: ${selector}`);
    },
    upsertSession: (snapshot) => {
      calls.upsertSession.push(snapshot);
    },
    refreshState: async () => {},
    bindSessionStream: () => {
      calls.bindSessionStream += 1;
    },
    render: () => {
      calls.render += 1;
    },
  };
  return {
    calls,
    commandInput,
    tools: createSessionActionTools(deps),
  };
}

test("sendSessionCommand refreshes feed without rebinding an already-live session stream", async () => {
  const { calls, commandInput, tools } = createHarness({
    stream: { close() {} },
    session: { id: "session-1", isLive: true },
    responseSession: { id: "session-1", isLive: true },
  });

  await tools.sendSessionCommand("operator");

  assert.equal(calls.bindSessionStream, 0);
  assert.deepEqual(calls.loadSessionFeed, [["session-1", { reset: true, force: true }]]);
  assert.equal(commandInput.value, "");
  assert.equal(calls.clearFlash, 1);
});

test("sendSessionCommand rebinds the stream when reviving a saved idle session", async () => {
  const { calls, tools } = createHarness({
    stream: null,
    session: { id: "session-1", isLive: false },
    responseSession: { id: "session-1", isLive: true },
  });

  await tools.sendSessionCommand("operator");

  assert.equal(calls.bindSessionStream, 1);
  assert.deepEqual(calls.loadSessionFeed, [["session-1", { reset: true, force: true }]]);
});

test("shouldTriggerBottomLoad fires once until the user scrolls away from the bottom", () => {
  const cache = {
    loading: false,
    hasMore: true,
    bottomLoadLocked: false,
  };
  const element = {
    scrollTop: 880,
    clientHeight: 120,
    scrollHeight: 1000,
  };

  assert.equal(shouldTriggerBottomLoad(cache, element), true);
  assert.equal(cache.bottomLoadLocked, true);
  assert.equal(shouldTriggerBottomLoad(cache, element), false);

  element.scrollTop = 640;
  assert.equal(shouldTriggerBottomLoad(cache, element), false);
  assert.equal(cache.bottomLoadLocked, false);

  element.scrollTop = 881;
  assert.equal(shouldTriggerBottomLoad(cache, element), true);
});
