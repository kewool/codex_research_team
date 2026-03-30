export function createPageActionTools(deps) {
    const { state, qs, api, render, navigate, refreshState, withGuard, wireSessionActions, setFlash, clearFlash, upsertSession, ensureSelectedWorkspace, currentConfig, defaultPublishChannelForAgent, defaultListenChannelsForAgent, parseChannelListInput, remapSemanticChannel, parseLineListInput, clientSlugify, } = deps;
    async function startSessionFromDashboard() {
        const goal = qs("#launch-goal").value.trim();
        if (!goal) {
            setFlash("error", "Goal is required.");
            return;
        }
        const title = qs("#launch-title").value.trim();
        const workspaceName = qs("#launch-workspace").value;
        const payload = await api("/api/sessions", {
            method: "POST",
            body: JSON.stringify({ goal, title, workspaceName }),
        });
        upsertSession(payload.session);
        clearFlash();
        navigate(`/sessions/${encodeURIComponent(payload.session.id)}`);
    }
    async function quickCreateWorkspace() {
        const name = state.workspaceCreateModal.value.trim();
        if (!name) {
            setFlash("error", "Workspace name is required.");
            return;
        }
        const payload = await api("/api/workspaces", {
            method: "POST",
            body: JSON.stringify({ name }),
        });
        if (!state.snapshot) {
            return;
        }
        state.snapshot.config = payload.config;
        state.selectedWorkspaceName = name;
        state.workspaceCreateModal.open = false;
        state.workspaceCreateModal.value = "";
        setFlash("info", `Workspace created: ${name}`);
        render();
    }
    function gatherWorkspacePresetConfig() {
        const current = structuredClone(state.snapshot?.config || {});
        const workspaceRows = Array.from(document.querySelectorAll(".workspace-row-card"));
        current.workspaces = workspaceRows.map((row) => ({
            name: row.querySelector("[data-workspace-name]")?.value.trim(),
            path: row.querySelector("[data-workspace-path]")?.value.trim(),
        })).filter((workspace) => workspace.name && workspace.path);
        const defaultWorkspace = document.querySelector('input[name="default-workspace"]:checked')?.value?.trim();
        current.defaults.defaultWorkspaceName = defaultWorkspace || current.workspaces[0]?.name || null;
        return current;
    }
    async function saveWorkspacePresetsFromPage() {
        const payload = await api("/api/config", {
            method: "POST",
            body: JSON.stringify(gatherWorkspacePresetConfig()),
        });
        if (!state.snapshot) {
            return;
        }
        state.snapshot.config = payload.config;
        ensureSelectedWorkspace();
        setFlash("info", "Workspace presets saved.");
        render();
    }
    function gatherRuntimeTeamConfig() {
        const current = structuredClone(state.snapshot?.config || {});
        const previousDefaults = structuredClone(current.defaults || {});
        current.defaults.language = qs("#cfg-language").value.trim() || "ko";
        current.defaults.serverHost = qs("#cfg-host").value.trim() || "127.0.0.1";
        current.defaults.serverPort = Number(qs("#cfg-port").value.trim() || "4280");
        current.defaults.historyTail = Number(qs("#cfg-history-tail").value.trim() || "14");
        current.defaults.codexCommand = qs("#cfg-codex-command").value.trim();
        current.defaults.codexHomeMode = qs("#cfg-codex-home-mode").value === "global" ? "global" : "project";
        current.defaults.codexAuthMode = qs("#cfg-codex-auth-mode").value === "separate" ? "separate" : "mirror-global";
        current.defaults.codexHomeDir = qs("#cfg-codex-home-dir").value.trim();
        current.defaults.model = qs("#cfg-model").value.trim() || null;
        current.defaults.modelReasoningEffort = qs("#cfg-reasoning-effort").value.trim() || null;
        current.defaults.modelOptions = [];
        current.defaults.mcpServerNames = Array.from(document.querySelectorAll('[data-mcp-server-option]'))
            .filter((input) => input.checked)
            .map((input) => input.value.trim())
            .filter(Boolean);
        current.defaults.goalChannel = qs("#cfg-goal-channel").value.trim() || "goal";
        current.defaults.operatorChannel = qs("#cfg-operator-channel").value.trim() || "operator";
        current.defaults.extraChannels = parseChannelListInput(qs("#cfg-extra-channels").value);
        current.defaults.sandbox = qs("#cfg-sandbox").value;
        current.defaults.approvalPolicy = qs("#cfg-approval").value;
        current.defaults.search = qs("#cfg-search").checked;
        current.defaults.dangerousBypass = qs("#cfg-dangerous").checked;
        current.agents = Array.from(document.querySelectorAll(".agent-editor-card")).map((row, index) => {
            const name = row.querySelector("[data-agent-name]")?.value.trim() || `agent_${index + 1}`;
            const model = row.querySelector("[data-agent-model]")?.value.trim() || null;
            const modelReasoningEffort = row.querySelector("[data-agent-reasoning-effort]")?.value.trim() || null;
            const publishChannel = remapSemanticChannel(row.querySelector("[data-agent-channel]")?.value.trim() || defaultPublishChannelForAgent(current), previousDefaults, current.defaults) || defaultPublishChannelForAgent(current);
            const listenChannels = Array.from(row.querySelectorAll('[data-agent-listen-option]'))
                .filter((input) => input.checked)
                .map((input) => input.value.trim())
                .map((value) => remapSemanticChannel(value, previousDefaults, current.defaults))
                .filter(Boolean);
            const ownedStages = Array.from(row.querySelectorAll('[data-agent-owned-stage-option]'))
                .filter((input) => input.checked)
                .map((input) => input.value.trim())
                .filter(Boolean);
            const allowedTargetAgentIds = Array.from(row.querySelectorAll('[data-agent-target-allow-option]'))
                .filter((input) => input.checked)
                .map((input) => input.value.trim())
                .filter(Boolean);
            return {
                id: name.replace(/[^a-zA-Z0-9_]+/g, "_").toLowerCase(),
                name,
                publishChannel,
                brief: row.querySelector("[data-agent-brief]")?.value.trim() || "Explore independently and share novel findings.",
                listenChannels: listenChannels.length > 0 ? listenChannels : defaultListenChannelsForAgent(current),
                maxTurns: 0,
                model,
                modelReasoningEffort,
                policy: {
                    promptGuidance: parseLineListInput(row.querySelector("[data-agent-guidance]")?.value || ""),
                    ownedStages,
                    allowedTargetAgentIds,
                    forceBroadcastOnFirstTurn: Boolean(row.querySelector("[data-agent-force-broadcast]")?.checked),
                },
            };
        });
        return current;
    }
    async function saveRuntimeTeamSettingsFromPage() {
        const payload = await api("/api/config", {
            method: "POST",
            body: JSON.stringify(gatherRuntimeTeamConfig()),
        });
        if (!state.snapshot) {
            return;
        }
        state.snapshot.config = payload.config;
        if (payload.codexAuthStatus) {
            state.snapshot.codexAuthStatus = payload.codexAuthStatus;
        }
        if (payload.codexUsageStatus) {
            state.snapshot.codexUsageStatus = payload.codexUsageStatus;
        }
        ensureSelectedWorkspace();
        setFlash("info", "Runtime and team settings saved.");
        render();
    }
    async function openCodexLoginWindow() {
        const payload = await api("/api/codex-auth/login", {
            method: "POST",
            body: JSON.stringify({}),
        });
        if (state.snapshot && payload.codexAuthStatus) {
            state.snapshot.codexAuthStatus = payload.codexAuthStatus;
        }
        if (state.snapshot && payload.codexUsageStatus) {
            state.snapshot.codexUsageStatus = payload.codexUsageStatus;
        }
        clearFlash();
        render();
    }
    async function logoutCodexHome() {
        const payload = await api("/api/codex-auth/logout", {
            method: "POST",
            body: JSON.stringify({}),
        });
        if (state.snapshot && payload.codexAuthStatus) {
            state.snapshot.codexAuthStatus = payload.codexAuthStatus;
        }
        if (state.snapshot && payload.codexUsageStatus) {
            state.snapshot.codexUsageStatus = payload.codexUsageStatus;
        }
        setFlash("info", "Codex login removed from the active home.");
        render();
    }
    function wireDashboardActions() {
        const launch = document.querySelector("#launch-session");
        if (launch) {
            launch.onclick = () => void withGuard(startSessionFromDashboard());
        }
    }
    function wireWorkspaceActions() {
        document.querySelectorAll("[data-select-workspace]").forEach((button) => {
            button.onclick = () => {
                state.selectedWorkspaceName = button.dataset.selectWorkspace || null;
                render();
            };
        });
        const addWorkspace = document.querySelector("#add-workspace-row");
        if (addWorkspace) {
            addWorkspace.onclick = () => {
                if (!state.snapshot) {
                    return;
                }
                const config = currentConfig();
                const nextIndex = (config.workspaces || []).length + 1;
                const name = `workspace_${nextIndex}`;
                const base = String(config.defaults.workspacesDir || "").replace(/[\\/]+$/, "");
                const path = `${base}\\${clientSlugify(name)}`;
                config.workspaces.push({ name, path });
                state.selectedWorkspaceName = name;
                render();
            };
        }
        const quickCreate = document.querySelector("#quick-create-workspace");
        if (quickCreate) {
            quickCreate.onclick = () => {
                state.workspaceCreateModal.open = true;
                state.workspaceCreateModal.value = "";
                render();
            };
        }
        const saveWorkspaces = document.querySelector("#save-workspaces");
        if (saveWorkspaces) {
            saveWorkspaces.onclick = () => void withGuard(saveWorkspacePresetsFromPage());
        }
        document.querySelectorAll("[data-remove-workspace]").forEach((button) => {
            button.onclick = () => {
                if (!state.snapshot) {
                    return;
                }
                const index = Number(button.dataset.removeWorkspace || "-1");
                const config = currentConfig();
                const removed = config.workspaces.splice(index, 1)[0];
                if (removed && state.selectedWorkspaceName === removed.name) {
                    state.selectedWorkspaceName = config.workspaces[0]?.name || null;
                }
                render();
            };
        });
        const closeWorkspaceModal = () => {
            state.workspaceCreateModal.open = false;
            state.workspaceCreateModal.value = "";
            render();
        };
        const workspaceModalBackdrop = document.querySelector("[data-close-workspace-modal]");
        if (workspaceModalBackdrop) {
            workspaceModalBackdrop.onclick = () => closeWorkspaceModal();
        }
        const workspaceModalCard = document.querySelector("[data-workspace-modal-card]");
        if (workspaceModalCard) {
            workspaceModalCard.onclick = (event) => event.stopPropagation();
        }
        const workspaceCreateCancel = document.querySelector("#workspace-create-cancel");
        if (workspaceCreateCancel) {
            workspaceCreateCancel.onclick = () => closeWorkspaceModal();
        }
        const workspaceCreateName = document.querySelector("#workspace-create-name");
        if (workspaceCreateName) {
            requestAnimationFrame(() => {
                workspaceCreateName.focus();
                workspaceCreateName.select();
            });
            workspaceCreateName.oninput = () => {
                state.workspaceCreateModal.value = workspaceCreateName.value;
            };
            workspaceCreateName.onkeydown = (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    void withGuard(quickCreateWorkspace());
                }
                if (event.key === "Escape") {
                    event.preventDefault();
                    closeWorkspaceModal();
                }
            };
        }
        const workspaceCreateConfirm = document.querySelector("#workspace-create-confirm");
        if (workspaceCreateConfirm) {
            workspaceCreateConfirm.onclick = () => void withGuard(quickCreateWorkspace());
        }
    }
    function wireSettingsActions() {
        const addAgent = document.querySelector("#add-agent-row");
        if (addAgent) {
            addAgent.onclick = () => {
                if (!state.snapshot) {
                    return;
                }
                const config = currentConfig();
                const agents = config.agents || [];
                const nextIndex = agents.length + 1;
                agents.push({
                    id: `agent_${nextIndex}`,
                    name: `agent_${nextIndex}`,
                    brief: "Operate according to your brief and the selected channels.",
                    publishChannel: defaultPublishChannelForAgent(config),
                    listenChannels: defaultListenChannelsForAgent(config),
                    maxTurns: 0,
                    model: null,
                    modelReasoningEffort: null,
                    policy: {
                        promptGuidance: [],
                        ownedStages: [],
                        allowedTargetAgentIds: [],
                        forceBroadcastOnFirstTurn: false,
                    },
                });
                render();
            };
        }
        const saveRuntimeTeam = document.querySelector("#save-runtime-team");
        if (saveRuntimeTeam) {
            saveRuntimeTeam.onclick = () => void withGuard(saveRuntimeTeamSettingsFromPage());
        }
        const refreshModels = document.querySelector("#refresh-models");
        if (refreshModels) {
            refreshModels.onclick = () => void withGuard(refreshState());
        }
        const refreshAuthStatus = document.querySelector("#refresh-auth-status");
        if (refreshAuthStatus) {
            refreshAuthStatus.onclick = () => void withGuard(refreshState());
        }
        const openCodexLogin = document.querySelector("#open-codex-login");
        if (openCodexLogin) {
            openCodexLogin.onclick = () => void withGuard(openCodexLoginWindow());
        }
        const codexLogout = document.querySelector("#codex-logout");
        if (codexLogout) {
            codexLogout.onclick = () => void withGuard(logoutCodexHome());
        }
        document.querySelectorAll("[data-remove-agent]").forEach((button) => {
            button.onclick = () => {
                if (!state.snapshot) {
                    return;
                }
                const index = Number(button.dataset.removeAgent || "-1");
                currentConfig().agents.splice(index, 1);
                render();
            };
        });
    }
    function wirePageActions() {
        if (state.route.name === "dashboard") {
            wireDashboardActions();
            return;
        }
        if (state.route.name === "workspaces") {
            wireWorkspaceActions();
            return;
        }
        if (state.route.name === "settings") {
            wireSettingsActions();
            return;
        }
        wireSessionActions(withGuard);
    }
    return {
        wirePageActions,
    };
}
