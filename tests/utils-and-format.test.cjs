const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  appendLine,
  ensureDir,
  normalizePath,
  readJson,
  slugify,
  tailText,
  timestampSlug,
  writeJson,
} = require("../dist/server/lib/utils.js");
const {
  escapeHtml,
  formatLimitReset,
  formatPercent,
  formatRemainingPercent,
  formatTokenCount,
  formatTokenUsage,
} = require("../dist/client/app/format.js");

test("utility helpers normalize paths, slugs, and JSON persistence", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-utils-"));
  t.after(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  const nestedDir = ensureDir(path.join(rootDir, "a", "b"));
  assert.equal(fs.existsSync(nestedDir), true);
  assert.equal(slugify("  Hello, World__Again  "), "hello-world__again");
  assert.equal(normalizePath("a\\b\\c"), "a/b/c");
  assert.equal(tailText("abcdef", 4), "cdef");
  assert.match(timestampSlug(new Date(2026, 2, 28, 1, 2, 3)), /^20260328-010203$/);

  const jsonPath = path.join(rootDir, "data", "sample.json");
  writeJson(jsonPath, { ok: true, count: 2 });
  assert.deepEqual(readJson(jsonPath, null), { ok: true, count: 2 });

  fs.writeFileSync(jsonPath, "{broken", "utf8");
  assert.deepEqual(readJson(jsonPath, { fallback: true }), { fallback: true });

  const logPath = path.join(rootDir, "events.log");
  appendLine(logPath, "one");
  appendLine(logPath, "two");
  assert.equal(fs.readFileSync(logPath, "utf8"), "one\ntwo\n");
});

test("client formatting helpers render usage, percentages, resets, and HTML safely", () => {
  assert.equal(formatTokenCount(1234567), "1,234,567");
  assert.equal(formatTokenUsage({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 }), "in 10 / cache 2 / out 3");
  assert.equal(formatPercent(12.6), "13%");
  assert.equal(formatPercent("bad"), "--");
  assert.equal(formatRemainingPercent(6), "94%");
  assert.equal(formatRemainingPercent("bad"), "--");
  assert.match(formatLimitReset("2026-03-28T01:02:00.000Z"), /^Resets /);
  assert.equal(formatLimitReset(""), "No reset time");
  assert.equal(escapeHtml('<tag attr="1">&x'), "&lt;tag attr=&quot;1&quot;&gt;&amp;x");
});
