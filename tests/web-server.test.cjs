const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { startWebServer } = require("../dist/server/http/web-server.js");
const { createDefaultConfig, saveConfig } = require("../dist/server/config/app-config.js");

test("web server close hibernates live sessions instead of stopping them", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-web-server-"));
  const previousCwd = process.cwd();
  process.chdir(rootDir);
  t.after(async () => {
    process.chdir(previousCwd);
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  const configPath = path.join(rootDir, "codex_research_team.config.json");
  saveConfig(createDefaultConfig(rootDir), configPath);

  const server = await startWebServer({ configPath, host: "127.0.0.1", port: 0 });
  const calls = [];
  server.manager.snapshot = () => ({ sessions: [{ id: "session-1" }] });
  server.manager.getSession = (id) => (id === "session-1" ? { id } : null);
  server.manager.hibernateSession = async (id) => {
    calls.push(`hibernate:${id}`);
  };
  server.manager.stopSession = async (id) => {
    calls.push(`stop:${id}`);
    throw new Error("stopSession should not be called during server shutdown");
  };

  await server.close();
  assert.deepEqual(calls, ["hibernate:session-1"]);
});
