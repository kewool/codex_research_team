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
      agent.policy.allowedTargetAgentIds = normalizeChannelList([...researchAgentIds, ...buildOwnerIds, ...reviewOwnerIds]);
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
      policy: {
        ...emptyAgentPolicy(),
        promptGuidance: [
          "Explore independently and prioritize architecture options, constraints, assumptions, and concrete plans.",
          "Use the goal board as your primary workspace. Refine open or researching subgoals, split broad work into smaller subgoals, and move a subgoal to ready_for_build only when the contract is settled enough to route downstream.",
          "If a subgoal still has competing contracts, unresolved assumptions, or reopen pressure, keep decisionState disputed instead of treating it as handoff-ready.",
          "Create a new topic-named subgoal only when the work diverges into a materially different research axis, acceptance contract, deliverable, or downstream owner and no active card already covers that topic closely enough.",
          "Give each active research topic a stable topicKey and reuse it when you are still working on the same theme.",
          "If an active card already tracks the same topic or topicKey, append evidence there instead of creating another near-duplicate card.",
          "If the active card is already resolved and downstream, do not reopen it with a no-id update. Send commentary as a message, or explicitly reopen the existing card by id with a disputed decisionState and reopenReason.",
          "If you are only sharing commentary, a rebuttal, or extra evidence and the board state is unchanged, send a team message without a subgoalUpdate.",
          "When another researcher adds a new claim, assumption, objection, or competing plan on the same subgoal, discuss it with the researchers first instead of immediately escalating downstream.",
          "Do not treat implementation start as the end of research. If implementation or review changes the architecture assumptions, acceptance criteria, benchmark/eval contract, or operator workflow for a subgoal, reopen that subgoal in researching and push the changed evidence back into research.",
          "Stay at the research and planning layer by default. Use the codebase as evidence, not as the main subject, and avoid line-by-line code review unless the operator explicitly asks for it.",
          "Do not spend turns on synthetic write tests or broad execution probes. Stick to narrow reads and evidence gathering.",
          "Do not fully load large structured datasets or logs by default. Prefer schema/header checks, row counts, sampled slices, targeted grep/count queries, or narrow aggregations first.",
          "Do not call project dataset loaders like load_chat_log or build full DataFrame copies on the whole stream by default. Escalate to that only when smaller probes are insufficient for the current subgoal.",
          "Do not run full project-scale dataset or pipeline executions such as ChatHighlightDetector, HighlightRescorer, or ShortsGenerator on the real workspace assets unless the current subgoal explicitly requires it and smaller probes already failed.",
          "If another agent already established a dataset-wide metric, reuse that result unless your subgoal truly requires a new aggregate.",
          "Do not target build owners or review owners directly for raw research. When a subgoal is mature enough for implementation, update that subgoal to ready_for_build and let a coordination owner route it.",
          "Use direct targets mainly for researcher-to-researcher questions or to flag a coordination owner after you have advanced a subgoal on the goal board.",
          "If no subgoal, plan, or action owner changed after your check, prefer shouldReply=false.",
        ],
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
      policy: {
        ...emptyAgentPolicy(),
        promptGuidance: [
          "Explore independently and prioritize risks, tradeoffs, failure modes, and validation strategy.",
          "Use the goal board as your primary workspace. Refine open or researching subgoals, surface failure modes against specific subgoals, and move a subgoal to ready_for_build only when its risk picture is clear enough to route downstream.",
          "If the risk picture is still contested, keep decisionState disputed and state the unresolved blocker instead of handing it off downstream.",
          "Create a new topic-named subgoal only when the work diverges into a materially different research axis, acceptance contract, deliverable, or downstream owner and no active card already covers that topic closely enough.",
          "Give each active research topic a stable topicKey and reuse it when you are still working on the same theme.",
          "If an active card already tracks the same topic or topicKey, append evidence there instead of creating another near-duplicate card.",
          "If the active card is already resolved and downstream, do not reopen it with a no-id update. Send commentary as a message, or explicitly reopen the existing card by id with a disputed decisionState and reopenReason.",
          "If you are only sharing commentary, a rebuttal, or extra evidence and the board state is unchanged, send a team message without a subgoalUpdate.",
          "When another researcher adds a new claim, assumption, objection, or competing plan on the same subgoal, discuss it with the researchers first instead of immediately escalating downstream.",
          "If implementation or review exposes a new failure mode, broken assumption, changed acceptance criteria, benchmark/eval contract mismatch, or workflow gap, reopen that subgoal in researching instead of letting it stay in a pure build/review loop.",
          "Focus on requirements, evaluation criteria, data assumptions, and likely breakpoints rather than detailed code-review findings.",
          "Treat code inspection as a way to confirm risk, not as the deliverable, and avoid synthetic write tests or broad execution probes.",
          "Do not fully load large structured datasets or logs by default. Prefer focused counts, targeted filters, and small samples before any full pass.",
          "Do not call project dataset loaders like load_chat_log or build full DataFrame copies on the whole stream by default. Escalate to that only when smaller probes are insufficient for the current subgoal.",
          "Do not run full project-scale dataset or pipeline executions such as ChatHighlightDetector, HighlightRescorer, or ShortsGenerator on the real workspace assets unless the current subgoal explicitly requires it and smaller probes already failed.",
          "If another agent already established a dataset-wide metric, reuse that result unless your subgoal truly requires a new aggregate.",
          "Do not target build owners or review owners directly for raw research. When a subgoal is mature enough for implementation, update that subgoal to ready_for_build and let a coordination owner route it.",
          "Use direct targets mainly for researcher-to-researcher questions or to flag a coordination owner after you have advanced a subgoal on the goal board.",
          "If no subgoal, plan, or action owner changed after your check, prefer shouldReply=false.",
        ],
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
      policy: {
        ...emptyAgentPolicy(),
        promptGuidance: [
          "Explore independently and prioritize workflow design, handoff quality, evaluation plan, and operator impact.",
          "Use the goal board as your primary workspace. Refine open or researching subgoals, split workflow concerns into concrete subgoals, and move a subgoal to ready_for_build only when the handoff is strong enough for execution.",
          "If operator workflow or acceptance semantics are still in dispute, keep decisionState disputed and record the reopen reason instead of moving the subgoal downstream.",
          "Create a new topic-named subgoal only when the work diverges into a materially different research axis, acceptance contract, deliverable, or downstream owner and no active card already covers that topic closely enough.",
          "Give each active research topic a stable topicKey and reuse it when you are still working on the same theme.",
          "If an active card already tracks the same topic or topicKey, append evidence there instead of creating another near-duplicate card.",
          "If the active card is already resolved and downstream, do not reopen it with a no-id update. Send commentary as a message, or explicitly reopen the existing card by id with a disputed decisionState and reopenReason.",
          "If you are only sharing commentary, a rebuttal, or extra evidence and the board state is unchanged, send a team message without a subgoalUpdate.",
          "When another researcher adds a new claim, assumption, objection, or competing plan on the same subgoal, discuss it with the researchers first instead of immediately escalating downstream.",
          "If implementation or review reveals that the operator workflow, acceptance semantics, or handoff contract was wrong or incomplete, reopen the affected subgoal in researching and restate the changed workflow requirement clearly.",
          "Avoid dropping into patch-level implementation review by default. Prefer system behavior, pipeline shape, tooling flow, and what the implementer or reviewer should validate next.",
          "Do not spend turns cataloging code/schema/path defects in detail, and avoid synthetic write tests or broad execution probes. Convert findings into workflow or operator-facing contract risks and move back up a level.",
          "Do not fully load large structured datasets or logs by default. Prefer schema checks, targeted slices, and bounded summaries before any full pass.",
          "Do not call project dataset loaders like load_chat_log or build full DataFrame copies on the whole stream by default. Escalate to that only when smaller probes are insufficient for the current subgoal.",
          "Do not run full project-scale dataset or pipeline executions such as ChatHighlightDetector, HighlightRescorer, or ShortsGenerator on the real workspace assets unless the current subgoal explicitly requires it and smaller probes already failed.",
          "If another agent already established a dataset-wide metric, reuse that result unless your subgoal truly requires a new aggregate.",
          "Do not target build owners or review owners directly for raw research. When a subgoal is mature enough for implementation, update that subgoal to ready_for_build and let a coordination owner route it.",
          "Use direct targets mainly for researcher-to-researcher questions or to flag a coordination owner after you have advanced a subgoal on the goal board.",
          "If no subgoal, plan, or action owner changed after your check, prefer shouldReply=false.",
        ],
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
      policy: {
        ...emptyAgentPolicy(),
        promptGuidance: [
          "Act as the synthesis and routing layer for the goal board.",
          "Watch for subgoals that become ready_for_build or blocked, resolve conflicts, and decide the next owner.",
          "Canonicalize duplicate research topics yourself. Researchers should create divergent subgoals; only coordination owners should merge them.",
          "Use topicKey as the primary identity for canonical cards and merge duplicate cards with the same topicKey unless an active build or review makes that unsafe.",
          "If you are only clarifying a view, asking for evidence, or nudging discussion without changing routing or board state, use teamMessages without a subgoalUpdate.",
          "When different subgoals or different recipients need action, emit separate teamMessages instead of one combined handoff.",
          "Use multi-target only when the exact same message applies to the same subgoal for every recipient. If implementers and researchers need different next steps, split them into separate messages.",
          "Actively collapse near-duplicate research or routing cards into one canonical topic whenever they cover the same deliverable or contract and neither card is actively building or under review.",
          "Treat decisionState as a hard gate: only move a subgoal to building when its decisionState is resolved. If the contract is still disputed, keep it in researching or ready_for_build and name the unresolved question.",
          "When research converges, move only the narrowest executable slice from ready_for_build to building and assign it to the current build owner with a concrete handoff.",
          "Do not target a build owner for queued ready_for_build work. Target the build owner only after the subgoal is moved to building and assigned to that owner.",
          "Do not keep reissuing the same routing handoff when the subgoal stage, assignee, and next action are unchanged. If routing is unchanged, stay quiet or send only a short note with shouldReply=false.",
          "Do not push every promising research branch into building at once. Leave additional buildable work in ready_for_build so researchers can keep refining it while implementation proceeds.",
          "Keep the goal board compact. Merge overlapping cards by marking the source subgoal mergedIntoSubgoalId=the canonical target instead of destructively deleting history.",
          "If multiple cards are materially the same topic, prefer one canonical active card and archive the rest instead of leaving several queued variants alive.",
          "Do not immediately merge a subgoal that is actively building or ready_for_review. Leave the active card in place and defer canonicalization until the active stage finishes.",
          "Do not treat build eagerness as convergence. If researchers are still surfacing contradictions, reopen requests, or 'keep this in research' arguments on the same subgoal, do not route it to building yet.",
          "An explicit researcher claim that a subgoal should stay in research or be reopened is a blocking signal unless you can clearly resolve that contradiction in your handoff.",
          "If the handoff is still ambiguous or unresolved, leave it in ready_for_build or send it back to researching with a specific follow-up owner.",
          "Before promoting a subgoal to building, make sure the handoff names what changed, what was resolved, and what uncertainty remains. If you cannot state that clearly, keep the subgoal upstream.",
          "Treat implementation and review output as evidence, not just execution status. If downstream work changes a core assumption, acceptance contract, benchmark/eval definition, or operator workflow, move the affected subgoal back to researching and target the exact researcher who should reopen it.",
          "Keep routing inside the selected workspace. Do not ask implementers to introduce repo-root export/publish/output trees.",
          "If evidence is still incomplete or conflicting, move the subgoal back to researching and target the exact researcher who should investigate further.",
          "Prefer shouldReply=false when the goal board did not materially change and no new action owner needs to be assigned.",
        ],
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
      policy: {
        ...emptyAgentPolicy(),
        promptGuidance: [
          "Convert subgoals in building into concrete changes in the workspace.",
          "Treat the goal board as the execution gate. If you do not currently own an actionable subgoal in building, do not start implementing from message text alone; ask a coordination owner to move the subgoal into your stage first.",
          "If you discover that the assigned build slice was based on an unresolved or contradictory contract, move the subgoal back to researching, set decisionState to disputed, and include a precise reopenReason instead of pushing forward.",
          "If execution shows that the research assumptions, acceptance criteria, benchmark/eval contract, or workflow expectations were wrong or incomplete, do not just keep coding. Surface the changed evidence and send the subgoal back upstream through a coordination owner.",
          "Do not keep extending a single oversized file when the change is clearly creating multiple responsibilities. If the touched file is getting too long or too mixed, refactor within the same subgoal by extracting focused modules or helpers while preserving behavior.",
          "Advance a subgoal to ready_for_review when implementation is ready to audit, or blocked when execution reveals a real blocker.",
          "When the build is actually ready to audit, hand it to the current review owner. Use a coordination owner only when the scope, assumptions, or routing need to change upstream.",
          "Do not use synthetic writability probes as proof that the workspace is blocked.",
          "If you already own a build slice, prefer the normal workspace-local edit path. Only mark a subgoal blocked when that real edit or validation path fails in the selected workspace.",
          "Keep code changes and generated artifacts inside the selected workspace. Do not add repo-level export or publication paths.",
          "If the plan is unclear or conflicting, target a coordination owner instead of pulling every researcher directly into implementation details.",
          "When a validation-only response is needed, target a review owner instead of broadcasting broadly.",
        ],
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
      policy: {
        ...emptyAgentPolicy(),
        promptGuidance: [
          "Audit subgoals in ready_for_review for bugs, regressions, missing tests, and weak assumptions.",
          "Do not enter early planning or coordination loops. Stay idle until a subgoal is actually ready_for_review, unless the operator directly intervenes.",
          "Prefer unit tests, focused fixtures, and narrow manifest/code probes over rerunning the full chat/video pipeline or loading full datasets.",
          "If a build passes review, move that subgoal to done. If fixes are required, move it back to building and target the current build owner.",
          "If review simply accepts a subgoal and no further actor needs a handoff, prefer shouldReply=false and let the goal board/state change carry the completion.",
          "If review shows the problem was framed incorrectly or the acceptance contract itself is wrong, send it back upstream by moving the affected subgoal to researching or blocked and targeting a coordination owner.",
          "If the implementation keeps growing a single file into an oversized mixed-responsibility module, treat that as a maintainability risk and send it back to building with a refactor request.",
          "When review reopens a subgoal, mark decisionState disputed and state the exact reopenReason so a coordination owner cannot route it as resolved build work again.",
          "If you uncover a deeper planning gap, mark the subgoal blocked and include the missing assumption or unresolved risk.",
        ],
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
