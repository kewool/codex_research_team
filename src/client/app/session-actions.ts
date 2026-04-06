type AnyObject = Record<string, any>;
type ScrollBottomTarget = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">;

export function distanceFromBottom(element: ScrollBottomTarget): number {
  return Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
}

export function shouldTriggerBottomLoad(cache: AnyObject, element: ScrollBottomTarget, threshold = 120): boolean {
  const nearBottom = distanceFromBottom(element) <= threshold;
  if (!nearBottom) {
    cache.bottomLoadLocked = false;
    return false;
  }
  if (cache.loading || !cache.hasMore) {
    return false;
  }
  if (cache.bottomLoadLocked) {
    return false;
  }
  cache.bottomLoadLocked = true;
  return true;
}

type SessionActionDeps = {
  state: AnyObject;
  currentSession: () => AnyObject | null;
  currentAgentTab: () => string;
  historyKindForTab: (tab: string) => string;
  feedCache: (sessionId: string) => AnyObject;
  agentHistoryCache: (sessionId: string, agentId: string, kind: string) => AnyObject;
  saveElementScrollAnchor: (element: HTMLElement, modeOverride?: "append" | "prepend") => void;
  loadSessionFeed: (sessionId: string, options?: AnyObject) => Promise<void>;
  loadAgentHistory: (sessionId: string, agentId: string, kind: string, options?: AnyObject) => Promise<void>;
  loadVisibleAgentHistory: (force?: boolean) => Promise<void>;
  setFlash: (kind: "error" | "info", text: string) => void;
  clearFlash: () => void;
  api: (path: string, init?: RequestInit) => Promise<any>;
  qs: <T extends HTMLElement>(selector: string) => T;
  upsertSession: (snapshot: AnyObject) => void;
  refreshState: () => Promise<void>;
  bindSessionStream: () => void;
  render: () => void;
};

export function createSessionActionTools(deps: SessionActionDeps) {
  const {
    state,
    currentSession,
    currentAgentTab,
    historyKindForTab,
    feedCache,
    agentHistoryCache,
    saveElementScrollAnchor,
    loadSessionFeed,
    loadAgentHistory,
    loadVisibleAgentHistory,
    setFlash,
    clearFlash,
    api,
    qs,
    upsertSession,
    refreshState,
    bindSessionStream,
    render,
  } = deps;

  async function sendSessionCommand(channel: "goal" | "operator"): Promise<void> {
    const session = currentSession();
    if (!session) {
      return;
    }
    const text = qs<HTMLTextAreaElement>("#session-command").value.trim();
    if (!text) {
      setFlash("error", "Enter a message before sending.");
      return;
    }
    const targetAgentId = qs<HTMLSelectElement>("#session-target").value || null;
    const hadLiveStream = Boolean(state.stream);
    const wasLive = Boolean(session.isLive);
    const payload = await api(`/api/sessions/${encodeURIComponent(session.id)}/instructions`, {
      method: "POST",
      body: JSON.stringify({ channel, text, targetAgentId }),
    });
    upsertSession(payload.session);
    if (!hadLiveStream || !wasLive) {
      bindSessionStream();
    }
    await loadSessionFeed(session.id, { reset: true, force: true });
    qs<HTMLTextAreaElement>("#session-command").value = "";
    clearFlash();
    render();
  }

  async function stopCurrentSession(): Promise<void> {
    const session = currentSession();
    if (!session) {
      return;
    }
    await api(`/api/sessions/${encodeURIComponent(session.id)}/stop`, { method: "POST" });
    await refreshState();
  }

  async function resumeCurrentSession(): Promise<void> {
    const session = currentSession();
    if (!session) {
      return;
    }
    const payload = await api(`/api/sessions/${encodeURIComponent(session.id)}/resume`, { method: "POST" });
    upsertSession(payload.session);
    bindSessionStream();
    await loadSessionFeed(session.id, { reset: true, force: true });
    clearFlash();
    render();
  }

  async function stopSessionAgent(agentId: string): Promise<void> {
    const session = currentSession();
    if (!session || !agentId) {
      return;
    }
    const payload = await api(`/api/sessions/${encodeURIComponent(session.id)}/agents/${encodeURIComponent(agentId)}/stop`, {
      method: "POST",
    });
    upsertSession(payload.session);
    clearFlash();
    render();
  }

  async function restartSessionAgent(agentId: string): Promise<void> {
    const session = currentSession();
    if (!session || !agentId) {
      return;
    }
    const payload = await api(`/api/sessions/${encodeURIComponent(session.id)}/agents/${encodeURIComponent(agentId)}/restart`, {
      method: "POST",
    });
    upsertSession(payload.session);
    clearFlash();
    render();
  }

  function wireSessionActions(withGuard: (task: Promise<void>) => Promise<void>): void {
    const session = currentSession();
    if (!session) {
      return;
    }
    const refresh = document.querySelector<HTMLButtonElement>("#session-refresh");
    if (refresh) {
      refresh.onclick = () => void withGuard(refreshState());
    }
    const sendGoal = document.querySelector<HTMLButtonElement>("#session-send-goal");
    if (sendGoal) {
      sendGoal.onclick = () => void withGuard(sendSessionCommand("goal"));
    }
    const sendOperator = document.querySelector<HTMLButtonElement>("#session-send-operator");
    if (sendOperator) {
      sendOperator.onclick = () => void withGuard(sendSessionCommand("operator"));
    }
    const stop = document.querySelector<HTMLButtonElement>("#session-stop");
    if (stop) {
      stop.onclick = () => void withGuard(stopCurrentSession());
    }
    const resume = document.querySelector<HTMLButtonElement>("#session-resume");
    if (resume) {
      resume.onclick = () => void withGuard(resumeCurrentSession());
    }
    document.querySelectorAll<HTMLButtonElement>("[data-stop-agent]").forEach((button) => {
      button.onclick = () => void withGuard(stopSessionAgent(button.dataset.stopAgent || ""));
    });
    document.querySelectorAll<HTMLButtonElement>("[data-restart-agent]").forEach((button) => {
      button.onclick = () => void withGuard(restartSessionAgent(button.dataset.restartAgent || ""));
    });
    document.querySelectorAll<HTMLButtonElement>("[data-select-agent]").forEach((button) => {
      button.onclick = () => {
        state.selectedAgentId = button.dataset.selectAgent || null;
        void withGuard(loadVisibleAgentHistory(false));
        render();
      };
    });
    document.querySelectorAll<HTMLButtonElement>("[data-agent-tab]").forEach((button) => {
      button.onclick = () => {
        state.selectedAgentTab = button.dataset.agentTab || "notes";
        void withGuard(loadVisibleAgentHistory(false));
        render();
      };
    });
    document.querySelectorAll<HTMLDetailsElement>("[data-subgoal-archive]").forEach((details) => {
      if (details.dataset.archiveBound === "1") {
        return;
      }
      details.dataset.archiveBound = "1";
      details.addEventListener("toggle", () => {
        const sessionId = details.dataset.sessionId || session.id;
        if (!state.sessionUi[sessionId]) {
          state.sessionUi[sessionId] = {};
        }
        state.sessionUi[sessionId].mergedTopicsOpen = details.open;
      });
    });

    const feedList = document.querySelector<HTMLElement>("[data-feed-list]");
    if (feedList && feedList.dataset.historyBound !== "1") {
      feedList.dataset.historyBound = "1";
      feedList.addEventListener("scroll", () => {
        const cache = feedCache(session.id);
        if (shouldTriggerBottomLoad(cache, feedList)) {
          saveElementScrollAnchor(feedList, "append");
          void withGuard(loadSessionFeed(session.id));
        }
      }, { passive: true });
    }

    const historyList = document.querySelector<HTMLElement>("[data-agent-history]");
    if (historyList && historyList.dataset.historyBound !== "1") {
      historyList.dataset.historyBound = "1";
      historyList.addEventListener("scroll", () => {
        const agentId = historyList.dataset.agentId || "";
        const kind = historyList.dataset.historyKind || historyKindForTab(currentAgentTab());
        if (kind === "stdout" || kind === "stderr") {
          return;
        }
        const cache = agentHistoryCache(session.id, agentId, kind);
        if (shouldTriggerBottomLoad(cache, historyList)) {
          void withGuard(loadAgentHistory(session.id, agentId, kind));
        }
      }, { passive: true });
    }
  }

  return {
    restartSessionAgent,
    resumeCurrentSession,
    sendSessionCommand,
    stopCurrentSession,
    stopSessionAgent,
    wireSessionActions,
  };
}
