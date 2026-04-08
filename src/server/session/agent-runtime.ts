// @ts-nocheck
import { nowIso, tailText } from "../lib/utils";
import { appendAgentHistory as appendAgentHistoryEntry, writeAgentSnapshot, writeSessionSnapshot } from "../persistence/storage";
import { SNAPSHOT_STREAM_TAIL } from "./helpers";
import { combinePendingDigests, hasPendingDigest } from "./digest";

export function shouldRetryTransientTurnFailure(message: string): boolean {
  const normalized = String(message ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("max_output_tokens") ||
    normalized.includes("stream disconnected before completion") ||
    normalized.includes("incomplete response returned") ||
    normalized.includes("an error occurred while processing your request")
  );
}

export function restoreFailedInFlightDigest(session: any, agent: any, digest: any): void {
  agent.pendingDigest = combinePendingDigests(digest, agent.pendingDigest);
  agent.snapshot.pendingSignals = agent.pendingDigest.totalCount;
  persistAgent(session, agent.preset.id);
  persistSession(session);
}

export function captureAgentStream(session: any, agentId: string, stream: "stdout" | "stderr", text: string): void {
  const agent = session.agents.get(agentId);
  if (!agent || !text) {
    return;
  }
  const field = stream === "stdout" ? "stdoutTail" : "stderrTail";
  agent.snapshot[field] = tailText(`${agent.snapshot[field]}${text}`, SNAPSHOT_STREAM_TAIL);
  persistAgent(session, agentId);
  persistSession(session);
  session.emit({ type: "stream", sessionId: session.id, agentId, stream, text });
}

export function appendAgentHistory(session: any, agent: any, kind: "notes" | "messages" | "errors", text: string, label?: string | null): void {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return;
  }
  appendAgentHistoryEntry(agent.files, {
    id: `${agent.preset.id}-${kind}-${++session.historySerial}`,
    timestamp: nowIso(),
    kind,
    text: normalized,
    label: label ?? null,
    metadata: {
      agentId: agent.preset.id,
      turnCount: agent.snapshot.turnCount,
    },
  });
}

export function persistAgent(session: any, agentId: string): void {
  const agent = session.agents.get(agentId);
  if (!agent) {
    return;
  }
  writeAgentSnapshot(agent.files.stateJson, agent.snapshot);
}

export function persistSession(session: any): void {
  writeSessionSnapshot(session.files, session.snapshot(false));
}

export function updateAgentSnapshot(session: any, agentId: string, update: any): void {
  const agent = session.agents.get(agentId);
  if (!agent) {
    return;
  }
  const previousPrompt = agent.snapshot.lastPrompt;
  const previousError = agent.snapshot.lastError;
  agent.snapshot = {
    ...agent.snapshot,
    ...update,
  };
  if (typeof update.lastPrompt === "string" && update.lastPrompt.trim() && update.lastPrompt !== previousPrompt) {
    agent.snapshot.lastPrompt = tailText(update.lastPrompt, 4000);
  }
  if (typeof update.lastError === "string" && update.lastError.trim() && update.lastError !== previousError) {
    agent.snapshot.lastError = tailText(update.lastError, 4000);
    appendAgentHistory(session, agent, "errors", update.lastError.trim(), agent.snapshot.status === "error" ? "Agent Error" : null);
  }
  persistAgent(session, agentId);
  persistSession(session);
  session.emit({ type: "agent", sessionId: session.id, agent: { ...agent.snapshot } });
}

export async function interruptAgent(session: any, agentId: string, mode: "stop" | "restart"): Promise<void> {
  const agent = session.agents.get(agentId);
  if (!agent) {
    throw new Error(`Unknown agent: ${agentId}`);
  }
  const hadInFlightTurn = agent.draining || Boolean(agent.inFlightDigest);
  if (agent.drainTimer) {
    clearTimeout(agent.drainTimer);
    agent.drainTimer = null;
  }
  if (agent.inFlightDigest) {
    restoreFailedInFlightDigest(session, agent, agent.inFlightDigest);
  }
  agent.retryCount = 0;
  agent.interruptReason = mode;
  await agent.process.stop();
  updateAgentSnapshot(session, agentId, {
    status: mode === "restart" ? "starting" : "stopped",
    waitingForInput: false,
    lastError: "",
    ...(mode === "restart" ? { completion: "continue" } : {}),
  });
  if (!hadInFlightTurn) {
    agent.interruptReason = null;
  }
  if (mode !== "restart") {
    return;
  }
  session.status = "running";
  try {
    await agent.process.start(session.goal);
  } catch (error) {
    agent.interruptReason = null;
    updateAgentSnapshot(session, agentId, {
      status: "error",
      waitingForInput: false,
      lastError: String((error as Error).message || error),
    });
    throw error;
  }
  updateAgentSnapshot(session, agentId, { status: "idle", waitingForInput: false, lastError: "" });
  if (hasPendingDigest(agent.pendingDigest) || session.goalBoardNeedsAttention(agent)) {
    session.scheduleAgentDrain(agentId, true);
  }
}
