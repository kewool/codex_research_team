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

test("message-only research note to coordinator is still published when board state is unchanged", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-research-note-"));
  const previousCwd = process.cwd();
  process.chdir(rootDir);
  t.after(async () => {
    process.chdir(previousCwd);
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig(rootDir);
  const session = new LiveSession({
    config,
    goal: "research note regression",
    title: "research note regression",
    workspaceName: config.workspaces[0].name,
    workspacePath: config.workspaces[0].path,
  });

  session.initializeAgents();
  session.subgoals.push({
    id: "sg-1",
    title: "Research topic",
    topicKey: "research-topic",
    summary: "Track the research topic",
    facts: [],
    openQuestions: [],
    resolvedDecisions: [],
    acceptanceCriteria: [],
    relevantFiles: [],
    nextAction: "Clarify evidence",
    stage: "researching",
    decisionState: "disputed",
    lastReopenReason: null,
    assigneeAgentId: null,
    mergedIntoSubgoalId: null,
    archivedAt: null,
    archivedBy: null,
    updatedAt: "2026-03-28T00:00:00.000Z",
    updatedBy: "researcher_1",
    revision: 1,
    conflictCount: 0,
    activeConflict: false,
    lastConflictAt: null,
    lastConflictSummary: null,
  });
  session.subgoalRevision = 1;

  applyTurnResult(session, "researcher_1", {
    shouldReply: true,
    workingNotes: [],
    teamMessages: [{
      content: "Keep sg-1 disputed until the coordinator resolves the contract gap.",
      targetAgentId: "coordinator_1",
      targetAgentIds: ["coordinator_1"],
      subgoalIds: ["sg-1"],
    }],
    subgoalUpdates: [],
    completion: "continue",
    rawText: "",
    runtimeDiagnostics: {
      sawFileChange: false,
      sawPolicyWriteBlock: false,
      sawBroadDataLoad: false,
      sawBroadOutputDump: false,
    },
  }, 3, null);

  const researchEvent = session.recentEvents.find((event) => event.channel === "research" && event.sender === "researcher_1");
  assert.ok(researchEvent, "research note should be published");
  assert.deepEqual(researchEvent.metadata?.targetAgentIds, ["coordinator_1"]);
});

test("notes-only reply to a targeted operator question is still published to the feed", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-operator-reply-"));
  const previousCwd = process.cwd();
  process.chdir(rootDir);
  t.after(async () => {
    process.chdir(previousCwd);
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig(rootDir);
  const session = new LiveSession({
    config,
    goal: "operator reply regression",
    title: "operator reply regression",
    workspaceName: config.workspaces[0].name,
    workspacePath: config.workspaces[0].path,
  });

  session.initializeAgents();
  const coordinator = session.agents.get("coordinator_1");
  assert.ok(coordinator);
  coordinator.inFlightDigest = {
    latestGoal: null,
    operatorEvents: [{
      sequence: 1,
      sender: "operator",
      channel: "operator",
      content: "Answer this targeted question",
      metadata: { targetAgentId: "coordinator_1", targetAgentIds: ["coordinator_1"] },
      timestamp: "2026-03-30T00:00:00.000Z",
    }],
    directInputs: [],
    channelEvents: {},
    otherEvents: [],
    totalCount: 1,
    maxSequence: 1,
  };

  applyTurnResult(session, "coordinator_1", {
    shouldReply: true,
    workingNotes: ["Use the current build queue and keep sg-9 behind sg-6."],
    teamMessages: [],
    subgoalUpdates: [],
    completion: "continue",
    rawText: "",
    runtimeDiagnostics: {
      sawFileChange: false,
      sawPolicyWriteBlock: false,
      sawBroadDataLoad: false,
      sawBroadOutputDump: false,
    },
  }, 1, null);

  const statusEvent = [...session.recentEvents].reverse().find((event) =>
    event.sender === "coordinator_1" &&
    event.channel === "status" &&
    /keep sg-9 behind sg-6/i.test(event.content),
  );
  assert.ok(statusEvent, "notes-only operator reply should be visible in the feed");
  assert.equal(statusEvent.metadata?.operatorReplyEvent, true);
  assert.equal(statusEvent.metadata?.shouldReply, true);
});

test("reviewer upstream reopen becomes a coordinator-only message instead of directly reopening the card", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-reviewer-reopen-"));
  const previousCwd = process.cwd();
  process.chdir(rootDir);
  t.after(async () => {
    process.chdir(previousCwd);
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig(rootDir);
  const session = new LiveSession({
    config,
    goal: "reviewer reopen regression",
    title: "reviewer reopen regression",
    workspaceName: config.workspaces[0].name,
    workspacePath: config.workspaces[0].path,
  });

  session.initializeAgents();
  session.subgoals.push({
    id: "sg-1",
    title: "Audit target",
    topicKey: "audit-target",
    summary: "Review target",
    facts: [],
    openQuestions: [],
    resolvedDecisions: [],
    acceptanceCriteria: [],
    relevantFiles: [],
    nextAction: "Review changes",
    stage: "ready_for_review",
    decisionState: "resolved",
    lastReopenReason: null,
    assigneeAgentId: "reviewer_1",
    mergedIntoSubgoalId: null,
    archivedAt: null,
    archivedBy: null,
    updatedAt: "2026-03-28T00:00:00.000Z",
    updatedBy: "implementer_1",
    revision: 2,
    conflictCount: 0,
    activeConflict: false,
    lastConflictAt: null,
    lastConflictSummary: null,
  });
  session.subgoalRevision = 2;

  applyTurnResult(session, "reviewer_1", {
    shouldReply: true,
    workingNotes: [],
    teamMessages: [],
    subgoalUpdates: [{
      id: "sg-1",
      expectedRevision: 2,
      stage: "researching",
      decisionState: "disputed",
      reopenReason: "missing regression coverage for the selected-side gate",
    }],
    completion: "continue",
    rawText: "",
    runtimeDiagnostics: {
      sawFileChange: false,
      sawPolicyWriteBlock: false,
      sawBroadDataLoad: false,
      sawBroadOutputDump: false,
    },
  }, 4, null);

  assert.equal(session.subgoals[0].stage, "ready_for_review");
  assert.equal(session.subgoals[0].decisionState, "resolved");
  const reviewEvent = session.recentEvents.find((event) => event.channel === "review" && event.sender === "reviewer_1");
  assert.ok(reviewEvent, "reviewer should publish a coordinator-targeted reopen suggestion");
  assert.deepEqual(reviewEvent.metadata?.targetAgentIds, ["coordinator_1"]);
  assert.match(reviewEvent.content, /reopening sg-1|reopen sg-1|Review suggests reopening sg-1/i);
});

test("mechanical stale conflicts target only the coordinator while reopen suggestions also target the current assignee", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-conflict-routing-"));
  const previousCwd = process.cwd();
  process.chdir(rootDir);
  t.after(async () => {
    process.chdir(previousCwd);
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig(rootDir);
  const session = new LiveSession({
    config,
    goal: "conflict routing regression",
    title: "conflict routing regression",
    workspaceName: config.workspaces[0].name,
    workspacePath: config.workspaces[0].path,
  });

  session.initializeAgents();
  session.subgoals.push({
    id: "sg-1",
    title: "Build slice",
    topicKey: "build-slice",
    summary: "Active build",
    facts: [],
    openQuestions: [],
    resolvedDecisions: [],
    acceptanceCriteria: [],
    relevantFiles: [],
    nextAction: "Implement",
    stage: "building",
    decisionState: "resolved",
    lastReopenReason: null,
    assigneeAgentId: "implementer_1",
    mergedIntoSubgoalId: null,
    archivedAt: null,
    archivedBy: null,
    updatedAt: "2026-03-28T00:00:00.000Z",
    updatedBy: "coordinator_1",
    revision: 3,
    conflictCount: 0,
    activeConflict: false,
    lastConflictAt: null,
    lastConflictSummary: null,
  });
  session.subgoalRevision = 3;

  applyTurnResult(session, "researcher_1", {
    shouldReply: false,
    workingNotes: [],
    teamMessages: [],
    subgoalUpdates: [{
      id: "sg-1",
      expectedRevision: 2,
      stage: "building",
    }],
    completion: "continue",
    rawText: "",
    runtimeDiagnostics: {
      sawFileChange: false,
      sawPolicyWriteBlock: false,
      sawBroadDataLoad: false,
      sawBroadOutputDump: false,
    },
  }, 5, null);

  const firstConflict = [...session.recentEvents].reverse().find((event) => event.sender === "system");
  assert.deepEqual(firstConflict.metadata?.targetAgentIds, ["coordinator_1"]);

  applyTurnResult(session, "researcher_1", {
    shouldReply: false,
    workingNotes: [],
    teamMessages: [],
    subgoalUpdates: [{
      id: "sg-1",
      expectedRevision: 2,
      stage: "researching",
      reopenReason: "new evidence invalidates the build assumption",
    }],
    completion: "continue",
    rawText: "",
    runtimeDiagnostics: {
      sawFileChange: false,
      sawPolicyWriteBlock: false,
      sawBroadDataLoad: false,
      sawBroadOutputDump: false,
    },
  }, 6, null);

  const secondConflict = [...session.recentEvents].reverse().find((event) => event.sender === "system");
  assert.deepEqual(secondConflict.metadata?.targetAgentIds, ["coordinator_1", "implementer_1"]);
  assert.equal(secondConflict.metadata?.reopenSuggestionEvent, true);
});

test("self-originated coordinator stale conflicts still target the coordinator instead of broadcasting", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-self-conflict-routing-"));
  const previousCwd = process.cwd();
  process.chdir(rootDir);
  t.after(async () => {
    process.chdir(previousCwd);
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig(rootDir);
  const session = new LiveSession({
    config,
    goal: "self conflict routing regression",
    title: "self conflict routing regression",
    workspaceName: config.workspaces[0].name,
    workspacePath: config.workspaces[0].path,
  });

  session.initializeAgents();
  session.subgoals.push({
    id: "sg-1",
    title: "Queued routing slice",
    topicKey: "queued-routing-slice",
    summary: "A coordinator-owned queued card",
    facts: [],
    openQuestions: [],
    resolvedDecisions: [],
    acceptanceCriteria: [],
    relevantFiles: [],
    nextAction: "Route the build slice",
    stage: "ready_for_build",
    decisionState: "resolved",
    lastReopenReason: null,
    assigneeAgentId: "coordinator_1",
    mergedIntoSubgoalId: null,
    archivedAt: null,
    archivedBy: null,
    updatedAt: "2026-03-28T00:00:00.000Z",
    updatedBy: "researcher_1",
    revision: 3,
    conflictCount: 0,
    activeConflict: false,
    lastConflictAt: null,
    lastConflictSummary: null,
  });
  session.subgoalRevision = 3;

  applyTurnResult(session, "coordinator_1", {
    shouldReply: false,
    workingNotes: [],
    teamMessages: [],
    subgoalUpdates: [{
      id: "sg-1",
      expectedRevision: 2,
      stage: "researching",
      reopenReason: "administrative retry on an older board revision",
    }],
    completion: "continue",
    rawText: "",
    runtimeDiagnostics: {
      sawFileChange: false,
      sawPolicyWriteBlock: false,
      sawBroadDataLoad: false,
      sawBroadOutputDump: false,
    },
  }, 7, null);

  const conflictEvent = [...session.recentEvents].reverse().find((event) => event.sender === "system");
  assert.ok(conflictEvent, "expected a system conflict event");
  assert.deepEqual(conflictEvent.metadata?.targetAgentIds, ["coordinator_1"]);
});
