const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { CodexAgentProcess } = require("../dist/server/runtime/agent-process.js");
const { createAgentFiles } = require("../dist/server/persistence/storage.js");

function createConfig(rootDir) {
  return {
    defaults: {
      language: "en",
      defaultWorkspaceName: "default",
      historyTail: 50,
      serverHost: "127.0.0.1",
      serverPort: 4280,
      runsDir: path.join(rootDir, "runs"),
      workspacesDir: path.join(rootDir, "workspaces"),
      codexCommand: "codex",
      codexHomeMode: "project",
      codexAuthMode: "separate",
      codexHomeDir: path.join(rootDir, ".codex_research_team", "home"),
      model: "gpt-5.4",
      modelReasoningEffort: null,
      modelOptions: ["gpt-5.4"],
      mcpServerNames: [],
      goalChannel: "goal",
      operatorChannel: "operator",
      extraChannels: [],
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      autoOpenBrowser: false,
      search: false,
      dangerousBypass: false,
    },
    workspaces: [],
    agents: [],
  };
}

function createAgent(rootDir) {
  return {
    id: "researcher_1",
    name: "researcher_1",
    brief: "test agent",
    publishChannel: "research",
    listenChannels: ["goal", "research", "operator"],
    maxTurns: 0,
    model: "gpt-5.4",
    policy: {
      promptGuidance: [],
      ownedStages: ["researching"],
      allowedTargetAgentIds: [],
      forceBroadcastOnFirstTurn: false,
    },
  };
}

function createProcessHarness(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-research-team-"));
  t.after(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });
  const config = createConfig(rootDir);
  const workspacePath = path.join(rootDir, "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(config.defaults.runsDir, { recursive: true });
  fs.mkdirSync(config.defaults.codexHomeDir, { recursive: true });
  const agent = createAgent(rootDir);
  const sessionFiles = {
    root: path.join(config.defaults.runsDir, "session"),
    sessionJson: path.join(config.defaults.runsDir, "session", "session.json"),
    eventsJsonl: path.join(config.defaults.runsDir, "session", "events.jsonl"),
    eventsLog: path.join(config.defaults.runsDir, "session", "events.log"),
    agentsDir: path.join(config.defaults.runsDir, "session", "agents"),
  };
  fs.mkdirSync(sessionFiles.agentsDir, { recursive: true });
  const files = createAgentFiles(sessionFiles, agent.id);
  const hooks = {
    onState() {},
    onStdout() {},
    onStderr() {},
  };
  return {
    rootDir,
    process: new CodexAgentProcess({
      config,
      agent,
      workspacePath,
      language: "en",
      files,
      hooks,
    }),
  };
}

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("runTurn resolves when turn.completed arrives even if the codex child hangs afterward", async (t) => {
  const { rootDir, process: agentProcess } = createProcessHarness(t);
  await agentProcess.start("test goal");
  const helperPath = path.resolve(__dirname, "fixtures", "mock-codex-hang-after-turn.cjs");
  agentProcess.buildCommandSpec = () => ({
    file: process.execPath,
    args: [helperPath],
    windowsVerbatimArguments: false,
    shell: false,
  });

  const start = Date.now();
  const result = await Promise.race([
    agentProcess.runTurn("test goal", "transcript", "trigger"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("runTurn timed out")), 2000)),
  ]);

  assert.equal(result.shouldReply, true);
  assert.equal(result.completion, "continue");
  assert.equal(result.teamMessages.length, 1);
  assert.ok(Date.now() - start < 2000, "turn should resolve before the helper process exits");
});

test("stop kills the spawned process tree", async (t) => {
  const { rootDir, process: agentProcess } = createProcessHarness(t);
  await agentProcess.start("test goal");
  const helperPath = path.resolve(__dirname, "fixtures", "mock-codex-hang-tree.cjs");
  const childPidFile = path.join(rootDir, "child-pid.txt");
  const parentPidFile = path.join(rootDir, "parent-pid.txt");
  agentProcess.buildCommandSpec = () => ({
    file: process.execPath,
    args: [helperPath, childPidFile, parentPidFile],
    windowsVerbatimArguments: false,
    shell: false,
  });

  const pending = agentProcess.executePrompt("prompt", "__TEST_TOKEN__").catch((error) => error);
  await waitFor(() => fs.existsSync(childPidFile) && fs.existsSync(parentPidFile), 2000, "mock child pid files");

  const childPid = Number(fs.readFileSync(childPidFile, "utf8").trim());
  const parentPid = Number(fs.readFileSync(parentPidFile, "utf8").trim());
  assert.ok(isPidAlive(parentPid), "parent helper should be alive before stop");
  assert.ok(isPidAlive(childPid), "child helper should be alive before stop");

  await agentProcess.stop();
  const result = await pending;
  assert.match(String(result?.message ?? result), /Codex run stopped/);

  await waitFor(() => !isPidAlive(parentPid) && !isPidAlive(childPid), 4000, "process tree exit");
});
