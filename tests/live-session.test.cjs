const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { LiveSession } = require("../dist/server/session/live-session.js");
const { createDefaultConfig } = require("../dist/server/config/app-config.js");
const { applyTurnResult } = require("../dist/server/session/turns.js");

test("LiveSession agent history writes notes and messages to agent history files", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-live-session-"));
  const previousCwd = process.cwd();
  process.chdir(rootDir);
  t.after(async () => {
    process.chdir(previousCwd);
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig(rootDir);
  const session = new LiveSession({
    config,
    goal: "history regression",
    title: "history regression",
    workspaceName: config.workspaces[0].name,
    workspacePath: config.workspaces[0].path,
  });

  session.initializeAgents();
  const runtimeAgent = session.agents.get("researcher_1");
  assert.ok(runtimeAgent);

  session.appendAgentHistory(runtimeAgent, "notes", "note entry", "Turn 1");
  session.appendAgentHistory(runtimeAgent, "messages", "message entry", "Turn 1");

  const notesPath = path.join(session.files.agentsDir, "researcher_1", "notes.jsonl");
  const messagesPath = path.join(session.files.agentsDir, "researcher_1", "messages.jsonl");
  assert.equal(fs.existsSync(notesPath), true);
  assert.equal(fs.existsSync(messagesPath), true);

  const notes = fs.readFileSync(notesPath, "utf8");
  const messages = fs.readFileSync(messagesPath, "utf8");
  assert.match(notes, /note entry/);
  assert.match(messages, /message entry/);
});

test("applyTurnResult writes agent history and session events without crashing", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-turn-result-"));
  const previousCwd = process.cwd();
  process.chdir(rootDir);
  t.after(async () => {
    process.chdir(previousCwd);
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig(rootDir);
  const session = new LiveSession({
    config,
    goal: "turn application regression",
    title: "turn application regression",
    workspaceName: config.workspaces[0].name,
    workspacePath: config.workspaces[0].path,
  });

  session.initializeAgents();

  applyTurnResult(session, "researcher_1", {
    shouldReply: true,
    workingNotes: ["research note"],
    teamMessages: [{
      content: "route this to coordinator",
      targetAgentId: "coordinator_1",
      targetAgentIds: ["coordinator_1"],
      subgoalIds: ["sg-1"],
    }],
    subgoalUpdates: [{
      title: "First card",
      topicKey: "first-card",
      summary: "Create the first card",
      stage: "researching",
      decisionState: "open",
    }],
    completion: "continue",
    rawText: "",
    tokenUsage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
    runtimeDiagnostics: {
      sawFileChange: false,
      sawPolicyWriteBlock: false,
      sawBroadDataLoad: false,
      sawBroadOutputDump: false,
    },
  }, 2, null);

  const notesPath = path.join(session.files.agentsDir, "researcher_1", "notes.jsonl");
  const messagesPath = path.join(session.files.agentsDir, "researcher_1", "messages.jsonl");
  const sessionJsonPath = path.join(session.files.root, "session.json");

  assert.equal(fs.existsSync(notesPath), true);
  assert.equal(fs.existsSync(messagesPath), true);
  assert.equal(fs.existsSync(sessionJsonPath), true);
  assert.match(fs.readFileSync(notesPath, "utf8"), /research note/);
  assert.match(fs.readFileSync(messagesPath, "utf8"), /route this to coordinator/);
  assert.equal(session.subgoals.length, 1);
  assert.equal(session.subgoals[0].title, "First card");
  assert.ok(session.recentEvents.some((event) => event.channel === "research"));
});
