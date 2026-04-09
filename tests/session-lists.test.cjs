const test = require("node:test");
const assert = require("node:assert/strict");

const { createSessionListTools } = require("../dist/client/app/session-lists.js");

function createSessions(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index + 1}`,
    title: `Session ${index + 1}`,
  }));
}

test("session lists expose a bounded initial slice and can load more", () => {
  const state = {
    snapshot: {
      sessions: createSessions(40),
    },
  };
  const tools = createSessionListTools({ state });

  assert.equal(tools.visibleSessions("rail").length, 16);
  assert.deepEqual(tools.sessionsMeta("rail"), {
    shownCount: 16,
    totalCount: 40,
    hasMore: true,
  });

  assert.equal(tools.loadMoreSessions("rail"), true);
  assert.equal(tools.visibleSessions("rail").length, 32);
  assert.deepEqual(tools.sessionsMeta("rail"), {
    shownCount: 32,
    totalCount: 40,
    hasMore: true,
  });
});

test("session lists stop reporting more items once the full list is visible", () => {
  const state = {
    snapshot: {
      sessions: createSessions(18),
    },
  };
  const tools = createSessionListTools({ state });

  assert.equal(tools.loadMoreSessions("rail"), true);
  assert.deepEqual(tools.sessionsMeta("rail"), {
    shownCount: 18,
    totalCount: 18,
    hasMore: false,
  });
  assert.equal(tools.loadMoreSessions("rail"), false);
});
