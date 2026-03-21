export type SessionChannel = string;
export type AgentStatus = "starting" | "ready" | "running" | "waiting-input" | "idle" | "error" | "stopped";
export type SessionStatus = "starting" | "running" | "idle" | "stopping" | "stopped" | "error";
export type AgentHistoryKind = "notes" | "messages" | "prompts" | "stdout" | "stderr" | "errors";
export const SUBGOAL_STAGES = [
  "open",
  "researching",
  "ready_for_build",
  "building",
  "ready_for_review",
  "done",
  "blocked",
] as const;
export type SubgoalStage = (typeof SUBGOAL_STAGES)[number];
export const SUBGOAL_DECISION_STATES = ["open", "disputed", "resolved"] as const;
export type SubgoalDecisionState = (typeof SUBGOAL_DECISION_STATES)[number];

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface AgentPolicy {
  promptGuidance: string[];
  ownedStages: SubgoalStage[];
  allowedTargetAgentIds: string[];
  forceBroadcastOnFirstTurn: boolean;
}

export interface AgentPreset {
  id: string;
  name: string;
  brief: string;
  publishChannel: SessionChannel;
  listenChannels: SessionChannel[];
  maxTurns: number;
  model: string | null;
  policy: AgentPolicy;
}

export interface WorkspacePreset {
  name: string;
  path: string;
}

export interface AppDefaults {
  language: string;
  defaultWorkspaceName: string | null;
  historyTail: number;
  serverHost: string;
  serverPort: number;
  runsDir: string;
  workspacesDir: string;
  codexCommand: string;
  codexHomeMode: "project" | "global";
  codexHomeDir: string;
  model: string | null;
  modelReasoningEffort: string | null;
  modelOptions: string[];
  mcpServerNames: string[];
  goalChannel: SessionChannel;
  operatorChannel: SessionChannel;
  extraChannels: SessionChannel[];
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "untrusted" | "on-request" | "on-failure" | "never";
  autoOpenBrowser: boolean;
  search: boolean;
  dangerousBypass: boolean;
}

export interface AppConfig {
  defaults: AppDefaults;
  workspaces: WorkspacePreset[];
  agents: AgentPreset[];
}

export interface SessionEvent {
  sequence: number;
  timestamp: string;
  sender: string;
  channel: SessionChannel;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SessionSubgoal {
  id: string;
  title: string;
  summary: string;
  stage: SubgoalStage;
  decisionState: SubgoalDecisionState;
  lastReopenReason: string | null;
  assigneeAgentId: string | null;
  updatedAt: string;
  updatedBy: string;
  revision: number;
  conflictCount: number;
  activeConflict: boolean;
  lastConflictAt: string | null;
  lastConflictSummary: string | null;
}

export interface SubgoalUpdate {
  id?: string | null;
  expectedRevision?: number | null;
  title?: string | null;
  summary?: string | null;
  stage?: SubgoalStage | null;
  decisionState?: SubgoalDecisionState | null;
  reopenReason?: string | null;
  assigneeAgentId?: string | null;
}

export interface AgentHistoryEntry {
  id: string;
  timestamp: string;
  kind: AgentHistoryKind;
  text: string;
  label?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AgentTurnResult {
  shouldReply: boolean;
  workingNotes: string[];
  teamMessage: string;
  targetAgentId?: string | null;
  targetAgentIds?: string[] | null;
  subgoalUpdates?: SubgoalUpdate[];
  completion: "continue" | "done" | "blocked";
  rawText: string;
}

export interface AgentSnapshot {
  id: string;
  name: string;
  brief: string;
  publishChannel: SessionChannel;
  model: string | null;
  status: AgentStatus;
  turnCount: number;
  lastConsumedSequence: number;
  lastSeenSubgoalRevision: number;
  pendingSignals: number;
  waitingForInput: boolean;
  lastPrompt: string;
  lastInput: string;
  lastError: string;
  lastResponseAt: string | null;
  completion: "continue" | "done" | "blocked";
  workingNotes: string[];
  teamMessage: string;
  stdoutTail: string;
  stderrTail: string;
  lastUsage: TokenUsage;
  totalUsage: TokenUsage;
}

export interface SessionSnapshot {
  id: string;
  title: string;
  goal: string;
  workspaceName: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  eventCount: number;
  subgoalRevision: number;
  agentCount: number;
  selectedAgentId: string | null;
  agents: AgentSnapshot[];
  recentEvents: SessionEvent[];
  subgoals: SessionSubgoal[];
  totalUsage: TokenUsage;
}

export interface HistoryPage<T> {
  items: T[];
  nextBefore: string | number | null;
  hasMore: boolean;
}

export interface ModelCatalog {
  models: string[];
  source: string;
  fetchedAt: string | null;
}

export interface McpCatalog {
  servers: string[];
  source: string;
}

export interface RootSnapshot {
  config: AppConfig;
  sessions: SessionSnapshot[];
  modelCatalog: ModelCatalog;
  mcpCatalog: McpCatalog;
}

export interface StartSessionRequest {
  goal: string;
  workspaceName?: string;
  workspacePath?: string;
  title?: string;
}

export interface SendAgentInputRequest {
  agentId: string;
  text: string;
}

export interface SendSessionInstructionRequest {
  text: string;
  targetAgentId?: string | null;
  channel: "goal" | "operator";
}
