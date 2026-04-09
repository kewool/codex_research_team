// @ts-nocheck
import { dirname, resolve } from "node:path";
import { AgentPolicy, AgentPreset, AppConfig, AppDefaults, SessionChannel, SUBGOAL_STAGES, SubgoalStage } from "../../shared/types";
import { ensureDir, projectPath, readJson, writeJson } from "../lib/utils";

export const DEFAULT_CONFIG_PATH = projectPath("codex_research_team.config.json");
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

function normalizeStageList(values: unknown): SubgoalStage[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const allowed = new Set<string>(SUBGOAL_STAGES);
  const deduped = new Set<SubgoalStage>();
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (allowed.has(text)) {
      deduped.add(text as SubgoalStage);
    }
  }
  return [...deduped];
}

export function normalizeDefaults(defaults: Partial<AppDefaults> | undefined, fallback: AppDefaults): AppDefaults {
  const nextExtraChannels = Array.isArray(defaults?.extraChannels) ? defaults.extraChannels : fallback.extraChannels;
  const nextModelOptions = Array.isArray(defaults?.modelOptions) ? defaults.modelOptions : fallback.modelOptions;
  return {
    ...fallback,
    ...(defaults ?? {}),
    codexHomeMode: defaults?.codexHomeMode === "global" ? "global" : (defaults?.codexHomeMode === "project" ? "project" : fallback.codexHomeMode),
    codexAuthMode: defaults?.codexAuthMode === "separate" ? "separate" : (defaults?.codexAuthMode === "mirror-global" ? "mirror-global" : fallback.codexAuthMode),
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
    ownedStages: [],
    allowedTargetAgentIds: [],
    forceBroadcastOnFirstTurn: false,
  };
}

export function normalizeAgentPolicy(policy: Partial<AgentPolicy> | undefined): AgentPolicy {
  const base = emptyAgentPolicy();
  return {
    ...base,
    ...(policy ?? {}),
    promptGuidance: normalizeGuidanceList(policy?.promptGuidance),
    ownedStages: normalizeStageList(policy?.ownedStages),
    allowedTargetAgentIds: normalizeChannelList(Array.isArray(policy?.allowedTargetAgentIds) ? policy.allowedTargetAgentIds : []),
    forceBroadcastOnFirstTurn: Boolean(policy?.forceBroadcastOnFirstTurn),
  };
}

function agentIdsOwningAnyStage(agents: AgentPreset[], stages: SubgoalStage[]): string[] {
  const wanted = new Set<SubgoalStage>(stages);
  return agents
    .filter((agent) => Array.isArray(agent.policy?.ownedStages) && agent.policy.ownedStages.some((stage) => wanted.has(stage)))
    .map((agent) => agent.id);
}

function otherAgentIds(agentIds: string[], selfId: string): string[] {
  return agentIds.filter((agentId) => agentId !== selfId);
}

function applyDefaultTargetPolicies(agents: AgentPreset[]): AgentPreset[] {
  const researchAgentIds = agentIdsOwningAnyStage(agents, ["open", "researching"]);
  const coordinationOwnerIds = agentIdsOwningAnyStage(agents, ["ready_for_build", "blocked"]);
  const buildOwnerIds = agentIdsOwningAnyStage(agents, ["building"]);
  const reviewOwnerIds = agentIdsOwningAnyStage(agents, ["ready_for_review"]);

  for (const agent of agents) {
    const ownedStages = Array.isArray(agent.policy?.ownedStages) ? agent.policy.ownedStages : [];
    if (ownedStages.includes("open") || ownedStages.includes("researching")) {
      agent.policy.allowedTargetAgentIds = normalizeChannelList([...otherAgentIds(researchAgentIds, agent.id), ...coordinationOwnerIds]);
      continue;
    }
    if (ownedStages.includes("ready_for_build") || ownedStages.includes("blocked")) {
      agent.policy.allowedTargetAgentIds = normalizeChannelList([...researchAgentIds, ...buildOwnerIds]);
      continue;
    }
    if (ownedStages.includes("building")) {
      agent.policy.allowedTargetAgentIds = normalizeChannelList([...reviewOwnerIds, ...coordinationOwnerIds]);
      continue;
    }
    if (ownedStages.includes("ready_for_review")) {
      agent.policy.allowedTargetAgentIds = normalizeChannelList([...buildOwnerIds, ...coordinationOwnerIds]);
    }
  }

  return agents;
}

function researchPromptGuidance(focus: string): string[] {
  return [
    focus,
    "Prefer separate cards for distinct durable axes rather than forcing unrelated findings into one broad umbrella card.",
    "Do not create a second card for the same contract just because the title or topicKey wording changed; if the deliverable, owner handoff, and acceptance are the same, reuse the card or ask the coordinator to merge it.",
    "Bring objections, tradeoffs, and validation gaps into discussion early so the coordinator can see real peer challenge before routing.",
    "When a line of research becomes implementable, make the build contract explicit enough that another agent could pick it up without rereading your whole transcript.",
    "Stay at the research and planning layer. Use the codebase as evidence, not as the main deliverable.",
    "Prefer narrow reads, small samples, and existing aggregates. Avoid broad dataset loads, full-pipeline runs, and synthetic write probes unless the current subgoal truly requires them.",
    "Send raw research to peer researchers or the coordinator. Do not target implementers or reviewers directly for research handoffs.",
  ];
}

function coordinatorPromptGuidance(): string[] {
  return [
    "Create missing cards when researchers surface a distinct durable axis that is not represented on the board yet.",
    "Reassign upstream ownership when one researcher is overloaded, stalled, or no longer the best person to carry the current line of work.",
    "Preserve separate cards for distinct axes and merge only true duplicates or clear overlaps.",
    "If two cards now describe the same durable contract or downstream handoff, merge them explicitly with mergedIntoSubgoalId instead of keeping both alive under slightly different titles or topic keys.",
    "If you intentionally keep similar cards separate, rewrite their summaries and next actions so the boundary is explicit.",
    "Treat fresh research conclusions as provisional until the discussion shows objections, tradeoffs, or validation gaps were addressed. Do not route downstream on confidence alone.",
    "Route build work only after the card's build contract is explicit enough for the implementer to start from the card itself.",
    "If implementation or review changes the contract, move the affected card back upstream and target the exact researcher who should reopen it.",
    "If routing and board state are unchanged, prefer shouldReply=false.",
  ];
}

function implementerPromptGuidance(): string[] {
  return [
    "Only act on cards you currently own in building.",
    "Start from relevantFiles and directly related implementation and test files. Expand scope only when necessary to complete the assigned slice.",
    "If the assigned slice exposes a broken upstream contract or assumption, return it upstream with a precise reopen reason instead of coding through the contradiction.",
    "Send review-ready work directly to the review owner. Use the coordinator only when routing or scope must change.",
    "Keep work inside the selected workspace, avoid synthetic write probes, and refactor oversized mixed-responsibility files as part of the implementation.",
  ];
}

function reviewerPromptGuidance(): string[] {
  return [
    "Only act on cards you currently own in ready_for_review.",
    "Audit relevantFiles, changed files, and directly related tests first. Widen scope only when local evidence is insufficient.",
    "If the build passes, move it to done. If fixes are required, return it to the current build owner.",
    "If the contract itself is wrong, send a coordinator-only reopen suggestion naming the card and reopen reason. Do not reopen it yourself.",
    "Use narrow tests and focused probes; avoid broad reruns unless local evidence is insufficient.",
  ];
}

function defaultAgents(defaults: AppDefaults): AgentPreset[] {
  const goal = defaults.goalChannel;
  const operator = defaults.operatorChannel;
  const channels = teamChannels(defaults);
  const exploreChannel = channels[0] || "research";
  const coordinationChannel = channels[1] || channels[0] || "coordination";
  const buildChannel = channels[2] || channels[1] || channels[0] || "implementation";
  const auditChannel = channels[3] || channels[2] || channels[1] || channels[0] || "review";

  const agents: AgentPreset[] = [
    {
      id: "researcher_1",
      name: "researcher_1",
      brief: "Explore independently. Prioritize architecture options, assumptions, and concrete plans.",
      publishChannel: exploreChannel,
      listenChannels: normalizeChannelList([goal, operator, exploreChannel, coordinationChannel]),
      maxTurns: 0,
      model: null,
      modelReasoningEffort: "medium",
      policy: {
        ...emptyAgentPolicy(),
        promptGuidance: researchPromptGuidance(
          "Explore independently and prioritize architecture options, constraints, assumptions, and concrete plans.",
        ),
        ownedStages: ["open", "researching"],
        allowedTargetAgentIds: [],
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
      modelReasoningEffort: "medium",
      policy: {
        ...emptyAgentPolicy(),
        promptGuidance: researchPromptGuidance(
          "Explore independently and prioritize risks, tradeoffs, failure modes, and validation strategy.",
        ),
        ownedStages: ["open", "researching"],
        allowedTargetAgentIds: [],
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
      modelReasoningEffort: "medium",
      policy: {
        ...emptyAgentPolicy(),
        promptGuidance: researchPromptGuidance(
          "Explore independently and prioritize workflow design, handoff quality, evaluation plan, and operator impact.",
        ),
        ownedStages: ["open", "researching"],
        allowedTargetAgentIds: [],
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
      modelReasoningEffort: "high",
      policy: {
        ...emptyAgentPolicy(),
        promptGuidance: coordinatorPromptGuidance(),
        ownedStages: ["ready_for_build", "blocked"],
        allowedTargetAgentIds: [],
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
      modelReasoningEffort: "high",
      policy: {
        ...emptyAgentPolicy(),
        promptGuidance: implementerPromptGuidance(),
        ownedStages: ["building"],
        allowedTargetAgentIds: [],
      },
    },
    {
      id: "reviewer_1",
      name: "reviewer_1",
      brief: "Audit plans and changes. Prioritize bugs, regressions, missing tests, and weak assumptions.",
      publishChannel: auditChannel,
      listenChannels: normalizeChannelList([operator, buildChannel]),
      maxTurns: 0,
      model: null,
      modelReasoningEffort: "high",
      policy: {
        ...emptyAgentPolicy(),
        promptGuidance: reviewerPromptGuidance(),
        ownedStages: ["ready_for_review"],
        allowedTargetAgentIds: [],
      },
    },
  ];

  return applyDefaultTargetPolicies(agents);
}

export function createDefaultConfig(root = process.cwd()): AppConfig {
  const runsDir = resolve(root, "runs");
  const workspacesDir = resolve(root, "workspaces");
  const codexHomeDir = resolve(root, ".codex_research_team", "home");
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
    codexCommand: "codex",
    codexHomeMode: "project",
    codexAuthMode: "mirror-global",
    codexHomeDir,
    model: null,
    modelReasoningEffort: "high",
    modelOptions: [],
    mcpServerNames: [],
    goalChannel: "goal",
    operatorChannel: "operator",
    extraChannels: ["research", "coordination", "implementation", "review"],
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    autoOpenBrowser: false,
    search: true,
    dangerousBypass: false,
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
            modelReasoningEffort: String(agent.modelReasoningEffort ?? "").trim() || null,
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
