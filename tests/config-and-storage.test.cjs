const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createDefaultConfig, normalizeDefaults } = require("../dist/server/config/app-config.js");
const {
  appendAgentHistory,
  appendSessionEvent,
  createAgentFiles,
  createSessionFiles,
  loadAgentHistoryPage,
  loadSavedSessions,
  loadSessionEventPage,
  writeAgentSnapshot,
  writeSessionSnapshot,
} = require("../dist/server/persistence/storage.js");

test("default config creates workspace and normalizes defaults", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-config-"));
  const previousCwd = process.cwd();
  process.chdir(rootDir);
  t.after(async () => {
    process.chdir(previousCwd);
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig(rootDir);
  assert.equal(config.workspaces.length, 1);
  assert.equal(config.workspaces[0].name, "default");
  assert.equal(fs.existsSync(config.workspaces[0].path), true);
  assert.equal(config.defaults.sandbox, "danger-full-access");

  const normalized = normalizeDefaults({
    codexHomeMode: "project",
    codexAuthMode: "separate",
    modelOptions: ["gpt-5.4", "gpt-5.4", "gpt-5.4-mini"],
    mcpServerNames: ["alpha", "alpha", "beta"],
    extraChannels: ["research", "research", "team"],
    goalChannel: "  ",
  }, config.defaults);

  assert.deepEqual(normalized.modelOptions, ["gpt-5.4", "gpt-5.4-mini"]);
  assert.deepEqual(normalized.mcpServerNames, ["alpha", "beta"]);
  assert.deepEqual(normalized.extraChannels, ["research", "team"]);
  assert.equal(normalized.goalChannel, config.defaults.goalChannel);
});

test("storage paginates session events, agent history, and saved snapshots", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-storage-"));
  const previousCwd = process.cwd();
  process.chdir(rootDir);
  t.after(async () => {
    process.chdir(previousCwd);
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig(rootDir);
  const files = createSessionFiles(config, "Storage Pagination Goal");
  const agentFiles = createAgentFiles(files, "researcher_1");

  for (let index = 1; index <= 5; index += 1) {
    appendSessionEvent(files, {
      sequence: index,
      timestamp: `2026-03-28T00:00:0${index}.000Z`,
      sender: "tester",
      channel: "research",
      content: `event-${index}`,
    });
  }

  appendAgentHistory(agentFiles, {
    id: "n-1",
    timestamp: "2026-03-28T00:00:00.000Z",
    kind: "notes",
    text: "first",
  });
  appendAgentHistory(agentFiles, {
    id: "n-2",
    timestamp: "2026-03-28T00:00:01.000Z",
    kind: "notes",
    text: "second",
  });

  writeSessionSnapshot(files, {
    id: path.basename(files.root),
    title: "Storage Pagination Goal",
    goal: "Storage Pagination Goal",
    workspaceName: "default",
    workspacePath: config.workspaces[0].path,
    createdAt: "2026-03-28T00:00:00.000Z",
    updatedAt: "2026-03-28T00:00:09.000Z",
    status: "idle",
    isLive: false,
    eventCount: 5,
    subgoalRevision: 0,
    agentCount: 1,
    selectedAgentId: null,
    agents: [],
    recentEvents: [],
    subgoals: [],
    totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  });
  writeAgentSnapshot(agentFiles.stateJson, {
    id: "researcher_1",
    name: "researcher_1",
    brief: "brief",
    publishChannel: "research",
    model: null,
    status: "idle",
    turnCount: 0,
    lastConsumedSequence: 0,
    lastSeenSubgoalRevision: 0,
    pendingSignals: 0,
    waitingForInput: false,
    lastPrompt: "",
    lastInput: "",
    lastError: "",
    lastResponseAt: null,
    completion: "continue",
    workingNotes: [],
    teamMessages: [],
    stdoutTail: "",
    stderrTail: "",
    lastUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  });

  const page1 = loadSessionEventPage(config, path.basename(files.root), null, 2);
  assert.deepEqual(page1.items.map((item) => item.content), ["event-5", "event-4"]);
  assert.equal(page1.hasMore, true);

  const page2 = loadSessionEventPage(config, path.basename(files.root), page1.nextBefore, 2);
  assert.deepEqual(page2.items.map((item) => item.content), ["event-3", "event-2"]);

  const notesPage = loadAgentHistoryPage(config, path.basename(files.root), "researcher_1", "notes", null, 1);
  assert.deepEqual(notesPage.items.map((item) => item.text), ["second"]);
  assert.equal(notesPage.hasMore, true);

  const savedSessions = loadSavedSessions(config);
  assert.equal(savedSessions.length, 1);
  assert.equal(savedSessions[0].title, "Storage Pagination Goal");
});
