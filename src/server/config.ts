// @ts-nocheck
import { dirname, resolve } from "node:path";
import { AgentPolicy, AgentPreset, AppConfig, AppDefaults, SessionChannel } from "../shared/types";
import { ensureDir, projectPath, readJson, writeJson } from "./utils";

export const DEFAULT_CONFIG_PATH = projectPath("codex_team.config.json");
export const INTERNAL_CHANNELS: SessionChannel[] = ["status", "system", "control"];

function normalizeChannelName(value: unknown, fallback: string): string {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeChannelList(values: unknown[]): SessionChannel[] {
  const deduped = new Set<string>();
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) {
      deduped.add(text);
    }
  }
  return [...deduped];
}

function normalizeGuidanceList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map((value) => String(value ?? "").trim()).filter(Boolean);
}

export function normalizeDefaults(defaults: Partial<AppDefaults> | undefined, fallback: AppDefaults): AppDefaults {
  const nextExtraChannels = Array.isArray(defaults?.extraChannels) ? defaults.extraChannels : fallback.extraChannels;
  const nextModelOptions = Array.isArray(defaults?.modelOptions) ? defaults.modelOptions : fallback.modelOptions;
  return {
    ...fallback,
    ...(defaults ?? {}),
    codexHomeMode: defaults?.codexHomeMode === "global" ? "global" : (defaults?.codexHomeMode === "project" ? "project" : fallback.codexHomeMode),
    codexHomeDir: normalizeChannelName(defaults?.codexHomeDir, fallback.codexHomeDir),
    modelOptions: normalizeChannelList(nextModelOptions),
    goalChannel: normalizeChannelName(defaults?.goalChannel, fallback.goalChannel),
    operatorChannel: normalizeChannelName(defaults?.operatorChannel, fallback.operatorChannel),
    modelReasoningEffort: normalizeChannelName(defaults?.modelReasoningEffort, "") || null,
    mcpServerNames: normalizeChannelList(Array.isArray(defaults?.mcpServerNames) ? defaults.mcpServerNames : fallback.mcpServerNames),
    extraChannels: normalizeChannelList(nextExtraChannels.length > 0 ? nextExtraChannels : fallback.extraChannels),
  };
}

export function teamChannels(defaults: AppDefaults): SessionChannel[] {
  const configured = normalizeChannelList(defaults.extraChannels || []);
  if (configured.length > 0) {
    return configured;
  }
  return ["team"];
}

export function allConfiguredChannels(defaults: AppDefaults): SessionChannel[] {
  return normalizeChannelList([defaults.goalChannel, defaults.operatorChannel, ...teamChannels(defaults), ...INTERNAL_CHANNELS]);
}

export function defaultPublishChannel(defaults: AppDefaults): SessionChannel {
  return teamChannels(defaults)[0] || defaults.goalChannel;
}

export function defaultListenChannels(defaults: AppDefaults): SessionChannel[] {
  return normalizeChannelList([defaults.goalChannel, defaults.operatorChannel]);
}

function defaultWorkspacePreset(root: string, workspacesDir: string): { name: string; path: string } {
  const resolvedRoot = resolve(root);
  const resolvedWorkspacesDir = resolve(workspacesDir || resolve(resolvedRoot, "workspaces"));
  const defaultPath = resolve(resolvedWorkspacesDir, "default");
  ensureDir(resolvedWorkspacesDir);
  ensureDir(defaultPath);
  return {
    name: "default",
    path: defaultPath,
  };
}

function ensureWorkspaceDefaults(config: AppConfig, root = process.cwd()): AppConfig {
  const resolvedWorkspacesDir = resolve(config.defaults.workspacesDir);
  ensureDir(resolvedWorkspacesDir);
  const normalizedWorkspaces = Array.isArray(config.workspaces)
    ? config.workspaces
        .map((workspace) => ({
          name: String(workspace?.name ?? "").trim(),
          path: resolve(String(workspace?.path ?? "").trim()),
        }))
        .filter((workspace) => workspace.name && workspace.path)
    : [];

  if (normalizedWorkspaces.length === 0) {
    normalizedWorkspaces.push(defaultWorkspacePreset(root, resolvedWorkspacesDir));
  } else {
    for (const workspace of normalizedWorkspaces) {
      ensureDir(workspace.path);
    }
  }

  const defaultWorkspaceName = String(config.defaults.defaultWorkspaceName ?? "").trim();
  config.workspaces = normalizedWorkspaces;
  config.defaults.defaultWorkspaceName = normalizedWorkspaces.some((workspace) => workspace.name === defaultWorkspaceName)
    ? defaultWorkspaceName
    : normalizedWorkspaces[0]?.name ?? "default";
  return config;
}

export function emptyAgentPolicy(): AgentPolicy {
  return {
    promptGuidance: [],
    activationChannels: [],
    activationMinEvents: 0,
    activationMinUniqueSenders: 0,
    peerContextChannels: [],
    doneReopenChannels: [],
    allowedTargetAgentIds: [],
    deferTargetAgentIdsUntilPeerContext: [],
    observeTargetedChannels: [],
    targetedOnlyChannels: [],
    muteFollowupChannels: [],
    muteOnChannelActivity: [],
    forceBroadcastOnFirstTurn: false,
  };
}

export function normalizeAgentPolicy(policy: Partial<AgentPolicy> | undefined): AgentPolicy {
  const base = emptyAgentPolicy();
  return {
    ...base,
    ...(policy ?? {}),
    promptGuidance: normalizeGuidanceList(policy?.promptGuidance),
    activationChannels: normalizeChannelList(Array.isArray(policy?.activationChannels) ? policy.activationChannels : []),
    activationMinEvents: Math.max(0, Number(policy?.activationMinEvents ?? 0) || 0),
    activationMinUniqueSenders: Math.max(0, Number(policy?.activationMinUniqueSenders ?? 0) || 0),
    peerContextChannels: normalizeChannelList(Array.isArray(policy?.peerContextChannels) ? policy.peerContextChannels : []),
    doneReopenChannels: normalizeChannelList(Array.isArray(policy?.doneReopenChannels) ? policy.doneReopenChannels : []),
    allowedTargetAgentIds: normalizeChannelList(Array.isArray(policy?.allowedTargetAgentIds) ? policy.allowedTargetAgentIds : []),
    deferTargetAgentIdsUntilPeerContext: normalizeChannelList(Array.isArray(policy?.deferTargetAgentIdsUntilPeerContext) ? policy.deferTargetAgentIdsUntilPeerContext : []),
    observeTargetedChannels: normalizeChannelList(Array.isArray(policy?.observeTargetedChannels) ? policy.observeTargetedChannels : []),
    targetedOnlyChannels: normalizeChannelList(Array.isArray(policy?.targetedOnlyChannels) ? policy.targetedOnlyChannels : []),
    muteFollowupChannels: normalizeChannelList(Array.isArray(policy?.muteFollowupChannels) ? policy.muteFollowupChannels : []),
    muteOnChannelActivity: normalizeChannelList(Array.isArray(policy?.muteOnChannelActivity) ? policy.muteOnChannelActivity : []),
    forceBroadcastOnFirstTurn: Boolean(policy?.forceBroadcastOnFirstTurn),
  };
}

function defaultAgents(defaults: AppDefaults): AgentPreset[] {
  const goal = defaults.goalChannel;
  const operator = defaults.operatorChannel;
  const channels = teamChannels(defaults);
  const exploreChannel = channels[0] || "research";
  const coordinationChannel = channels[1] || channels[0] || "coordination";
  const buildChannel = channels[2] || channels[1] || channels[0] || "implementation";
  const auditChannel = channels[3] || channels[2] || channels[1] || channels[0] || "review";

  return [
    {
      id: "researcher_1",
      name: "researcher_1",
      brief: "Explore independently. Prioritize architecture options, assumptions, and concrete plans.",
      publishChannel: exploreChannel,
      listenChannels: normalizeChannelList([goal, operator, exploreChannel, coordinationChannel]),
      maxTurns: 0,
      model: null,
      policy: {
        ...emptyAgentPolicy(),
        promptGuidance: [
          "Explore independently and prioritize architecture options, constraints, assumptions, and concrete plans.",
          "Stay at the research and planning layer by default. Do not spend turns on line-by-line code review, file-by-file bug hunting, or detailed test edits unless the operator explicitly asks for that depth.",
          "Treat the codebase as evidence, not as the main subject. Use it to confirm architecture, workflow, and product constraints, then return to the higher-level decision.",
          "Do not turn your turn into a contract-audit or bug-audit report. If you discover a code-level defect, compress it into one short risk statement and hand it off instead of walking through files and functions.",
          "Avoid long file-path, symbol, or implementation-detail enumerations. Focus on what the team should conclude, change in plan, or validate next.",
          "Prefer broadcast updates unless a specific agent clearly needs to act next.",
          "If another researcher should investigate a specific question next, target that researcher directly.",
          "Discuss with the other researchers before escalating to coordinator_1. Do not hand work to coordinator_1 until you have seen peer research for this goal, unless the operator explicitly tells you to do so.",
          "If implementation or review work should happen next after that discussion, hand it to coordinator_1 instead of targeting implementer_1 or reviewer_1 directly.",
          "If you are replying mainly to one prior agent's message, target that reply back to the owner instead of broadcasting by habit.",
          "If no one needs to act differently after your check, prefer shouldReply=false.",
        ],
        peerContextChannels: [exploreChannel],
        doneReopenChannels: [exploreChannel, coordinationChannel],
        allowedTargetAgentIds: ["researcher_2", "researcher_3", "coordinator_1"],
        deferTargetAgentIdsUntilPeerContext: ["coordinator_1"],
        observeTargetedChannels: [],
        targetedOnlyChannels: [],
        muteFollowupChannels: [],
        muteOnChannelActivity: [],
        forceBroadcastOnFirstTurn: true,
      },
    },
    {
      id: "researcher_2",
      name: "researcher_2",
      brief: "Explore independently. Prioritize risks, tradeoffs, failure modes, and validation strategy.",
      publishChannel: exploreChannel,
      listenChannels: normalizeChannelList([goal, operator, exploreChannel, coordinationChannel]),
      maxTurns: 0,
      model: null,
      policy: {
        ...emptyAgentPolicy(),
        promptGuidance: [
          "Explore independently and prioritize risks, tradeoffs, failure modes, and validation strategy.",
          "Focus on requirements, evaluation criteria, data assumptions, and likely breakpoints rather than detailed code-review findings.",
          "Treat code inspection as a way to confirm risk, not as the deliverable. If you notice a code-level defect, reduce it to one concise failure mode and hand it off instead of producing a deep audit.",
          "Avoid long file-path, symbol, and function-level walkthroughs unless the operator explicitly asks for review depth.",
          "Prioritize acceptance criteria, user-facing risk, reproducibility risk, and where the current direction is likely to fail.",
          "Prefer broadcast updates unless a specific agent clearly needs to act next.",
          "If another researcher should investigate a specific question next, target that researcher directly.",
          "Discuss with the other researchers before escalating to coordinator_1. Do not hand work to coordinator_1 until you have seen peer research for this goal, unless the operator explicitly tells you to do so.",
          "If implementation or review work should happen next after that discussion, hand it to coordinator_1 instead of targeting implementer_1 or reviewer_1 directly.",
          "If you are replying mainly to one prior agent's message, target that reply back to the owner instead of broadcasting by habit.",
          "If no one needs to act differently after your check, prefer shouldReply=false.",
        ],
        peerContextChannels: [exploreChannel],
        doneReopenChannels: [exploreChannel, coordinationChannel],
        allowedTargetAgentIds: ["researcher_1", "researcher_3", "coordinator_1"],
        deferTargetAgentIdsUntilPeerContext: ["coordinator_1"],
        observeTargetedChannels: [],
        targetedOnlyChannels: [],
        muteFollowupChannels: [],
        muteOnChannelActivity: [],
        forceBroadcastOnFirstTurn: true,
      },
    },
    {
      id: "researcher_3",
      name: "researcher_3",
      brief: "Explore independently. Prioritize workflow design, handoff quality, evaluation plan, and operator experience.",
      publishChannel: exploreChannel,
      listenChannels: normalizeChannelList([goal, operator, exploreChannel, coordinationChannel]),
      maxTurns: 0,
      model: null,
      policy: {
        ...emptyAgentPolicy(),
        promptGuidance: [
          "Explore independently and prioritize workflow design, handoff quality, evaluation plan, and operator impact.",
          "Avoid dropping into patch-level implementation review by default. Prefer system behavior, pipeline shape, tooling flow, and what the implementer or reviewer should validate next.",
          "Do not spend turns cataloging code/schema/path defects in detail. Convert them into workflow or operator-facing contract risks and move back up a level.",
          "Treat the repository as one input to the workflow analysis, not as the thing you are reviewing line by line.",
          "When a low-level issue matters, summarize the impact on handoff quality or operator flow instead of reciting implementation details.",
          "Prefer broadcast updates unless a specific agent clearly needs to act next.",
          "If another researcher should investigate a specific question next, target that researcher directly.",
          "Discuss with the other researchers before escalating to coordinator_1. Do not hand work to coordinator_1 until you have seen peer research for this goal, unless the operator explicitly tells you to do so.",
          "If implementation or review work should happen next after that discussion, hand it to coordinator_1 instead of targeting implementer_1 or reviewer_1 directly.",
          "If you are replying mainly to one prior agent's message, target that reply back to the owner instead of broadcasting by habit.",
          "If no one needs to act differently after your check, prefer shouldReply=false.",
        ],
        peerContextChannels: [exploreChannel],
        doneReopenChannels: [exploreChannel, coordinationChannel],
        allowedTargetAgentIds: ["researcher_1", "researcher_2", "coordinator_1"],
        deferTargetAgentIdsUntilPeerContext: ["coordinator_1"],
        observeTargetedChannels: [],
        targetedOnlyChannels: [],
        muteFollowupChannels: [],
        muteOnChannelActivity: [],
        forceBroadcastOnFirstTurn: true,
      },
    },
    {
      id: "coordinator_1",
      name: "coordinator_1",
      brief: "Synthesize the researchers' findings into a concrete next action. Resolve conflicts, decide when the team is ready to build, and route work to the correct agent.",
      publishChannel: coordinationChannel,
      listenChannels: normalizeChannelList([operator, exploreChannel, buildChannel, auditChannel, coordinationChannel]),
      maxTurns: 0,
      model: null,
      policy: {
        ...emptyAgentPolicy(),
        promptGuidance: [
          "Act as the synthesis and routing layer for the team.",
          "Absorb researcher findings, collapse overlap, surface contradictions, and decide what should happen next.",
          "Do not jump on every raw research update. Wait for an explicit handoff or a clear coordination request instead of interrupting researcher-to-researcher discussion.",
          "Send concrete implementation handoffs to implementer_1 and concrete audit requests to reviewer_1.",
          "If evidence is still incomplete or conflicting, target the exact researcher who should investigate further instead of pushing premature work downstream.",
          "Prefer shouldReply=false when there is no routing change, no conflict to resolve, and no new action owner to assign.",
        ],
        doneReopenChannels: [exploreChannel, buildChannel, auditChannel, coordinationChannel],
        allowedTargetAgentIds: ["researcher_1", "researcher_2", "researcher_3", "implementer_1", "reviewer_1"],
        targetedOnlyChannels: [exploreChannel],
      },
    },
    {
      id: "implementer_1",
      name: "implementer_1",
      brief: "Turn the team's explored findings into concrete changes. Prioritize working code, clear diffs, and unblockers.",
      publishChannel: buildChannel,
      listenChannels: normalizeChannelList([operator, coordinationChannel, auditChannel]),
      maxTurns: 0,
      model: null,
      policy: {
        ...emptyAgentPolicy(),
        promptGuidance: [
          "Convert coordinator handoffs and reviewer findings into concrete changes in the workspace.",
          "If the plan is unclear or conflicting, target coordinator_1 instead of pulling every researcher directly into implementation details.",
          "When a validation-only response is needed, target reviewer_1 instead of broadcasting broadly.",
        ],
        doneReopenChannels: [auditChannel, coordinationChannel],
        allowedTargetAgentIds: ["reviewer_1", "coordinator_1"],
      },
    },
    {
      id: "reviewer_1",
      name: "reviewer_1",
      brief: "Audit plans and changes. Prioritize bugs, regressions, missing tests, and weak assumptions.",
      publishChannel: auditChannel,
      listenChannels: normalizeChannelList([operator, buildChannel, coordinationChannel]),
      maxTurns: 0,
      model: null,
      policy: {
        ...emptyAgentPolicy(),
        promptGuidance: [
          "Audit changes for bugs, regressions, missing tests, and weak assumptions.",
          "Send concrete findings back to implementer_1. If you need broader reframing, state it in the message but still target implementer_1.",
        ],
        doneReopenChannels: [buildChannel, coordinationChannel],
        allowedTargetAgentIds: ["implementer_1"],
      },
    },
  ];
}

export function createDefaultConfig(root = process.cwd()): AppConfig {
  const runsDir = resolve(root, "runs");
  const workspacesDir = resolve(root, "workspaces");
  const codexHomeDir = resolve(root, ".codex_team", "home");
  ensureDir(runsDir);
  ensureDir(workspacesDir);
  ensureDir(codexHomeDir);

  const defaults: AppDefaults = {
    language: "ko",
    defaultWorkspaceName: "default",
    historyTail: 14,
    serverHost: "127.0.0.1",
    serverPort: 4280,
    runsDir,
    workspacesDir,
    codexCommand: "C:/Program Files/nodejs/codex.cmd",
    codexHomeMode: "project",
    codexHomeDir,
    model: null,
    modelReasoningEffort: "xhigh",
    modelOptions: [],
    mcpServerNames: [],
    goalChannel: "goal",
    operatorChannel: "operator",
    extraChannels: ["research", "coordination", "implementation", "review"],
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    autoOpenBrowser: false,
    search: true,
    dangerousBypass: true,
  };

  return ensureWorkspaceDefaults({
    defaults,
    workspaces: [defaultWorkspacePreset(root, workspacesDir)],
    agents: defaultAgents(defaults),
  }, root);
}

export function loadConfig(configPath = DEFAULT_CONFIG_PATH): AppConfig {
  const fallback = createDefaultConfig(process.cwd());
  const loaded = readJson<AppConfig>(configPath, fallback);
  const defaults = normalizeDefaults(loaded.defaults, fallback.defaults);
  const merged = ensureWorkspaceDefaults({
    defaults,
    workspaces: Array.isArray(loaded.workspaces) ? loaded.workspaces : fallback.workspaces,
    agents: Array.isArray(loaded.agents) && loaded.agents.length > 0
      ? loaded.agents.map((agent, index) => {
          const publishChannel = normalizeChannelName(agent.publishChannel, defaultPublishChannel(defaults));
          const rawChannels = Array.isArray(agent.listenChannels) ? agent.listenChannels : [];
          const listenChannels = normalizeChannelList(rawChannels);
          return {
            id: String(agent.id ?? `agent_${index + 1}`).trim() || `agent_${index + 1}`,
            name: String(agent.name ?? `agent_${index + 1}`).trim() || `agent_${index + 1}`,
            brief: String(agent.brief ?? "Explore independently and share novel findings.").trim() || "Explore independently and share novel findings.",
            publishChannel,
            listenChannels: listenChannels.length > 0 ? listenChannels : defaultListenChannels(defaults),
            maxTurns: Number(agent.maxTurns ?? 0) || 0,
            model: String(agent.model ?? "").trim() || null,
            policy: normalizeAgentPolicy(agent.policy),
          };
        })
      : defaultAgents(defaults),
  }, process.cwd());
  if (merged.defaults.codexHomeMode === "project") {
    merged.defaults.codexHomeDir = resolve(merged.defaults.codexHomeDir);
  }
  ensureDir(merged.defaults.runsDir);
  ensureDir(merged.defaults.workspacesDir);
  if (merged.defaults.codexHomeMode === "project") {
    ensureDir(merged.defaults.codexHomeDir);
  }
  return merged;
}

export function saveConfig(config: AppConfig, configPath = DEFAULT_CONFIG_PATH): void {
  ensureDir(dirname(resolve(configPath)));
  writeJson(configPath, config);
}
