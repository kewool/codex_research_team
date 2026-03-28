type AnyObject = Record<string, any>;

export function createPageActionTools(deps: {
  state: any;
  qs: <T extends HTMLElement>(selector: string) => T;
  api: (path: string, init?: RequestInit) => Promise<any>;
  render: () => void;
  navigate: (path: string, replace?: boolean) => void;
  refreshState: () => Promise<void>;
  withGuard: (task: Promise<void>) => Promise<void>;
  wireSessionActions: (withGuard: (task: Promise<void>) => Promise<void>) => void;
  setFlash: (kind: "error" | "info", text: string) => void;
  clearFlash: () => void;
  upsertSession: (session: AnyObject) => void;
  ensureSelectedWorkspace: () => string | null;
  currentConfig: () => AnyObject;
  defaultPublishChannelForAgent: (config: AnyObject) => string;
  defaultListenChannelsForAgent: (config: AnyObject) => string[];
  parseChannelListInput: (value: string) => string[];
  remapSemanticChannel: (channel: string, previousDefaults: AnyObject, nextDefaults: AnyObject) => string;
  parseLineListInput: (value: string) => string[];
  clientSlugify: (value: string) => string;
}) {
  const {
    state,
    qs,
    api,
    render,
    navigate,
    refreshState,
    withGuard,
    wireSessionActions,
    setFlash,
    clearFlash,
    upsertSession,
    ensureSelectedWorkspace,
    currentConfig,
    defaultPublishChannelForAgent,
    defaultListenChannelsForAgent,
    parseChannelListInput,
    remapSemanticChannel,
    parseLineListInput,
    clientSlugify,
  } = deps;

  async function startSessionFromDashboard(): Promise<void> {
    const goal = qs<HTMLTextAreaElement>("#launch-goal").value.trim();
    if (!goal) {
      setFlash("error", "Goal is required.");
      return;
    }
    const title = qs<HTMLInputElement>("#launch-title").value.trim();
    const workspaceName = qs<HTMLSelectElement>("#launch-workspace").value;
    const payload = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ goal, title, workspaceName }),
    });
    upsertSession(payload.session);
    clearFlash();
    navigate(`/sessions/${encodeURIComponent(payload.session.id)}`);
  }

  async function quickCreateWorkspace(): Promise<void> {
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

  function gatherWorkspacePresetConfig(): AnyObject {
    const current = structuredClone(state.snapshot?.config || {});
    const workspaceRows = Array.from(document.querySelectorAll<HTMLElement>(".workspace-row-card"));
    current.workspaces = workspaceRows.map((row) => ({
      name: (row.querySelector("[data-workspace-name]") as HTMLInputElement)?.value.trim(),
      path: (row.querySelector("[data-workspace-path]") as HTMLInputElement)?.value.trim(),
    })).filter((workspace) => workspace.name && workspace.path);

    const defaultWorkspace = document.querySelector<HTMLInputElement>('input[name="default-workspace"]:checked')?.value?.trim();
    current.defaults.defaultWorkspaceName = defaultWorkspace || current.workspaces[0]?.name || null;
    return current;
  }

  async function saveWorkspacePresetsFromPage(): Promise<void> {
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

  function gatherRuntimeTeamConfig(): AnyObject {
    const current = structuredClone(state.snapshot?.config || {});
    const previousDefaults = structuredClone(current.defaults || {});
    current.defaults.language = qs<HTMLInputElement>("#cfg-language").value.trim() || "ko";
    current.defaults.serverHost = qs<HTMLInputElement>("#cfg-host").value.trim() || "127.0.0.1";
    current.defaults.serverPort = Number(qs<HTMLInputElement>("#cfg-port").value.trim() || "4280");
    current.defaults.historyTail = Number(qs<HTMLInputElement>("#cfg-history-tail").value.trim() || "14");
    current.defaults.codexCommand = qs<HTMLInputElement>("#cfg-codex-command").value.trim();
    current.defaults.codexHomeMode = qs<HTMLSelectElement>("#cfg-codex-home-mode").value === "global" ? "global" : "project";
    current.defaults.codexAuthMode = qs<HTMLSelectElement>("#cfg-codex-auth-mode").value === "separate" ? "separate" : "mirror-global";
    current.defaults.codexHomeDir = qs<HTMLInputElement>("#cfg-codex-home-dir").value.trim();
    current.defaults.model = qs<HTMLSelectElement>("#cfg-model").value.trim() || null;
    current.defaults.modelReasoningEffort = qs<HTMLSelectElement>("#cfg-reasoning-effort").value.trim() || null;
    current.defaults.modelOptions = [];
    current.defaults.mcpServerNames = Array.from(document.querySelectorAll<HTMLInputElement>('[data-mcp-server-option]'))
      .filter((input) => input.checked)
      .map((input) => input.value.trim())
      .filter(Boolean);
    current.defaults.goalChannel = qs<HTMLInputElement>("#cfg-goal-channel").value.trim() || "goal";
    current.defaults.operatorChannel = qs<HTMLInputElement>("#cfg-operator-channel").value.trim() || "operator";
    current.defaults.extraChannels = parseChannelListInput(qs<HTMLTextAreaElement>("#cfg-extra-channels").value);
    current.defaults.sandbox = qs<HTMLSelectElement>("#cfg-sandbox").value;
    current.defaults.approvalPolicy = qs<HTMLSelectElement>("#cfg-approval").value;
    current.defaults.search = qs<HTMLInputElement>("#cfg-search").checked;
    current.defaults.dangerousBypass = qs<HTMLInputElement>("#cfg-dangerous").checked;
    current.agents = Array.from(document.querySelectorAll<HTMLElement>(".agent-editor-card")).map((row, index) => {
      const name = (row.querySelector("[data-agent-name]") as HTMLInputElement)?.value.trim() || `agent_${index + 1}`;
      const model = (row.querySelector("[data-agent-model]") as HTMLSelectElement)?.value.trim() || null;
      const publishChannel = remapSemanticChannel(
        (row.querySelector("[data-agent-channel]") as HTMLSelectElement)?.value.trim() || defaultPublishChannelForAgent(current),
        previousDefaults,
        current.defaults,
      ) || defaultPublishChannelForAgent(current);
      const listenChannels = Array.from(row.querySelectorAll<HTMLInputElement>('[data-agent-listen-option]'))
        .filter((input) => input.checked)
        .map((input) => input.value.trim())
        .map((value) => remapSemanticChannel(value, previousDefaults, current.defaults))
        .filter(Boolean);
      const ownedStages = Array.from(row.querySelectorAll<HTMLInputElement>('[data-agent-owned-stage-option]'))
        .filter((input) => input.checked)
        .map((input) => input.value.trim())
        .filter(Boolean);
      const allowedTargetAgentIds = Array.from(row.querySelectorAll<HTMLInputElement>('[data-agent-target-allow-option]'))
        .filter((input) => input.checked)
        .map((input) => input.value.trim())
        .filter(Boolean);
      return {
        id: name.replace(/[^a-zA-Z0-9_]+/g, "_").toLowerCase(),
        name,
        publishChannel,
        brief: (row.querySelector("[data-agent-brief]") as HTMLTextAreaElement)?.value.trim() || "Explore independently and share novel findings.",
        listenChannels: listenChannels.length > 0 ? listenChannels : defaultListenChannelsForAgent(current),
        maxTurns: 0,
        model,
        policy: {
          promptGuidance: parseLineListInput((row.querySelector("[data-agent-guidance]") as HTMLTextAreaElement)?.value || ""),
          ownedStages,
          allowedTargetAgentIds,
          forceBroadcastOnFirstTurn: Boolean((row.querySelector("[data-agent-force-broadcast]") as HTMLInputElement)?.checked),
        },
      };
    });
    return current;
  }

  async function saveRuntimeTeamSettingsFromPage(): Promise<void> {
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
    ensureSelectedWorkspace();
    setFlash("info", "Runtime and team settings saved.");
    render();
  }

  async function openCodexLoginWindow(): Promise<void> {
    const payload = await api("/api/codex-auth/login", {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (state.snapshot && payload.codexAuthStatus) {
      state.snapshot.codexAuthStatus = payload.codexAuthStatus;
    }
    clearFlash();
    render();
  }

  async function logoutCodexHome(): Promise<void> {
    const payload = await api("/api/codex-auth/logout", {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (state.snapshot && payload.codexAuthStatus) {
      state.snapshot.codexAuthStatus = payload.codexAuthStatus;
    }
    setFlash("info", "Codex login removed from the active home.");
    render();
  }

  function wireDashboardActions(): void {
    const launch = document.querySelector<HTMLButtonElement>("#launch-session");
    if (launch) {
      launch.onclick = () => void withGuard(startSessionFromDashboard());
    }
  }

  function wireWorkspaceActions(): void {
    document.querySelectorAll<HTMLButtonElement>("[data-select-workspace]").forEach((button) => {
      button.onclick = () => {
        state.selectedWorkspaceName = button.dataset.selectWorkspace || null;
        render();
      };
    });

    const addWorkspace = document.querySelector<HTMLButtonElement>("#add-workspace-row");
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

    const quickCreate = document.querySelector<HTMLButtonElement>("#quick-create-workspace");
    if (quickCreate) {
      quickCreate.onclick = () => {
        state.workspaceCreateModal.open = true;
        state.workspaceCreateModal.value = "";
        render();
      };
    }

    const saveWorkspaces = document.querySelector<HTMLButtonElement>("#save-workspaces");
    if (saveWorkspaces) {
      saveWorkspaces.onclick = () => void withGuard(saveWorkspacePresetsFromPage());
    }

    document.querySelectorAll<HTMLButtonElement>("[data-remove-workspace]").forEach((button) => {
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

    const closeWorkspaceModal = (): void => {
      state.workspaceCreateModal.open = false;
      state.workspaceCreateModal.value = "";
      render();
    };

    const workspaceModalBackdrop = document.querySelector<HTMLElement>("[data-close-workspace-modal]");
    if (workspaceModalBackdrop) {
      workspaceModalBackdrop.onclick = () => closeWorkspaceModal();
    }
    const workspaceModalCard = document.querySelector<HTMLElement>("[data-workspace-modal-card]");
    if (workspaceModalCard) {
      workspaceModalCard.onclick = (event) => event.stopPropagation();
    }

    const workspaceCreateCancel = document.querySelector<HTMLButtonElement>("#workspace-create-cancel");
    if (workspaceCreateCancel) {
      workspaceCreateCancel.onclick = () => closeWorkspaceModal();
    }

    const workspaceCreateName = document.querySelector<HTMLInputElement>("#workspace-create-name");
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

    const workspaceCreateConfirm = document.querySelector<HTMLButtonElement>("#workspace-create-confirm");
    if (workspaceCreateConfirm) {
      workspaceCreateConfirm.onclick = () => void withGuard(quickCreateWorkspace());
    }
  }

  function wireSettingsActions(): void {
    const addAgent = document.querySelector<HTMLButtonElement>("#add-agent-row");
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

    const saveRuntimeTeam = document.querySelector<HTMLButtonElement>("#save-runtime-team");
    if (saveRuntimeTeam) {
      saveRuntimeTeam.onclick = () => void withGuard(saveRuntimeTeamSettingsFromPage());
    }

    const refreshModels = document.querySelector<HTMLButtonElement>("#refresh-models");
    if (refreshModels) {
      refreshModels.onclick = () => void withGuard(refreshState());
    }

    const refreshAuthStatus = document.querySelector<HTMLButtonElement>("#refresh-auth-status");
    if (refreshAuthStatus) {
      refreshAuthStatus.onclick = () => void withGuard(refreshState());
    }

    const openCodexLogin = document.querySelector<HTMLButtonElement>("#open-codex-login");
    if (openCodexLogin) {
      openCodexLogin.onclick = () => void withGuard(openCodexLoginWindow());
    }

    const codexLogout = document.querySelector<HTMLButtonElement>("#codex-logout");
    if (codexLogout) {
      codexLogout.onclick = () => void withGuard(logoutCodexHome());
    }

    document.querySelectorAll<HTMLButtonElement>("[data-remove-agent]").forEach((button) => {
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

  function wirePageActions(): void {
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
