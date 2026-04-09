// @ts-nocheck
import { CodexAgentProcess } from "../runtime/agent-process";
import { createAgentFiles } from "../persistence/storage";
import { compactWhitespace, emptyTokenUsage } from "./helpers";
import { emptyPendingDigest, hasPendingDigest } from "./digest";

export async function activateSession(session: any, mode: "new" | "resume"): Promise<void> {
  initializeAgents(session);
  if (mode === "resume") {
    session.rebuildPendingDigestsFromHistory();
  }
  session.status = "starting";
  session.persistSession();
  session.emit({ type: "session", sessionId: session.id, snapshot: session.snapshot() });

  session.status = "running";
  session.persistSession();
  session.emit({ type: "session", sessionId: session.id, snapshot: session.snapshot() });
  if (mode === "new") {
    session.publish("system", "status", `Session started in ${session.workspacePath}`);
    session.publish("user", session.goalChannel(), session.goal, { goalEvent: true });
  } else {
    session.publish("system", "status", `Session resumed in ${session.workspacePath}`);
    for (const runtime of session.agents.values()) {
      if (!session.wasInterruptedSnapshot(runtime.snapshot)) {
        continue;
      }
      session.publish(
        "operator",
        session.operatorChannel(),
        `Resume note: your previous work was interrupted before it finished. Continue from completed turn ${runtime.snapshot.turnCount} and treat this as a resumed turn, not a fresh restart.`,
        { targetAgentId: runtime.preset.id, operatorEvent: true },
      );
    }
  }

  for (const runtime of session.agents.values()) {
    if (runtime.snapshot.status === "error" || runtime.snapshot.status === "stopped") {
      continue;
    }
    void runtime.process
      .start(session.goal)
      .then(() => {
        if ((hasPendingDigest(runtime.pendingDigest) || session.goalBoardNeedsAttention(runtime)) && session.status !== "stopped") {
          session.scheduleAgentDrain(runtime.preset.id, true);
        }
      })
      .catch((error: Error) => {
        session.updateAgentSnapshot(runtime.preset.id, {
          status: "error",
          lastError: error.message,
          waitingForInput: false,
        });
      });
  }
}

export function initializeAgents(session: any): void {
  if (session.agents.size > 0) {
    return;
  }
  for (const preset of session.config.agents) {
    const files = createAgentFiles(session.files, preset.id);
    const restored = session.restoredAgents.get(preset.id);
    const snapshot = restored
      ? {
          ...restored,
          id: preset.id,
          name: preset.name,
          brief: preset.brief,
          publishChannel: preset.publishChannel,
          model: preset.model ?? session.config.defaults.model ?? restored.model ?? null,
          modelReasoningEffort: preset.modelReasoningEffort ?? session.config.defaults.modelReasoningEffort ?? restored.modelReasoningEffort ?? null,
          status:
            restored.status === "error" || restored.status === "stopped"
              ? restored.status
              : "starting",
          lastConsumedSequence: Number(restored.lastConsumedSequence ?? session.sequence),
          lastSeenSubgoalRevision: Math.max(0, Number(restored.lastSeenSubgoalRevision ?? session.subgoalRevision ?? 0)),
          lastSeenActionableSignature: typeof restored.lastSeenActionableSignature === "string" ? restored.lastSeenActionableSignature : null,
          lastSeenRoutingSignature: typeof restored.lastSeenRoutingSignature === "string" ? restored.lastSeenRoutingSignature : null,
          lastWakeReason: typeof restored.lastWakeReason === "string" ? restored.lastWakeReason : null,
          lastWakeAt: typeof restored.lastWakeAt === "string" ? restored.lastWakeAt : null,
          lastRoutedEventSummary: typeof restored.lastRoutedEventSummary === "string" ? restored.lastRoutedEventSummary : null,
          lastRoutedEventAt: typeof restored.lastRoutedEventAt === "string" ? restored.lastRoutedEventAt : null,
          pendingSignals: 0,
          waitingForInput: false,
          lastError:
            restored.status === "error"
              ? String(restored.lastError ?? "")
              : "",
          completion:
            restored.status === "error" || restored.status === "stopped"
              ? restored.completion ?? "continue"
              : restored.completion === "blocked"
                ? "continue"
                : restored.completion ?? "continue",
          teamMessages: Array.isArray(restored.teamMessages)
            ? restored.teamMessages
            : compactWhitespace(restored.teamMessage || "")
              ? [{ content: compactWhitespace(restored.teamMessage || "") }]
              : [],
          lastUsage: restored.lastUsage ?? emptyTokenUsage(),
          totalUsage: restored.totalUsage ?? emptyTokenUsage(),
        }
      : {
          id: preset.id,
          name: preset.name,
          brief: preset.brief,
          publishChannel: preset.publishChannel,
          model: preset.model ?? session.config.defaults.model ?? null,
          modelReasoningEffort: preset.modelReasoningEffort ?? session.config.defaults.modelReasoningEffort ?? null,
          status: "starting",
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
          lastUsage: emptyTokenUsage(),
          totalUsage: emptyTokenUsage(),
        };
    const runtime = new CodexAgentProcess({
      config: session.config,
      agent: preset,
      sessionId: session.id,
      workspacePath: session.workspacePath,
      language: session.config.defaults.language,
      files,
      hooks: {
        onState: (update: any) => session.updateAgentSnapshot(preset.id, update),
        onStdout: (text: string) => session.captureAgentStream(preset.id, "stdout", text),
        onStderr: (text: string) => session.captureAgentStream(preset.id, "stderr", text),
      },
    });
    if (restored) {
      runtime.restoreFromSnapshot(restored, { interrupted: session.wasInterruptedSnapshot(restored) });
    }
    session.agents.set(preset.id, {
      preset,
      files,
      process: runtime,
      snapshot,
      pendingDigest: emptyPendingDigest(),
      inFlightDigest: null,
      inFlightSubgoalRefs: null,
      retryCount: 0,
      interruptReason: null,
      draining: false,
      drainTimer: null,
    });
    session.persistAgent(preset.id);
  }
}
