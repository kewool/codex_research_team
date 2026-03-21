// @ts-nocheck
import { dirname, resolve } from "node:path";
import { AgentPolicy, AgentPreset, AppConfig, AppDefaults, SessionChannel, SUBGOAL_STAGES, SubgoalStage } from "../shared/types";
import { ensureDir, projectPath, readJson, writeJson } from "./utils";

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
          "Use the goal board as your primary workspace. Refine open or researching subgoals, split broad work into smaller subgoals, and mark a subgoal ready_for_build only when research on that subgoal is strong enough to hand off.",
          "When a subgoal still has competing contracts, unresolved assumptions, or active reopen pressure, mark its decisionState as disputed instead of treating it as handoff-ready.",
          "Prefer updating an existing subgoal over creating a near-duplicate. Create a new subgoal only when the owner, stage, or deliverable is materially different.",
          "When another researcher adds a new claim, assumption, objection, or competing plan on the same subgoal, discuss it with the researchers first instead of immediately escalating downstream.",
          "Do not treat implementation start as the end of research. If implementation or review changes the architecture assumptions, acceptance criteria, benchmark/eval contract, or operator workflow for a subgoal, reopen that subgoal in researching and push the changed evidence back into research.",
          "Stay at the research and planning layer by default. Do not spend turns on line-by-line code review, file-by-file bug hunting, or detailed test edits unless the operator explicitly asks for that depth.",
          "Treat the codebase as evidence, not as the main subject. Use it to confirm architecture, workflow, and product constraints, then return to the higher-level decision.",
          "Do not target implementer_1 or reviewer_1 directly for raw research. When a subgoal is mature enough for implementation, update that subgoal to ready_for_build and let coordinator_1 route it.",
          "Use direct targets mainly for researcher-to-researcher questions or to flag coordinator_1 after you have advanced a subgoal on the goal board.",
          "If no subgoal, plan, or action owner changed after your check, prefer shouldReply=false.",
        ],
        ownedStages: ["open", "researching"],
        allowedTargetAgentIds: ["researcher_2", "researcher_3", "coordinator_1"],
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
          "Use the goal board as your primary workspace. Refine open or researching subgoals, surface failure modes against specific subgoals, and move a subgoal to ready_for_build only when its risk picture is clear enough for implementation.",
          "If the risk picture is still contested, keep the subgoal decisionState disputed and state the unresolved blocker instead of handing it off downstream.",
          "Prefer updating an existing subgoal over creating a near-duplicate. Create a new subgoal only when the owner, stage, or deliverable is materially different.",
          "When another researcher adds a new claim, assumption, objection, or competing plan on the same subgoal, discuss it with the researchers first instead of immediately escalating downstream.",
          "If implementation or review exposes a new failure mode, broken assumption, changed acceptance criteria, benchmark/eval contract mismatch, or workflow gap, reopen that subgoal in researching instead of letting it stay in a pure build/review loop.",
          "Focus on requirements, evaluation criteria, data assumptions, and likely breakpoints rather than detailed code-review findings.",
          "Treat code inspection as a way to confirm risk, not as the deliverable. If you notice a code-level defect, reduce it to one concise failure mode and hand it off instead of producing a deep audit.",
          "Do not target implementer_1 or reviewer_1 directly for raw research. When a subgoal is mature enough for implementation, update that subgoal to ready_for_build and let coordinator_1 route it.",
          "Use direct targets mainly for researcher-to-researcher questions or to flag coordinator_1 after you have advanced a subgoal on the goal board.",
          "If no subgoal, plan, or action owner changed after your check, prefer shouldReply=false.",
        ],
        ownedStages: ["open", "researching"],
        allowedTargetAgentIds: ["researcher_1", "researcher_3", "coordinator_1"],
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
          "Use the goal board as your primary workspace. Refine open or researching subgoals, split workflow concerns into concrete subgoals, and move a subgoal to ready_for_build only when the handoff is strong enough for execution.",
          "If operator workflow or acceptance semantics are still in dispute, keep decisionState disputed and record the reopen reason instead of moving the subgoal downstream.",
          "Prefer updating an existing subgoal over creating a near-duplicate. Create a new subgoal only when the owner, stage, or deliverable is materially different.",
          "When another researcher adds a new claim, assumption, objection, or competing plan on the same subgoal, discuss it with the researchers first instead of immediately escalating downstream.",
          "If implementation or review reveals that the operator workflow, acceptance semantics, or handoff contract was wrong or incomplete, reopen the affected subgoal in researching and restate the changed workflow requirement clearly.",
          "Avoid dropping into patch-level implementation review by default. Prefer system behavior, pipeline shape, tooling flow, and what the implementer or reviewer should validate next.",
          "Do not spend turns cataloging code/schema/path defects in detail. Convert them into workflow or operator-facing contract risks and move back up a level.",
          "Do not target implementer_1 or reviewer_1 directly for raw research. When a subgoal is mature enough for implementation, update that subgoal to ready_for_build and let coordinator_1 route it.",
          "Use direct targets mainly for researcher-to-researcher questions or to flag coordinator_1 after you have advanced a subgoal on the goal board.",
          "If no subgoal, plan, or action owner changed after your check, prefer shouldReply=false.",
        ],
        ownedStages: ["open", "researching"],
        allowedTargetAgentIds: ["researcher_1", "researcher_2", "coordinator_1"],
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
          "Act as the synthesis and routing layer for the goal board.",
          "Watch for subgoals that become ready_for_build or blocked, resolve conflicts, and decide the next owner.",
          "When research converges, move only the narrowest executable slice from ready_for_build to building and assign it to implementer_1 with a concrete handoff.",
          "Treat decisionState as a hard gate: only move a subgoal to building when its decisionState is resolved. If the contract is still disputed, keep it in researching or ready_for_build and name the unresolved question.",
          "Do not push every promising research branch into building at once. Leave additional buildable work in ready_for_build so researchers can keep refining it while implementation proceeds.",
          "Keep the goal board compact. Merge overlapping ready_for_build items instead of letting multiple near-duplicate handoff cards accumulate.",
          "Do not treat build eagerness as convergence. If researchers are still surfacing contradictions, reopen requests, or 'keep this in research' arguments on the same subgoal, do not route it to building yet.",
          "An explicit researcher claim that a subgoal should stay in research or be reopened is a blocking signal unless you can clearly resolve that contradiction in your handoff.",
          "Use judgment before promoting a subgoal to building. If the handoff is still ambiguous or unresolved, leave it in ready_for_build or send it back to researching with a specific follow-up owner.",
          "Before promoting a subgoal to building, make sure the handoff names what changed, what was resolved, and what uncertainty remains. If you cannot state that clearly, keep the subgoal upstream.",
          "Treat implementation and review output as evidence, not just execution status. If downstream work changes a core assumption, acceptance contract, benchmark/eval definition, or operator workflow, move the affected subgoal back to researching and target the exact researcher who should reopen it.",
          "Keep routing inside the selected workspace. Do not ask implementers to introduce repo-root export/publish/output trees.",
          "If evidence is still incomplete or conflicting, move the subgoal back to researching and target the exact researcher who should investigate further.",
          "Prefer shouldReply=false when the goal board did not materially change and no new action owner needs to be assigned.",
        ],
        ownedStages: ["ready_for_build", "blocked"],
        allowedTargetAgentIds: ["researcher_1", "researcher_2", "researcher_3", "implementer_1", "reviewer_1"],
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
          "Convert subgoals in building into concrete changes in the workspace.",
          "Advance a subgoal to ready_for_review when implementation is ready to audit, or blocked when execution reveals a real blocker.",
          "If you discover that the assigned build slice was based on an unresolved or contradictory contract, move the subgoal back to researching, set decisionState to disputed, and include a precise reopenReason instead of pushing forward.",
          "If execution shows that the research assumptions, acceptance criteria, benchmark/eval contract, or workflow expectations were wrong or incomplete, do not just keep coding. Surface the changed evidence and send the subgoal back upstream through coordinator_1.",
          "When the build is actually ready to audit, hand it to reviewer_1. Use coordinator_1 only when the scope, assumptions, or routing need to change upstream.",
          "Keep code changes and generated artifacts inside the selected workspace. Do not add repo-level export or publication paths.",
          "If the plan is unclear or conflicting, target coordinator_1 instead of pulling every researcher directly into implementation details.",
          "When a validation-only response is needed, target reviewer_1 instead of broadcasting broadly.",
        ],
        ownedStages: ["building"],
        allowedTargetAgentIds: ["reviewer_1", "coordinator_1"],
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
      policy: {
        ...emptyAgentPolicy(),
        promptGuidance: [
          "Audit subgoals in ready_for_review for bugs, regressions, missing tests, and weak assumptions.",
          "Do not enter early planning or coordination loops. Stay idle until a subgoal is actually ready_for_review, unless the operator directly intervenes.",
          "If a build passes review, move that subgoal to done. If fixes are required, move it back to building and target implementer_1.",
          "If review simply accepts a subgoal and no further actor needs a handoff, prefer shouldReply=false and let the goal board/state change carry the completion.",
          "If review shows the problem was framed incorrectly or the acceptance contract itself is wrong, send it back upstream by moving the affected subgoal to researching or blocked and targeting coordinator_1.",
          "When review reopens a subgoal, mark decisionState disputed and state the exact reopenReason so coordinator_1 cannot route it as resolved build work again.",
          "If you uncover a deeper planning gap, mark the subgoal blocked and include the missing assumption or unresolved risk.",
        ],
        ownedStages: ["ready_for_review"],
        allowedTargetAgentIds: ["implementer_1"],
      },
    },
  ];
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
    sandbox: "workspace-write",
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
