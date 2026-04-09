type AnyObject = Record<string, any>;

export function createPageRenderers(deps: {
  state: any;
  escapeHtml: (value: unknown) => string;
  formatLimitReset: (value: unknown) => string;
  formatPercent: (value: unknown) => string;
  formatRemainingPercent: (usedPercent: unknown) => string;
  currentConfig: () => AnyObject;
  currentCodexAuthStatus: () => AnyObject | null;
  currentCodexUsageStatus: () => AnyObject | null;
  activeSessions: () => AnyObject[];
  modelOptions: (config: AnyObject) => string[];
  reasoningEffortOptions: (config: AnyObject) => string[];
  mcpOptions: () => string[];
  modelCatalogSummary: () => string;
  mcpCatalogSummary: () => string;
  selectedWorkspace: () => AnyObject | null;
  renderLabel: (text: string, help?: string) => string;
  renderHint: (text: string) => string;
  renderChannelSelect: (attributes: string, channels: string[], selected: string, emptyLabel?: string) => string;
  renderChannelCheckboxPicker: (attributeName: string, index: number, channels: string[], selectedValues: string[]) => string;
  renderAgentCheckboxPicker: (attributeName: string, index: number, options: string[], selectedValues: string[]) => string;
  renderOptionCheckboxPicker: (attributeName: string, options: string[], selectedValues: string[]) => string;
  renderStageCheckboxPicker: (attributeName: string, index: number, selectedValues: string[]) => string;
  renderModelSelect: (attributes: string, options: string[], selected: string | null, emptyLabel: string) => string;
  renderReasoningEffortSelect: (attributes: string, options: string[], selected: string | null, emptyLabel: string) => string;
  configuredChannelList: (config: AnyObject) => string[];
  visibleDashboardSessions: () => AnyObject[];
  dashboardSessionsMeta: () => { shownCount: number; totalCount: number; hasMore: boolean };
}) {
  const {
    state,
    escapeHtml,
    formatLimitReset,
    formatPercent,
    formatRemainingPercent,
    currentConfig,
    currentCodexAuthStatus,
    currentCodexUsageStatus,
    activeSessions,
    modelOptions,
    reasoningEffortOptions,
    mcpOptions,
    modelCatalogSummary,
    mcpCatalogSummary,
    selectedWorkspace,
    renderLabel,
    renderHint,
    renderChannelSelect,
    renderChannelCheckboxPicker,
    renderAgentCheckboxPicker,
    renderOptionCheckboxPicker,
    renderStageCheckboxPicker,
    renderModelSelect,
    renderReasoningEffortSelect,
    configuredChannelList,
    visibleDashboardSessions,
    dashboardSessionsMeta,
  } = deps;

  function renderUsageMetricCard(label: string, window: AnyObject | null | undefined, status: AnyObject | null): string {
    const available = Boolean(status?.available && window);
    const value = available ? formatRemainingPercent(window?.usedPercent) : "--";
    const note = available
      ? `${formatPercent(window?.usedPercent)} used - ${formatLimitReset(window?.resetsAt)}`
      : status?.staleReason === "auth_changed"
        ? "Awaiting quota data for the current login"
        : "No recent quota data";
    return `
      <article class="metric-card panel">
        <span class="metric-label">${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        <small class="metric-note">${escapeHtml(note)}</small>
      </article>
    `;
  }

  function renderDashboardSessionCard(session: AnyObject): string {
    const waiting = (session.agents || []).filter((agent: AnyObject) => agent.waitingForInput).length;
    const errors = (session.agents || []).filter((agent: AnyObject) => agent.status === "error").length;
    const liveLabel = session.isLive ? "live" : "saved";
    return `
      <article class="panel session-card">
        <div class="section-head tight">
          <div>
            <h4>${escapeHtml(session.title)}</h4>
            <p class="muted">${escapeHtml(session.goal)}</p>
          </div>
          <span class="status-pill ${escapeHtml(session.status)}">${escapeHtml(session.status)}</span>
        </div>
        <div class="session-card-grid">
          <span><strong>State</strong>${escapeHtml(liveLabel)}</span>
          <span><strong>Workspace</strong>${escapeHtml(session.workspaceName)}</span>
          <span><strong>Updated</strong>${escapeHtml(session.updatedAt)}</span>
          <span><strong>Waiting</strong>${escapeHtml(String(waiting))}</span>
          <span><strong>Errors</strong>${escapeHtml(String(errors))}</span>
        </div>
        <div class="inline-actions">
          <button data-nav="/sessions/${encodeURIComponent(session.id)}" class="primary">Open Session</button>
        </div>
      </article>
    `;
  }

  function renderDashboardPage(): string {
    const config = state.snapshot?.config;
    const sessions = (state.snapshot?.sessions as AnyObject[]) || [];
    const visibleSessions = visibleDashboardSessions();
    const visibleMeta = dashboardSessionsMeta();
    const usageStatus = currentCodexUsageStatus();
    const workspaceOptions = (config?.workspaces || [])
      .map((workspace: AnyObject) => `<option value="${escapeHtml(workspace.name)}" ${config.defaults.defaultWorkspaceName === workspace.name ? "selected" : ""}>${escapeHtml(workspace.name)}</option>`)
      .join("");
    const active = activeSessions();
    return `
      <section class="panel launch-panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Start</p>
            <h3>New Session</h3>
          </div>
          <div class="hero-meta">
            <span>${escapeHtml(String(active.length))} active</span>
            <span>${escapeHtml(String(sessions.length))} saved</span>
          </div>
        </div>
        <div class="launch-form">
          <label>
            ${renderLabel("Goal", "Top-level objective for the session. This is broadcast into the room when the session starts.")}
            <textarea id="launch-goal" placeholder="Example: inspect the workspace, identify the main problems, and propose an implementation plan"></textarea>
          </label>
          <div class="launch-grid">
            <label>
              ${renderLabel("Title", "Optional display name for the room. If empty, the goal will be used.")}
              <input id="launch-title" placeholder="Optional" />
            </label>
            <label>
              ${renderLabel("Workspace", "Workspace preset used as the working directory for all agents in this session.")}
              <select id="launch-workspace">${workspaceOptions}</select>
            </label>
          </div>
          <div class="launch-actions">
            <button id="launch-session" class="primary">Start Session</button>
            <div class="inline-actions launch-secondary-actions">
              <button data-nav="/workspaces" class="ghost">Manage Workspaces</button>
              <button data-nav="/settings" class="ghost">Manage Settings</button>
            </div>
          </div>
        </div>
      </section>
      <section class="summary-row">
        <article class="metric-card panel"><span class="metric-label">Active Sessions</span><strong>${escapeHtml(String(active.length))}</strong></article>
        <article class="metric-card panel"><span class="metric-label">Saved Sessions</span><strong>${escapeHtml(String(sessions.length))}</strong></article>
        <article class="metric-card panel"><span class="metric-label">Workspaces</span><strong>${escapeHtml(String((config?.workspaces || []).length))}</strong></article>
        <article class="metric-card panel"><span class="metric-label">Agents</span><strong>${escapeHtml(String((config?.agents || []).length))}</strong></article>
        ${renderUsageMetricCard("5h Remaining", usageStatus?.primary, usageStatus)}
        ${renderUsageMetricCard("Weekly Remaining", usageStatus?.secondary, usageStatus)}
      </section>
      <section class="panel page-section">
        <div class="section-head">
          <h3>Sessions</h3>
        </div>
        <div class="dashboard-session-scroll" data-session-list-kind="dashboard">
          <div class="session-grid">
            ${sessions.length === 0 ? `<p class="muted">No sessions yet.</p>` : visibleSessions.map(renderDashboardSessionCard).join("")}
          </div>
          ${sessions.length === 0 ? "" : `
            <div class="history-footer recent-sessions-footer">
              ${escapeHtml(
                visibleMeta.hasMore
                  ? `Showing ${visibleMeta.shownCount} of ${visibleMeta.totalCount} sessions. Scroll to load more.`
                  : `Showing all ${visibleMeta.totalCount} sessions.`
              )}
            </div>
          `}
        </div>
      </section>
    `;
  }

  function renderWorkspaceCreateModal(): string {
    if (!state.workspaceCreateModal.open) {
      return "";
    }
    return `
      <div class="modal-backdrop" data-close-workspace-modal="1">
        <section class="modal-card" data-workspace-modal-card="1" role="dialog" aria-modal="true" aria-labelledby="workspace-create-title">
          <div class="section-head tight">
            <div>
              <p class="eyebrow">Create</p>
              <h3 id="workspace-create-title">New Workspace</h3>
            </div>
          </div>
          <label>
            ${renderLabel("Workspace Name", "A preset will be created immediately under the configured workspaces directory.")}
            <input id="workspace-create-name" value="${escapeHtml(state.workspaceCreateModal.value)}" placeholder="Workspace name" />
          </label>
          <div class="inline-actions modal-actions">
            <button id="workspace-create-cancel" class="ghost">Cancel</button>
            <button id="workspace-create-confirm" class="primary">Create Workspace</button>
          </div>
        </section>
      </div>
    `;
  }

  function renderWorkspacesPage(): string {
    const config = currentConfig();
    const current = selectedWorkspace();
    const workspaceCount = (config.workspaces || []).length;
    const defaultWorkspace = config.defaults.defaultWorkspaceName || "No default workspace";
    const workspaceList = (config.workspaces || []).map((workspace: AnyObject) => {
      const isSelected = current?.name === workspace.name;
      const isDefault = config.defaults.defaultWorkspaceName === workspace.name;
      return `
        <button class="workspace-list-item ${isSelected ? "active" : ""}" data-select-workspace="${escapeHtml(workspace.name)}">
          <strong>${escapeHtml(workspace.name)}</strong>
          <span>${escapeHtml(workspace.path)}</span>
          <small>${isDefault ? "default workspace" : "workspace preset"}</small>
        </button>
      `;
    }).join("");

    const workspaceEditors = (config.workspaces || []).map((workspace: AnyObject, index: number) => {
      const visible = current?.name === workspace.name;
      return `
        <article class="workspace-row-card workspace-detail-card ${visible ? "visible" : "hidden"}">
          <div class="workspace-row-head">
            <label class="radio-line">
              <input type="radio" name="default-workspace" value="${escapeHtml(workspace.name)}" ${config.defaults.defaultWorkspaceName === workspace.name ? "checked" : ""} />
              <span>Default workspace ${renderHint("This workspace is selected by default when you launch a new session without manually picking another preset.")}</span>
            </label>
            <button class="ghost tiny" data-remove-workspace="${index}">Delete</button>
          </div>
          <label>
            ${renderLabel("Name", "Preset name shown in the workspace list and session launch form.")}
            <input data-workspace-name="${index}" value="${escapeHtml(workspace.name)}" placeholder="Workspace name" />
          </label>
          <label>
            ${renderLabel("Path", "Absolute or relative filesystem path used as the shared working directory for the session.")}
            <input data-workspace-path="${index}" value="${escapeHtml(workspace.path)}" placeholder="Workspace path" />
          </label>
        </article>
      `;
    }).join("");

    return `
      <section class="panel utility-hero">
        <div class="utility-hero-copy">
          <p class="eyebrow">Workspace Library</p>
          <h3>Workspace Presets</h3>
        </div>
        <div class="hero-meta">
          <span>${escapeHtml(String(workspaceCount))} presets</span>
          <span>${escapeHtml(defaultWorkspace)}</span>
        </div>
      </section>
      <section class="page-section settings-workspace-layout">
        <section class="panel workspace-list-panel">
          <div class="section-head">
            <div>
              <p class="eyebrow">Library</p>
              <h3>Saved Workspaces</h3>
            </div>
            <div class="inline-actions">
              <button id="quick-create-workspace" class="ghost">Create Now</button>
              <button id="add-workspace-row" class="primary">Add Preset</button>
            </div>
          </div>
          <div class="workspace-list-stack">
            ${workspaceList || `<p class="muted">No workspaces yet.</p>`}
          </div>
        </section>
        <section class="panel workspace-detail-panel">
          <div class="section-head">
            <div>
              <p class="eyebrow">Editor</p>
              <h3>${escapeHtml(current?.name || "No workspace selected")}</h3>
            </div>
            <div class="inline-actions">
              ${current ? `<span class="status-pill idle">${escapeHtml(config.defaults.defaultWorkspaceName === current.name ? "default" : "saved")}</span>` : ""}
              <button id="save-workspaces" class="primary">Save Workspaces</button>
              <button data-nav="/settings" class="ghost">Open Settings</button>
            </div>
          </div>
          <div id="workspace-editor-list" class="workspace-editor-list workspace-detail-stack">
            ${workspaceEditors || `<p class="muted">Add a workspace first.</p>`}
          </div>
        </section>
      </section>
      ${renderWorkspaceCreateModal()}
    `;
  }

  function renderSettingsPage(): string {
    const config = currentConfig();
    const authStatus = currentCodexAuthStatus();
    const options = modelOptions(config);
    const reasoningOptions = reasoningEffortOptions(config);
    const mcpServers = mcpOptions();
    const channels = configuredChannelList(config);
    const internalChannels = ["status", "system", "control"];
    const agentCount = (config.agents || []).length;
    const channelCount = channels.length;
    const agentIds = (config.agents || []).map((agent: AnyObject) => String(agent.id || "").trim()).filter(Boolean);
    const authControlsLocked = Boolean(authStatus?.controlsLocked);
    const authStatusText = authStatus?.summary || "Codex login status has not been checked yet.";
    const authStatusRaw = authStatus?.rawOutput || "No additional login output.";
    const authEmail = String(authStatus?.email || "").trim();
    const authStatusPill = authStatus?.loggedIn ? "logged in" : "not logged in";
    const authActionLabel = authStatus?.loggedIn ? "Switch Login" : "Open Login";
    const agentRows = (config.agents || []).map((agent: AnyObject, index: number) => `
      <article class="agent-editor-card">
        <div class="workspace-row-head">
          <strong>${escapeHtml(agent.name)}</strong>
          <button class="ghost tiny" data-remove-agent="${index}">Delete</button>
        </div>
        <div class="two-col-grid">
          <label>
            ${renderLabel("Name", "Stable identifier shown in the session UI and used for targeted routing.")}
            <input data-agent-name="${index}" value="${escapeHtml(agent.name)}" placeholder="Agent name" />
          </label>
          <label>
            ${renderLabel("Publish Channel", "Default channel this agent writes to when it broadcasts or sends untargeted team updates.")}
            ${renderChannelSelect(`data-agent-channel="${index}"`, channels, String(agent.publishChannel || ""), "Select publish channel")}
          </label>
        </div>
        <div class="two-col-grid">
          <label>
            ${renderLabel("Listen Channels", "Channels that can wake this agent or appear in its pending work.")}
            ${renderChannelCheckboxPicker("data-agent-listen-option", index, channels, Array.isArray(agent.listenChannels) ? agent.listenChannels : [])}
          </label>
          <label>
            ${renderLabel("Owned Goal Stages", "Subgoal stages this agent is expected to advance. The goal board, not message counts, is the main trigger for work.")}
            ${renderStageCheckboxPicker("data-agent-owned-stage-option", index, Array.isArray(agent.policy?.ownedStages) ? agent.policy.ownedStages : [])}
          </label>
        </div>
        <div class="two-col-grid">
          <label>
            ${renderLabel("Allowed Target Agents", "Server-side allowlist for direct targets. Any disallowed target is stripped before publish.")}
            ${renderAgentCheckboxPicker("data-agent-target-allow-option", index, agentIds.filter((value: string) => value !== String(agent.id || "").trim()), Array.isArray(agent.policy?.allowedTargetAgentIds) ? agent.policy.allowedTargetAgentIds : [])}
          </label>
          <label>
            ${renderLabel("Model", "Optional per-agent model override. Leave empty to use the runtime default.")}
            ${renderModelSelect(`data-agent-model="${index}"`, options, agent.model, "Use default model")}
          </label>
        </div>
        <div class="two-col-grid">
          <label>
            ${renderLabel("Reasoning Effort", "Optional per-agent reasoning effort override. Leave empty to use the runtime default.")}
            ${renderReasoningEffortSelect(`data-agent-reasoning-effort="${index}"`, reasoningOptions, agent.modelReasoningEffort, "Use default reasoning effort")}
          </label>
          <div></div>
        </div>
        <label class="check-line">
          <input data-agent-force-broadcast="${index}" type="checkbox" ${agent.policy?.forceBroadcastOnFirstTurn ? "checked" : ""} />
          <span>Force broadcast on first turn ${renderHint("Prevents the first team message from being narrowly targeted. Useful when you want the room to see the first take before routing gets more selective.")}</span>
        </label>
        <label>
          ${renderLabel("Brief", "Short role description injected into the prompt for this agent.")}
          <textarea data-agent-brief="${index}" placeholder="Agent brief">${escapeHtml(agent.brief)}</textarea>
        </label>
        <label>
          ${renderLabel("Prompt Guidance", "One instruction per line. These lines are appended to the agent prompt on every turn.")}
          <textarea data-agent-guidance="${index}" placeholder="one instruction per line">${escapeHtml((Array.isArray(agent.policy?.promptGuidance) ? agent.policy.promptGuidance : []).join("\n"))}</textarea>
        </label>
      </article>
    `).join("");

    return `
      <section class="panel utility-hero">
        <div class="utility-hero-copy">
          <p class="eyebrow">System Design</p>
          <h3>Runtime and Team</h3>
        </div>
        <div class="hero-meta">
          <span>${escapeHtml(String(agentCount))} agents</span>
          <span>${escapeHtml(String(channelCount))} named channels</span>
        </div>
      </section>
      <section class="page-section split-layout">
        <section class="panel">
          <div class="section-head">
            <div>
              <p class="eyebrow">Runtime</p>
              <h3>Codex Runtime</h3>
            </div>
            <button id="save-runtime-team" class="primary">Save Runtime & Team</button>
          </div>
          <div class="settings-form-grid">
            <label>${renderLabel("Language", "Language instruction used in the shared session prompt.")}<input id="cfg-language" value="${escapeHtml(config.defaults.language)}" /></label>
            <label>${renderLabel("Server Host", "Host address for the local web UI server.")}<input id="cfg-host" value="${escapeHtml(config.defaults.serverHost)}" /></label>
            <label>${renderLabel("Server Port", "Port for the local web UI server.")}<input id="cfg-port" value="${escapeHtml(String(config.defaults.serverPort))}" /></label>
            <label>${renderLabel("History Tail", "How many recent transcript items are kept in the prompt tail for each turn.")}<input id="cfg-history-tail" value="${escapeHtml(String(config.defaults.historyTail))}" /></label>
            <label class="wide">${renderLabel("Codex Command", "Executable used to launch Codex for every agent turn.")}<input id="cfg-codex-command" value="${escapeHtml(config.defaults.codexCommand)}" /></label>
            <label>${renderLabel("Codex Home Mode", "Use the global ~/.codex home, or a project-owned Codex home generated only for codex_research_team.")} 
              <select id="cfg-codex-home-mode">
                ${["project", "global"].map((item) => `<option value="${item}" ${config.defaults.codexHomeMode === item ? "selected" : ""}>${item}</option>`).join("")}
              </select>
            </label>
            <label>${renderLabel("Codex Auth Mode", "In project mode, choose whether the project Codex home mirrors the global login or keeps its own separate credentials.")} 
              <select id="cfg-codex-auth-mode" ${config.defaults.codexHomeMode !== "project" ? "disabled" : ""}>
                <option value="mirror-global" ${config.defaults.codexAuthMode === "mirror-global" ? "selected" : ""}>Mirror global login</option>
                <option value="separate" ${config.defaults.codexAuthMode === "separate" ? "selected" : ""}>Separate project login</option>
              </select>
            </label>
            <label class="wide">${renderLabel("Codex Home Dir", "Used when Codex Home Mode is project. codex_research_team generates a dedicated config.toml here and can copy only the selected MCP servers into it.")}<input id="cfg-codex-home-dir" value="${escapeHtml(String(config.defaults.codexHomeDir || ""))}" /></label>
            <label>${renderLabel("Default Model", "Fallback model when an agent does not specify its own override.")}${renderModelSelect('id="cfg-model"', options, config.defaults.model, "No default model")}</label>
            <label>${renderLabel("Reasoning Effort", "Default model reasoning effort passed into Codex for every agent turn unless you change the runtime again later.")}${renderReasoningEffortSelect('id="cfg-reasoning-effort"', reasoningOptions, config.defaults.modelReasoningEffort, "Use Codex default")}</label>
            <label>${renderLabel("Sandbox", "Filesystem isolation mode passed to Codex.")} 
              <select id="cfg-sandbox">
                ${["read-only", "workspace-write", "danger-full-access"].map((item) => `<option value="${item}" ${config.defaults.sandbox === item ? "selected" : ""}>${item}</option>`).join("")}
              </select>
            </label>
            <label>${renderLabel("Approval", "Approval policy passed to Codex when it requests privileged actions.")} 
              <select id="cfg-approval">
                ${["untrusted", "on-request", "on-failure", "never"].map((item) => `<option value="${item}" ${config.defaults.approvalPolicy === item ? "selected" : ""}>${item}</option>`).join("")}
              </select>
            </label>
            <div class="wide auto-models-box">
              <div class="section-head tight">
                <div>
                  <span>Codex Login ${renderHint("Status is checked against the active Codex home. In project mode with separate login, use Open Login to authenticate that project home directly.")}</span>
                  <p class="muted">${escapeHtml(authStatusText)}</p>
                </div>
                <div class="inline-actions">
                  <button id="refresh-auth-status" class="ghost tiny">Refresh Status</button>
                  <button id="open-codex-login" class="ghost tiny" ${authControlsLocked ? "disabled" : ""}>${escapeHtml(authActionLabel)}</button>
                  <button id="codex-logout" class="ghost tiny" ${authControlsLocked ? "disabled" : ""}>Logout</button>
                </div>
              </div>
              <div class="hero-meta compact">
                <span class="status-pill ${authStatus?.loggedIn ? "idle" : "stopped"}">${escapeHtml(authStatusPill)}</span>
                <span>${escapeHtml(String(authStatus?.codexHomeDir || config.defaults.codexHomeDir || ""))}</span>
              </div>
              ${authEmail ? `<p class="muted">Signed in as ${escapeHtml(authEmail)}</p>` : ``}
              ${authControlsLocked ? `<p class="muted">Project auth is currently mirroring the global Codex login. Switch Auth Mode to Separate to log in independently.</p>` : ""}
              <pre>${escapeHtml(authStatusRaw)}</pre>
            </div>
            <div class="wide auto-models-box">
              <div class="section-head tight">
                <div>
                  <span>Detected Models ${renderHint("Auto-discovered from the local Codex installation. These values populate the model dropdowns.")}</span>
                  <p class="muted">${escapeHtml(modelCatalogSummary())}</p>
                </div>
                <button id="refresh-models" class="ghost tiny">Reload</button>
              </div>
              <pre>${escapeHtml(options.join("\n") || "No models detected yet.")}</pre>
            </div>
            <div class="wide auto-models-box">
              <div class="section-head tight">
                <div>
                  <span>MCP Servers ${renderHint("Only these selected MCP servers are copied into the dedicated project Codex home. Leave this empty to run the team without project-local MCP integrations.")}</span>
                  <p class="muted">${escapeHtml(mcpCatalogSummary())}</p>
                </div>
              </div>
              ${mcpServers.length > 0
                ? renderOptionCheckboxPicker("data-mcp-server-option", mcpServers, Array.isArray(config.defaults.mcpServerNames) ? config.defaults.mcpServerNames : [])
                : `<p class="muted">No MCP servers detected.</p>`}
            </div>
            <label class="check-line"><input id="cfg-search" type="checkbox" ${config.defaults.search ? "checked" : ""} /><span>Allow web search ${renderHint("Lets Codex use live web search when the runtime invokes it with search enabled.")}</span></label>
            <label class="check-line"><input id="cfg-dangerous" type="checkbox" ${config.defaults.dangerousBypass ? "checked" : ""} /><span>Dangerous bypass ${renderHint("Uses Codex's approval bypass flag. Only use this when you fully trust the workspace and runtime.")}</span></label>
          </div>
        </section>
        <section class="panel">
          <div class="section-head">
            <div>
              <p class="eyebrow">Channels</p>
              <h3>Channel Catalog</h3>
            </div>
          </div>
          <div class="settings-form-grid">
            <label>${renderLabel("Goal Channel", "Session-wide objective channel. This is the main top-level objective signal.")}<input id="cfg-goal-channel" value="${escapeHtml(config.defaults.goalChannel || "goal")}" /></label>
            <label>${renderLabel("Operator Channel", "Manual instruction channel used by the human operator or control UI.")}<input id="cfg-operator-channel" value="${escapeHtml(config.defaults.operatorChannel || "operator")}" /></label>
            <label class="wide">
              ${renderLabel("Team Channels", "Named non-system channels shown across agent publish/listen selectors. One per line or comma-separated.")}
              <textarea id="cfg-extra-channels" placeholder="one channel per line or comma-separated">${escapeHtml((config.defaults.extraChannels || []).join("\n"))}</textarea>
            </label>
            <div class="wide auto-models-box">
              <div class="section-head tight">
                <div>
                  <span>Current Channel List ${renderHint("Computed from defaults plus any channel already referenced by an agent. These are the options shown in the channel pickers.")}</span>
                </div>
              </div>
              <pre>${escapeHtml(channels.join("\n") || "-")}</pre>
            </div>
            <div class="wide auto-models-box">
              <div class="section-head tight">
                <div>
                  <span>Internal Channels ${renderHint("Reserved by the runtime. These are not meant to be used as normal team channels.")}</span>
                </div>
              </div>
              <pre>${escapeHtml(internalChannels.join("\n"))}</pre>
            </div>
          </div>
        </section>
      </section>
      <section class="page-section">
        <section class="panel agent-settings-panel">
          <div class="section-head">
            <div>
              <p class="eyebrow">Agents</p>
              <h3>Team Presets</h3>
            </div>
            <div class="inline-actions agent-settings-actions">
              <button id="add-agent-row" class="primary">Add Agent</button>
              <button data-nav="/workspaces" class="ghost">Open Workspaces</button>
            </div>
          </div>
          <div id="agent-editor-list" class="agent-editor-list">
            ${agentRows || `<p class="muted">No agents configured.</p>`}
          </div>
        </section>
      </section>
    `;
  }

  return {
    renderDashboardPage,
    renderSettingsPage,
    renderWorkspacesPage,
  };
}
