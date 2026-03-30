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
        const payload = await api(`/api/sessions/${encodeURIComponent(session.id)}/instructions`, {
            method: "POST",
            body: JSON.stringify({ channel, text, targetAgentId }),
        });
        upsertSession(payload.session);
        bindSessionStream();
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
        const feedList = document.querySelector("[data-feed-list]");
        if (feedList && feedList.dataset.historyBound !== "1") {
            feedList.dataset.historyBound = "1";
            feedList.addEventListener("scroll", () => {
                const cache = feedCache(session.id);
                if (cache.loading || !cache.hasMore) {
                    return;
                }
                if (feedList.scrollTop + feedList.clientHeight >= feedList.scrollHeight - 120) {
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
                if (cache.loading || !cache.hasMore) {
                    return;
                }
                if (historyList.scrollTop + historyList.clientHeight >= historyList.scrollHeight - 120) {
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
