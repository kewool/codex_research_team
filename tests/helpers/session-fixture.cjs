const subgoals = require("../../dist/server/session/subgoals.js");
const signatures = require("../../dist/server/session/signatures.js");

function createAgentPreset(id, ownedStages, overrides = {}) {
  return {
    id,
    name: id,
    brief: `${id} brief`,
    publishChannel: overrides.publishChannel || "team",
    listenChannels: overrides.listenChannels || ["goal", "operator", "team"],
    maxTurns: 0,
    model: null,
    modelReasoningEffort: null,
    policy: {
      promptGuidance: [],
      ownedStages,
      allowedTargetAgentIds: [],
      forceBroadcastOnFirstTurn: false,
      ...(overrides.policy || {}),
    },
    ...overrides,
  };
}

function createRuntimeAgent(preset, extra = {}) {
  return {
    preset,
    snapshot: {
      id: preset.id,
      name: preset.name,
      brief: preset.brief,
      publishChannel: preset.publishChannel,
      model: preset.model,
      modelReasoningEffort: preset.modelReasoningEffort,
      status: "idle",
      turnCount: 0,
      lastConsumedSequence: 0,
      lastSeenSubgoalRevision: 0,
      lastSeenActionableSignature: null,
      lastSeenRoutingSignature: null,
      lastWakeReason: null,
      lastWakeAt: null,
      lastRoutedEventSummary: null,
      lastRoutedEventAt: null,
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
      ...extra.snapshot,
    },
    pendingDigest: extra.pendingDigest || {
      totalCount: 0,
      latestGoal: null,
      operatorEvents: [],
      directInputs: [],
      channelEvents: {},
      otherEvents: [],
    },
    inFlightDigest: null,
    inFlightSubgoalRefs: null,
    retryCount: 0,
    interruptReason: null,
    draining: false,
    drainTimer: null,
    ...extra,
  };
}

function attachSessionMethods(session) {
  session.defaultAssigneeForStage = (stage) => subgoals.defaultAssigneeForStage(session, stage);
  session.coordinationOwnerIds = () => subgoals.coordinationOwnerIds(session);
  session.canonicalSubgoalForId = (id) => subgoals.canonicalSubgoalForId(session, id);
  session.resolveDirectedMessageSubgoalIds = (message, fallbackSubgoalIds) =>
    subgoals.resolveDirectedMessageSubgoalIds(session, message, fallbackSubgoalIds);
  session.isDiscoveryOwner = (agentId) => subgoals.isDiscoveryOwner(session, agentId);
  session.canCanonicalizeSubgoal = (agentId) => signatures.canCanonicalizeSubgoal(session, agentId);
  session.goalBoardNeedsAttention = () => false;
  session.actionableSubgoalsForAgent = () => [];
  return session;
}

function createSessionFixture(overrides = {}) {
  const researchers = [
    createAgentPreset("researcher_1", ["open", "researching"]),
    createAgentPreset("researcher_2", ["open", "researching"]),
  ];
  const coordinator = createAgentPreset("coordinator_1", ["ready_for_build", "blocked"]);
  const implementer = createAgentPreset("implementer_1", ["building"]);
  const reviewer = createAgentPreset("reviewer_1", ["ready_for_review"]);
  const agents = overrides.config?.agents || [...researchers, coordinator, implementer, reviewer];
  const session = {
    config: {
      defaults: {
        goalChannel: "goal",
        operatorChannel: "operator",
      },
      agents,
      ...(overrides.config || {}),
    },
    agents: new Map(agents.map((preset) => [preset.id, createRuntimeAgent(preset)])),
    subgoals: [],
    subgoalRevision: 0,
    updatedAt: "2026-03-28T00:00:00.000Z",
    recentEvents: [],
    persistSessionCalls: 0,
    persistAgentCalls: [],
    emitCalls: [],
    persistSession() {
      this.persistSessionCalls += 1;
    },
    persistAgent(agentId) {
      this.persistAgentCalls.push(agentId);
    },
    emit(payload) {
      this.emitCalls.push(payload);
    },
    operatorChannel() {
      return this.config.defaults.operatorChannel;
    },
    ...overrides,
  };
  return attachSessionMethods(session);
}

module.exports = {
  createAgentPreset,
  createRuntimeAgent,
  createSessionFixture,
};
