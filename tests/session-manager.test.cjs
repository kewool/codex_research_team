const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { SessionManager, canAutoResumeSessionSnapshot } = require("../dist/server/session/session-manager.js");
const { createDefaultConfig, saveConfig } = require("../dist/server/config/app-config.js");
const { createSessionFiles, writeSessionSnapshot } = require("../dist/server/persistence/storage.js");

test("canAutoResumeSessionSnapshot only allows saved idle sessions whose agents are all idle", () => {
  assert.equal(canAutoResumeSessionSnapshot(null), false);
  assert.equal(canAutoResumeSessionSnapshot({ status: "stopped", agents: [{ status: "idle" }] }), false);
  assert.equal(canAutoResumeSessionSnapshot({ status: "idle", agents: [] }), false);
  assert.equal(canAutoResumeSessionSnapshot({ status: "idle", agents: [{ status: "idle" }, { status: "running" }] }), false);
  assert.equal(canAutoResumeSessionSnapshot({ status: "idle", agents: [{ status: "idle" }, { status: "idle" }] }), true);
});

test("SessionManager auto-resumes saved idle sessions without auto-resuming stopped sessions", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-session-manager-"));
  const previousCwd = process.cwd();
  process.chdir(rootDir);
  t.after(async () => {
    process.chdir(previousCwd);
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  const configPath = path.join(rootDir, "codex_research_team.config.json");
  const config = createDefaultConfig(rootDir);
  saveConfig(config, configPath);

  const idleFiles = createSessionFiles(config, "Idle session");
  const idleSessionId = path.basename(idleFiles.root);
  writeSessionSnapshot(idleFiles, {
    id: idleSessionId,
    title: "Idle session",
    goal: "Idle session",
    workspaceName: config.workspaces[0].name,
    workspacePath: config.workspaces[0].path,
    createdAt: "2026-03-30T00:00:00.000Z",
    updatedAt: "2026-03-30T00:00:01.000Z",
    status: "idle",
    isLive: false,
    eventCount: 0,
    subgoalRevision: 0,
    agentCount: 2,
    selectedAgentId: null,
    agents: [
      { id: "researcher_1", status: "idle" },
      { id: "coordinator_1", status: "idle" },
    ],
    recentEvents: [],
    subgoals: [],
    totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  });

  const stoppedFiles = createSessionFiles(config, "Stopped session");
  const stoppedSessionId = path.basename(stoppedFiles.root);
  writeSessionSnapshot(stoppedFiles, {
    id: stoppedSessionId,
    title: "Stopped session",
    goal: "Stopped session",
    workspaceName: config.workspaces[0].name,
    workspacePath: config.workspaces[0].path,
    createdAt: "2026-03-30T00:00:00.000Z",
    updatedAt: "2026-03-30T00:00:02.000Z",
    status: "stopped",
    isLive: false,
    eventCount: 0,
    subgoalRevision: 0,
    agentCount: 1,
    selectedAgentId: null,
    agents: [
      { id: "researcher_1", status: "idle" },
    ],
    recentEvents: [],
    subgoals: [],
    totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  });

  const manager = new SessionManager(configPath);
  let resumedId = null;
  manager.resumeSession = async (id) => {
    resumedId = id;
    return { id, snapshot: () => ({ id, isLive: true }) };
  };

  const idleSession = await manager.getOrAutoResumeIdleSession(idleSessionId);
  assert.ok(idleSession);
  assert.equal(resumedId, idleSessionId);

  resumedId = null;
  const stoppedSession = await manager.getOrAutoResumeIdleSession(stoppedSessionId);
  assert.equal(stoppedSession, null);
  assert.equal(resumedId, null);
});

test("SessionManager restores boot-preserved sessions as active without explicit resume", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-session-manager-boot-"));
  const previousCwd = process.cwd();
  process.chdir(rootDir);
  t.after(async () => {
    process.chdir(previousCwd);
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  const configPath = path.join(rootDir, "codex_research_team.config.json");
  const config = createDefaultConfig(rootDir);
  saveConfig(config, configPath);

  const preservedFiles = createSessionFiles(config, "Preserved session");
  const preservedSessionId = path.basename(preservedFiles.root);
  writeSessionSnapshot(preservedFiles, {
    id: preservedSessionId,
    title: "Preserved session",
    goal: "Preserved session",
    workspaceName: config.workspaces[0].name,
    workspacePath: config.workspaces[0].path,
    createdAt: "2026-03-30T00:00:00.000Z",
    updatedAt: "2026-03-30T00:00:01.000Z",
    status: "running",
    isLive: false,
    resumeOnBoot: true,
    eventCount: 0,
    subgoalRevision: 0,
    agentCount: 2,
    selectedAgentId: null,
    agents: [
      { id: "researcher_1", status: "idle" },
      { id: "coordinator_1", status: "stopped" },
    ],
    recentEvents: [],
    subgoals: [],
    totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  });

  const manager = new SessionManager(configPath);
  const restored = manager.getSession(preservedSessionId);
  assert.ok(restored);
  assert.equal(restored.snapshot().isLive, true);
  assert.equal(restored.snapshot().status, "running");
  const coordinator = restored.snapshot().agents.find((agent) => agent.id === "coordinator_1");
  assert.equal(coordinator.status, "stopped");
});
