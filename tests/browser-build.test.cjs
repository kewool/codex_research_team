const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("browser entry is emitted as ESM without CommonJS exports", () => {
  const appEntry = fs.readFileSync(path.resolve(__dirname, "..", "public", "app.js"), "utf8");
  const appIndex = fs.readFileSync(path.resolve(__dirname, "..", "public", "app", "index.js"), "utf8");

  assert.match(appEntry, /import "\.\/app\/index\.js";/);
  assert.doesNotMatch(appEntry, /\bexports\b/);
  assert.doesNotMatch(appIndex, /\bexports\b/);
  assert.match(appIndex, /from "\.\/format\.js"/);
});
