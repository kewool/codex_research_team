// @ts-nocheck
import { dirname, resolve } from "node:path";
import { AgentPreset, AgentRole, AppConfig, AppDefaults, SessionChannel } from "../shared/types";
import { ensureDir, projectPath, readJson, writeJson } from "./utils";

export const DEFAULT_CONFIG_PATH = projectPath("codex-group.config.json");
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

export function normalizeDefaults(defaults: Partial<AppDefaults> | undefined, fallback: AppDefaults): AppDefaults {
  return {
    ...fallback,
    ...(defaults ?? {}),
    goalChannel: normalizeChannelName(defaults?.goalChannel, fallback.goalChannel),
    researchChannel: normalizeChannelName(defaults?.researchChannel, fallback.researchChannel),
    implementationChannel: normalizeChannelName(defaults?.implementationChannel, fallback.implementationChannel),
    reviewChannel: normalizeChannelName(defaults?.reviewChannel, fallback.reviewChannel),
    operatorChannel: normalizeChannelName(defaults?.operatorChannel, fallback.operatorChannel),
    extraChannels: normalizeChannelList(Array.isArray(defaults?.extraChannels) ? defaults.extraChannels : fallback.extraChannels),
  };
}

export function teamChannels(defaults: AppDefaults): SessionChannel[] {
  return normalizeChannelList([
    defaults.goalChannel,
    defaults.researchChannel,
    defaults.implementationChannel,
    defaults.reviewChannel,
    defaults.operatorChannel,
    ...(defaults.extraChannels || []),
  ]);
}

export function allConfiguredChannels(defaults: AppDefaults): SessionChannel[] {
  return normalizeChannelList([...teamChannels(defaults), ...INTERNAL_CHANNELS]);
}

export function defaultPublishChannel(role: AgentRole, defaults: AppDefaults): SessionChannel {
  switch (role) {
    case "implementation":
      return defaults.implementationChannel;
    case "review":
      return defaults.reviewChannel;
    case "general":
      return defaults.goalChannel;
    case "research":
    default:
      return defaults.researchChannel;
  }
}

export function defaultListenChannels(role: AgentRole, defaults: AppDefaults): SessionChannel[] {
  switch (role) {
    case "implementation":
      return [defaults.researchChannel, defaults.reviewChannel, defaults.operatorChannel];
    case "review":
      return [defaults.implementationChannel, defaults.operatorChannel];
    case "general":
      return [defaults.goalChannel, defaults.researchChannel, defaults.implementationChannel, defaults.reviewChannel, defaults.operatorChannel];
    case "research":
    default:
      return [defaults.goalChannel, defaults.researchChannel, defaults.implementationChannel, defaults.operatorChannel];
  }
}

export function inferAgentRole(agent: Partial<AgentPreset> | undefined, defaults: AppDefaults): AgentRole {
  const explicitRole = String(agent?.role ?? "").trim();
  if (explicitRole === "research" || explicitRole === "implementation" || explicitRole === "review" || explicitRole === "general") {
    return explicitRole;
  }
  const publishChannel = String(agent?.publishChannel ?? "").trim();
  if (publishChannel === defaults.implementationChannel) {
    return "implementation";
  }
  if (publishChannel === defaults.reviewChannel) {
    return "review";
  }
  if (publishChannel === defaults.researchChannel) {
    return "research";
  }
  return "general";
}

function defaultAgents(defaults: AppDefaults): AgentPreset[] {
  return [
    {
      id: "researcher_1",
      name: "researcher_1",
      role: "research",
      brief: "Research independently. Prioritize architecture options and concrete plans.",
      publishChannel: defaults.researchChannel,
      listenChannels: defaultListenChannels("research", defaults),
      maxTurns: 0,
      model: null,
    },
    {
      id: "researcher_2",
      name: "researcher_2",
      role: "research",
      brief: "Research independently. Prioritize risks, tradeoffs, and failure modes.",
      publishChannel: defaults.researchChannel,
      listenChannels: defaultListenChannels("research", defaults),
      maxTurns: 0,
      model: null,
    },
    {
      id: "researcher_3",
      name: "researcher_3",
      role: "research",
      brief: "Research independently. Prioritize implementation details and operator workflow.",
      publishChannel: defaults.researchChannel,
      listenChannels: defaultListenChannels("research", defaults),
      maxTurns: 0,
      model: null,
    },
    {
      id: "implementer_1",
      name: "implementer_1",
      role: "implementation",
      brief: "Implement concrete changes from the team's research. Prioritize working code, clear diffs, and unblockers.",
      publishChannel: defaults.implementationChannel,
      listenChannels: defaultListenChannels("implementation", defaults),
      maxTurns: 0,
      model: null,
    },
    {
      id: "reviewer_1",
      name: "reviewer_1",
      role: "review",
      brief: "Review plans and implementations. Prioritize bugs, regressions, missing tests, and weak assumptions.",
      publishChannel: defaults.reviewChannel,
      listenChannels: defaultListenChannels("review", defaults),
      maxTurns: 0,
      model: null,
    },
  ];
}

export function createDefaultConfig(root = process.cwd()): AppConfig {
  const runsDir = resolve(root, "runs");
  const workspacesDir = resolve(root, "workspaces");
  ensureDir(runsDir);
  ensureDir(workspacesDir);

  const defaults: AppDefaults = {
    language: "ko",
    defaultWorkspaceName: null,
    historyTail: 14,
    serverHost: "127.0.0.1",
    serverPort: 4280,
    runsDir,
    workspacesDir,
    codexCommand: "C:/Program Files/nodejs/codex.cmd",
    model: null,
    modelOptions: [],
    goalChannel: "goal",
    researchChannel: "research",
    implementationChannel: "implementation",
    reviewChannel: "review",
    operatorChannel: "operator",
    extraChannels: [],
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    autoOpenBrowser: false,
    search: true,
    dangerousBypass: true,
  };

  return {
    defaults,
    workspaces: [],
    agents: defaultAgents(defaults),
  };
}

export function loadConfig(configPath = DEFAULT_CONFIG_PATH): AppConfig {
  const fallback = createDefaultConfig(process.cwd());
  const loaded = readJson<AppConfig>(configPath, fallback);
  const defaults = normalizeDefaults(loaded.defaults, fallback.defaults);
  const merged: AppConfig = {
    defaults,
    workspaces: Array.isArray(loaded.workspaces) ? loaded.workspaces : fallback.workspaces,
    agents: Array.isArray(loaded.agents) && loaded.agents.length > 0
      ? loaded.agents.map((agent, index) => {
          const role = inferAgentRole(agent, defaults);
          const publishChannel = normalizeChannelName(agent.publishChannel, defaultPublishChannel(role, defaults));
          const rawChannels = Array.isArray(agent.listenChannels) ? agent.listenChannels : [];
          const listenChannels = normalizeChannelList(rawChannels);
          return {
            id: String(agent.id ?? `agent_${index + 1}`).trim() || `agent_${index + 1}`,
            name: String(agent.name ?? `agent_${index + 1}`).trim() || `agent_${index + 1}`,
            role,
            brief: String(agent.brief ?? "Research independently and share novel findings.").trim() || "Research independently and share novel findings.",
            publishChannel,
            listenChannels: listenChannels.length > 0 ? listenChannels : defaultListenChannels(role, defaults),
            maxTurns: Number(agent.maxTurns ?? 0) || 0,
            model: String(agent.model ?? "").trim() || null,
          };
        })
      : defaultAgents(defaults),
  };
  ensureDir(merged.defaults.runsDir);
  ensureDir(merged.defaults.workspacesDir);
  return merged;
}

export function saveConfig(config: AppConfig, configPath = DEFAULT_CONFIG_PATH): void {
  ensureDir(dirname(resolve(configPath)));
  writeJson(configPath, config);
}
