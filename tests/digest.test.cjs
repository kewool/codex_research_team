const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  buildTriggerSummary,
  combinePendingDigests,
  digestEvents,
  digestSequences,
  emptyPendingDigest,
  hasPendingDigest,
  maxDigestSequence,
  mergePendingDigest,
  readSessionEvents,
} = require("../dist/server/session/digest.js");

function event(sequence, channel, content, metadata = undefined) {
  return {
    sequence,
    timestamp: `2026-03-28T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    sender: metadata?.operatorEvent ? "operator" : "agent",
    channel,
    content,
    ...(metadata ? { metadata } : {}),
  };
}

test("pending digests group goal, operator, channel, and other events", () => {
  let digest = emptyPendingDigest();
  digest = mergePendingDigest(digest, event(1, "goal", "new goal", { goalEvent: true }));
  digest = mergePendingDigest(digest, event(2, "operator", "direct", { operatorEvent: true, directInput: true }));
  digest = mergePendingDigest(digest, event(3, "operator", "directive", { operatorEvent: true }));
  digest = mergePendingDigest(digest, event(4, "research", "finding"));
  digest = mergePendingDigest(digest, event(5, "status", "idle"));

  assert.equal(hasPendingDigest(digest), true);
  assert.equal(maxDigestSequence(digest), 5);
  assert.deepEqual([...digestSequences(digest)], [1, 3, 2, 4, 5]);
  assert.deepEqual(digestEvents(digest).map((item) => item.sequence), [1, 2, 3, 4, 5]);

  const summary = buildTriggerSummary(digest);
  assert.match(summary, /Goal update:/);
  assert.match(summary, /Direct operator inputs:/);
  assert.match(summary, /Channel digest: research/);
  assert.match(summary, /Additional channel updates:/);
});

test("combinePendingDigests de-duplicates identical event sequences", () => {
  const left = mergePendingDigest(emptyPendingDigest(), event(1, "research", "a"));
  const right = mergePendingDigest(
    mergePendingDigest(emptyPendingDigest(), event(1, "research", "a")),
    event(2, "review", "b"),
  );

  const combined = combinePendingDigests(left, right);
  assert.deepEqual(digestEvents(combined).map((item) => item.sequence), [1, 2]);
});

test("readSessionEvents ignores malformed jsonl rows", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-digest-"));
  t.after(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });
  const filePath = path.join(rootDir, "events.jsonl");
  fs.writeFileSync(filePath, [
    JSON.stringify(event(1, "research", "ok")),
    "{broken",
    JSON.stringify({ ...event(2, "research", "bad"), sequence: 0 }),
    JSON.stringify(event(3, "review", "still ok")),
  ].join("\n"), "utf8");

  const events = readSessionEvents(filePath);
  assert.deepEqual(events.map((item) => item.sequence), [1, 3]);
});
