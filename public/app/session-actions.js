export function distanceFromBottom(element) {
    return Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
}
export function shouldTriggerBottomLoad(cache, element, threshold = 120) {
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
export function createSessionActionTools(deps) {
    const { state, currentSession, currentAgentTab, historyKindForTab, feedCache, agentHistoryCache, saveElementScrollAnchor, loadSessionFeed, loadAgentHistory, loadVisibleAgentHistory, setFlash, clearFlash, api, qs, upsertSession, refreshState, bindSessionStream, render, } = deps;
    async function sendSessionCommand(channel) {
        const session = currentSession();
        if (!session) {
            return;
        }
        const text = qs("#session-command").value.trim();
        if (!text) {
            setFlash("error", "Enter a message before sending.");
            return;
        }
        const targetAgentId = qs("#session-target").value || null;
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
        qs("#session-command").value = "";
        clearFlash();
        render();
    }
    async function stopCurrentSession() {
        const session = currentSession();
        if (!session) {
            return;
        }
        await api(`/api/sessions/${encodeURIComponent(session.id)}/stop`, { method: "POST" });
        await refreshState();
    }
    async function resumeCurrentSession() {
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
    async function stopSessionAgent(agentId) {
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
    async function restartSessionAgent(agentId) {
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
    function wireSessionActions(withGuard) {
        const session = currentSession();
        if (!session) {
            return;
        }
        const refresh = document.querySelector("#session-refresh");
        if (refresh) {
            refresh.onclick = () => void withGuard(refreshState());
        }
        const sendGoal = document.querySelector("#session-send-goal");
        if (sendGoal) {
            sendGoal.onclick = () => void withGuard(sendSessionCommand("goal"));
        }
        const sendOperator = document.querySelector("#session-send-operator");
        if (sendOperator) {
            sendOperator.onclick = () => void withGuard(sendSessionCommand("operator"));
        }
        const stop = document.querySelector("#session-stop");
        if (stop) {
            stop.onclick = () => void withGuard(stopCurrentSession());
        }
        const resume = document.querySelector("#session-resume");
        if (resume) {
            resume.onclick = () => void withGuard(resumeCurrentSession());
        }
        document.querySelectorAll("[data-stop-agent]").forEach((button) => {
            button.onclick = () => void withGuard(stopSessionAgent(button.dataset.stopAgent || ""));
        });
        document.querySelectorAll("[data-restart-agent]").forEach((button) => {
            button.onclick = () => void withGuard(restartSessionAgent(button.dataset.restartAgent || ""));
        });
        document.querySelectorAll("[data-select-agent]").forEach((button) => {
            button.onclick = () => {
                state.selectedAgentId = button.dataset.selectAgent || null;
                void withGuard(loadVisibleAgentHistory(false));
                render();
            };
        });
        document.querySelectorAll("[data-agent-tab]").forEach((button) => {
            button.onclick = () => {
                state.selectedAgentTab = button.dataset.agentTab || "notes";
                void withGuard(loadVisibleAgentHistory(false));
                render();
            };
        });
        document.querySelectorAll("[data-subgoal-archive]").forEach((details) => {
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
        const feedList = document.querySelector("[data-feed-list]");
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
        const historyList = document.querySelector("[data-agent-history]");
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
