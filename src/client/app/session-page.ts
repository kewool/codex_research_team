type AnyObject = Record<string, any>;

type SessionPageDeps = {
  state: AnyObject;
  escapeHtml: (value: string) => string;
  cleanTerminalText: (value: unknown) => string;
  feedCache: (sessionId: string) => AnyObject;
  agentHistoryCache: (sessionId: string, agentId: string, kind: string) => AnyObject;
  currentAgentTab: () => string;
  historyKindForTab: (tab: string) => string;
  currentSession: () => AnyObject | null;
  ensureSelectedAgent: (session: AnyObject) => AnyObject | null;
  ensureSessionPageData: (session: AnyObject, selectedAgent: AnyObject | null) => void;
  formatTokenUsage: (usage: any) => string;
  formatTokenCount: (value: number) => string;
  tokenValue: (usage: any, field: string) => number;
  renderLabel: (text: string, help?: string) => string;
};

export function createSessionPageRenderers(deps: SessionPageDeps) {
  const {
    state,
    escapeHtml,
    cleanTerminalText,
    feedCache,
    agentHistoryCache,
    currentAgentTab,
    historyKindForTab,
    currentSession,
    ensureSelectedAgent,
    ensureSessionPageData,
    formatTokenUsage,
    formatTokenCount,
    tokenValue,
    renderLabel,
  } = deps;

  function renderListFooter(cache: AnyObject, emptyText: string): string {
    if (!cache.loaded && cache.loading) {
      return `<div class="history-footer">Loading...</div>`;
    }
    if (!cache.loaded) {
      return `<div class="history-footer">Waiting for data...</div>`;
    }
    if ((cache.items || []).length === 0) {
      return `<div class="history-footer muted">${escapeHtml(emptyText)}</div>`;
    }
    if (cache.loading) {
      return `<div class="history-footer">Loading older entries...</div>`;
    }
    if (cache.hasMore) {
      return `<div class="history-footer muted">Scroll down to load older entries.</div>`;
    }
    return `<div class="history-footer muted">No older entries.</div>`;
  }

  function renderHistoryEntry(entry: AnyObject, tab: string): string {
    const label = String(entry.label || tab).trim();
    const text = ["stdout", "stderr", "error"].includes(tab)
      ? cleanTerminalText(entry.text || "")
      : String(entry.text || "").replace(/\r\n?/g, "\n").trim();
    return `
      <article class="history-entry ${escapeHtml(tab)}">
        <header>
          <strong>${escapeHtml(label || tab)}</strong>
          <small>${escapeHtml(entry.timestamp || "")}</small>
        </header>
        <pre>${escapeHtml(text || "-")}</pre>
      </article>
    `;
  }

  function renderFeedItem(event: AnyObject): string {
    const meta = event.metadata || {};
    const metaBits: string[] = [];
    if (meta.turnCount != null) {
      metaBits.push(`turn ${meta.turnCount}`);
    }
    if (typeof meta.shouldReply === "boolean") {
      metaBits.push(`shouldReply ${meta.shouldReply ? "true" : "false"}`);
    }
    if (meta.completion) {
      metaBits.push(`completion ${meta.completion}`);
    }
    const targetAgentIds = Array.isArray(meta.targetAgentIds)
      ? meta.targetAgentIds.map((value: unknown) => String(value ?? "").trim()).filter(Boolean)
      : meta.targetAgentId
        ? [String(meta.targetAgentId)]
        : [];
    if (targetAgentIds.length > 0) {
      metaBits.push(`target ${targetAgentIds.join(", ")}`);
    }
    const subgoalIds = Array.isArray(meta.subgoalIds)
      ? meta.subgoalIds.map((value: unknown) => String(value ?? "").trim()).filter(Boolean)
      : [];
    if (subgoalIds.length > 0) {
      metaBits.push(`subgoals ${subgoalIds.join(", ")}`);
    }
    if (meta.directInput) {
      metaBits.push("direct input");
    }
    if (meta.conflictEvent) {
      metaBits.push("conflict");
    }
    if (meta.obsoleteEvent) {
      metaBits.push("obsolete");
    }
    if (meta.expectedRevision != null && meta.currentRevision != null) {
      metaBits.push(`rev ${meta.expectedRevision} -> ${meta.currentRevision}`);
    }
    return `
      <article class="feed-item ${targetAgentIds.length > 0 ? "targeted" : "broadcast"} ${meta.conflictEvent ? "conflict" : ""} ${meta.obsoleteEvent ? "obsolete" : ""}" data-channel="${escapeHtml(String(event.channel || "").toLowerCase())}">
        <header>
          <div>
            <strong>${escapeHtml(event.sender || "system")}</strong>
            <span class="feed-channel">${escapeHtml(event.channel || "status")}</span>
          </div>
          <small>${escapeHtml(event.timestamp || "")}</small>
        </header>
        ${metaBits.length > 0 ? `<div class="feed-meta">${metaBits.map((bit) => {
          const badgeClass = bit === "conflict" ? " conflict" : bit === "obsolete" ? " obsolete" : "";
          return `<span class="feed-badge${badgeClass}">${escapeHtml(bit)}</span>`;
        }).join("")}</div>` : ""}
        <p>${escapeHtml(event.content || "")}</p>
      </article>
    `;
  }

  function renderSessionFeed(sessionId: string): string {
    const cache = feedCache(sessionId);
    const items = (cache.items || []) as AnyObject[];
    const body = items.length > 0 ? items.map(renderFeedItem).join("") : "";
    return `${body}${renderListFooter(cache, "No events yet.")}`;
  }

  function renderSubgoalBoard(session: AnyObject): string {
    const subgoals = Array.isArray(session.subgoals) ? session.subgoals : [];
    const activeSubgoals = subgoals.filter((subgoal: AnyObject) => !subgoal.mergedIntoSubgoalId && !subgoal.archivedAt);
    const mergedSubgoals = subgoals.filter((subgoal: AnyObject) => subgoal.mergedIntoSubgoalId || subgoal.archivedAt);
    const subgoalById = new Map(subgoals.map((subgoal: AnyObject) => [String(subgoal.id || ""), subgoal]));
    if (activeSubgoals.length === 0 && mergedSubgoals.length === 0) {
      return `<p class="muted">No subgoals yet.</p>`;
    }
    const renderMemoryList = (label: string, items: unknown[] | null | undefined): string => {
      const values = Array.isArray(items) ? items.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
      if (values.length === 0) {
        return "";
      }
      return `<div class="subgoal-memory-row"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(values.join(" | "))}</span></div>`;
    };
    const renderSubgoalCard = (subgoal: AnyObject, archived = false): string => {
      const mergedTarget = subgoal.mergedIntoSubgoalId ? subgoalById.get(String(subgoal.mergedIntoSubgoalId)) : null;
      return `
        <article class="subgoal-card ${subgoal.activeConflict ? "conflict" : ""} ${archived ? "archived" : ""}" data-stage="${escapeHtml(String(subgoal.stage || "").toLowerCase())}">
          <header>
            <div>
              <strong>${escapeHtml(subgoal.title || "Untitled subgoal")}</strong>
              <small class="subgoal-card-id">${escapeHtml(String(subgoal.id || "-"))}</small>
            </div>
            <div class="subgoal-card-badges">
              ${subgoal.activeConflict ? `<span class="feed-badge conflict">conflict</span>` : ""}
              ${archived ? `<span class="feed-badge">merged</span>` : ""}
              <span class="status-pill ${escapeHtml(String(subgoal.stage || "open"))}">${escapeHtml(subgoal.stage || "open")}</span>
              <span class="feed-badge">${escapeHtml(String(subgoal.decisionState || "open"))}</span>
            </div>
          </header>
          <p>${escapeHtml(subgoal.summary || "-")}</p>
          <div class="subgoal-memory" data-scroll-key="${escapeHtml(`subgoal-memory:${session.id}:${String(subgoal.id || "")}`)}" data-scroll-mode="append">
            ${renderMemoryList("Facts", subgoal.facts)}
            ${renderMemoryList("Open", subgoal.openQuestions)}
            ${renderMemoryList("Resolved", subgoal.resolvedDecisions)}
            ${renderMemoryList("Acceptance", subgoal.acceptanceCriteria)}
            ${renderMemoryList("Files", subgoal.relevantFiles)}
            ${subgoal.nextAction ? `<div class="subgoal-memory-row"><strong>Next</strong><span>${escapeHtml(String(subgoal.nextAction || ""))}</span></div>` : ""}
          </div>
          ${subgoal.activeConflict && subgoal.lastConflictSummary ? `<small class="subgoal-conflict-text">${escapeHtml(subgoal.lastConflictSummary)}</small>` : ""}
          ${subgoal.lastReopenReason ? `<small class="subgoal-conflict-text">${escapeHtml(subgoal.lastReopenReason)}</small>` : ""}
          ${archived ? `<small class="subgoal-conflict-text">Merged into ${escapeHtml(String(mergedTarget?.title || subgoal.mergedIntoSubgoalId || "canonical subgoal"))}</small>` : ""}
          <small>${escapeHtml(subgoal.assigneeAgentId ? `assignee ${subgoal.assigneeAgentId}` : "shared")} · rev ${escapeHtml(String(subgoal.revision || 0))}${subgoal.conflictCount ? ` · conflicts ${escapeHtml(String(subgoal.conflictCount))}` : ""}</small>
        </article>
      `;
    };
    return `
      ${activeSubgoals.length > 0 ? `
        <div class="subgoal-board" data-subgoal-count="${escapeHtml(String(activeSubgoals.length))}" data-scroll-key="${escapeHtml(`subgoal-board:${session.id}:active`)}" data-scroll-mode="append">
          ${activeSubgoals.map((subgoal: AnyObject) => renderSubgoalCard(subgoal)).join("")}
        </div>
      ` : `<p class="muted">No active subgoals yet.</p>`}
      ${mergedSubgoals.length > 0 ? `
        <details class="subgoal-archive">
          <summary>Merged topics ${escapeHtml(String(mergedSubgoals.length))}</summary>
          <div class="subgoal-board subgoal-board-archived" data-subgoal-count="${escapeHtml(String(mergedSubgoals.length))}" data-scroll-key="${escapeHtml(`subgoal-board:${session.id}:archived`)}" data-scroll-mode="append">
            ${mergedSubgoals.map((subgoal: AnyObject) => renderSubgoalCard(subgoal, true)).join("")}
          </div>
        </details>
      ` : ""}
    `;
  }

  function renderAgentTabContent(sessionId: string, agent: AnyObject, tab: string): string {
    if (tab === "stdout") {
      return `
        <article class="history-entry tail-only">
          <header>
            <strong>Latest stdout</strong>
            <small>live tail</small>
          </header>
          <pre>${escapeHtml(cleanTerminalText(agent.stdoutTail || "-"))}</pre>
        </article>
      `;
    }
    if (tab === "stderr") {
      return `
        <article class="history-entry tail-only">
          <header>
            <strong>Latest stderr</strong>
            <small>live tail</small>
          </header>
          <pre>${escapeHtml(cleanTerminalText(agent.stderrTail || "-"))}</pre>
        </article>
      `;
    }
    const kind = historyKindForTab(tab);
    const cache = agentHistoryCache(sessionId, agent.id, kind);
    const items = (cache.items || []) as AnyObject[];
    const body = items.length > 0 ? items.map((entry) => renderHistoryEntry(entry, tab)).join("") : "";
    return `${body}${renderListFooter(cache, `No ${tab} entries yet.`)}`;
  }

  function renderAgentPickerItem(agent: AnyObject): string {
    const active = state.selectedAgentId === agent.id;
    return `
      <button class="agent-picker-item ${active ? "active" : ""}" data-select-agent="${escapeHtml(agent.id)}">
        <div class="section-head tight">
          <strong>${escapeHtml(agent.name)}</strong>
          <span class="status-pill ${escapeHtml(agent.status)}">${escapeHtml(agent.status)}</span>
        </div>
        <div class="mini-stats two-line">
          <span>turn ${escapeHtml(String(agent.turnCount))}</span>
          <span>pending ${escapeHtml(String(agent.pendingSignals))}</span>
          <span>${escapeHtml(agent.completion)}</span>
        </div>
      </button>
    `;
  }

  function renderFocusedAgentCard(session: AnyObject, agent: AnyObject): string {
    const tab = currentAgentTab();
    const tabs = [
      ["notes", "Notes"],
      ["message", "Message"],
      ["prompt", "Prompt"],
      ["stdout", "Stdout"],
      ["stderr", "Stderr"],
      ["error", "Error"],
    ];
    return `
      <section class="panel agent-focus-card ${agent.waitingForInput ? "waiting" : ""} ${agent.status === "error" ? "error" : ""}">
        <div class="section-head tight">
          <div>
            <p class="eyebrow">Agent</p>
            <h3>${escapeHtml(agent.name)}</h3>
            <p class="muted">${escapeHtml(agent.brief)}</p>
          </div>
          <div class="inline-actions">
            ${session.isLive ? `<button class="ghost danger" data-stop-agent="${escapeHtml(agent.id)}" ${agent.status === "stopped" ? "disabled" : ""}>Stop Agent</button>` : ""}
            ${session.isLive ? `<button class="ghost" data-restart-agent="${escapeHtml(agent.id)}">Restart Agent</button>` : ""}
            <span class="status-pill ${escapeHtml(agent.status)}">${escapeHtml(agent.status)}</span>
          </div>
        </div>
        <div class="agent-meta-bar">
          <span><strong>Turns</strong>${escapeHtml(String(agent.turnCount))}</span>
          <span><strong>Pending</strong>${escapeHtml(String(agent.pendingSignals))}</span>
          <span><strong>Last Input</strong>${escapeHtml(agent.lastInput || "-")}</span>
          <span><strong>Last Tokens</strong>${escapeHtml(formatTokenUsage(agent.lastUsage))}</span>
          <span><strong>Total Tokens</strong>${escapeHtml(formatTokenUsage(agent.totalUsage))}</span>
        </div>
        <div class="tab-strip">
          ${tabs.map(([value, label]) => `<button class="tab-button ${tab === value ? "active" : ""}" data-agent-tab="${value}">${label}</button>`).join("")}
        </div>
        <section class="agent-output-panel">
          <div class="history-list" data-agent-history="1" data-agent-id="${escapeHtml(agent.id)}" data-history-kind="${escapeHtml(historyKindForTab(tab))}" data-scroll-key="${escapeHtml(`agent-output:${agent.id}:${tab}`)}" data-scroll-mode="append">${renderAgentTabContent(session.id, agent, tab)}</div>
        </section>
      </section>
    `;
  }

  function renderSessionPage(): string {
    const session = currentSession();
    if (!session) {
      return `
        <section class="panel empty-panel">
          <h3>Session Not Found</h3>
          <p class="muted">This session does not exist yet or has not been loaded.</p>
          <button data-nav="/" class="primary">Back to Dashboard</button>
        </section>
      `;
    }
    const agents = (session.agents as AnyObject[]) || [];
    const selectedAgent = ensureSelectedAgent(session);
    ensureSessionPageData(session, selectedAgent);
    const waiting = agents.filter((agent) => agent.waitingForInput).length;
    const errors = agents.filter((agent) => agent.status === "error").length;
    const done = agents.filter((agent) => agent.completion === "done").length;
    const isResumable = !Boolean(session.isLive);
    const targetOptions = [`<option value="">All agents</option>`, ...agents.map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}</option>`)].join("");

    return `
      <section class="panel session-hero">
        <div class="session-title-block">
          <p class="eyebrow">Session</p>
          <h3>${escapeHtml(session.title)}</h3>
          <p class="goal-copy">${escapeHtml(session.goal)}</p>
        </div>
        <div class="hero-meta">
          <span class="status-pill ${escapeHtml(session.status)}">${escapeHtml(session.status)}</span>
          <span>${escapeHtml(session.isLive ? "live" : "saved")}</span>
          <span>${escapeHtml(session.workspaceName)}</span>
          <span>${escapeHtml(session.workspacePath)}</span>
        </div>
      </section>
      <section class="summary-row">
        <article class="metric-card panel"><span class="metric-label">Events</span><strong>${escapeHtml(String(session.eventCount))}</strong></article>
        <article class="metric-card panel"><span class="metric-label">Subgoals</span><strong>${escapeHtml(String(((session.subgoals || []) as AnyObject[]).filter((subgoal) => !subgoal.mergedIntoSubgoalId && !subgoal.archivedAt).length))}</strong></article>
        <article class="metric-card panel"><span class="metric-label">Waiting Input</span><strong>${escapeHtml(String(waiting))}</strong></article>
        <article class="metric-card panel"><span class="metric-label">Errors</span><strong>${escapeHtml(String(errors))}</strong></article>
        <article class="metric-card panel"><span class="metric-label">Completed Agents</span><strong>${escapeHtml(String(done))}</strong></article>
        <article class="metric-card panel"><span class="metric-label">Input Tokens</span><strong>${escapeHtml(formatTokenCount(tokenValue(session.totalUsage, "inputTokens")))}</strong></article>
        <article class="metric-card panel"><span class="metric-label">Cached Tokens</span><strong>${escapeHtml(formatTokenCount(tokenValue(session.totalUsage, "cachedInputTokens")))}</strong></article>
        <article class="metric-card panel"><span class="metric-label">Output Tokens</span><strong>${escapeHtml(formatTokenCount(tokenValue(session.totalUsage, "outputTokens")))}</strong></article>
      </section>
      <section class="panel goal-board-panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Progress</p>
            <h3>Goal Board</h3>
          </div>
          <span class="status-pill idle">rev ${escapeHtml(String(session.subgoalRevision || 0))}</span>
        </div>
        ${renderSubgoalBoard(session)}
      </section>
      <section class="panel command-deck">
        <div class="section-head">
          <div>
            <p class="eyebrow">Control</p>
            <h3>Operator</h3>
          </div>
          <div class="inline-actions">
            <button data-nav="/" class="ghost">Dashboard</button>
            <button id="session-refresh" class="ghost">Refresh Snapshot</button>
          </div>
        </div>
        <div class="command-layout">
          <label class="command-editor">
            ${renderLabel("Command", "Replace the session goal or send a follow-up instruction into the room.")}
            <textarea id="session-command" placeholder="${isResumable ? "Resume this session to send new instructions" : "Enter a new goal or an additional instruction"}" ${isResumable ? "disabled" : ""}></textarea>
          </label>
          <div class="command-controls">
            <label>
              ${renderLabel("Instruction Target", "Leave empty to broadcast to the room. Pick one agent to send a direct operator instruction.")}
              <select id="session-target" ${isResumable ? "disabled" : ""}>${targetOptions}</select>
            </label>
            <button id="session-send-goal" class="primary" ${isResumable ? "disabled" : ""}>Replace Goal</button>
            <button id="session-send-operator" ${isResumable ? "disabled" : ""}>Send Instruction</button>
            ${isResumable ? `<button id="session-resume" class="primary">Resume Session</button>` : `<button id="session-stop" class="ghost danger">Stop Session</button>`}
          </div>
        </div>
      </section>
      <section class="session-layout">
        <section class="panel feed-column">
          <div class="section-head">
            <h3>Feed</h3>
          </div>
          <div class="feed-list tall" data-feed-list="1" data-scroll-key="team-feed" data-scroll-mode="prepend">${renderSessionFeed(session.id)}</div>
        </section>
        <section class="panel agent-list-panel">
          <div class="section-head">
            <div>
              <p class="eyebrow">Focus</p>
              <h3>Agents</h3>
            </div>
          </div>
          <div class="agent-picker">
            ${agents.map(renderAgentPickerItem).join("")}
          </div>
        </section>
        ${selectedAgent ? renderFocusedAgentCard(session, selectedAgent) : `<section class="panel empty-panel"><p class="muted">No agent selected.</p></section>`}
      </section>
    `;
  }

  return {
    renderAgentPickerItem,
    renderFeedItem,
    renderFocusedAgentCard,
    renderHistoryEntry,
    renderListFooter,
    renderSessionFeed,
    renderSessionPage,
    renderSubgoalBoard,
  };
}
