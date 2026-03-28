import { escapeHtml, formatTokenCount, formatLimitReset, formatPercent, formatRemainingPercent, formatTokenUsage, tokenValue, } from "./format.js";
import { createConfigControlTools } from "./config-controls.js";
import { createPageActionTools } from "./page-actions.js";
import { createPageRenderers } from "./page-renders.js";
import { createScrollTools } from "./scroll.js";
import { createSessionCacheTools } from "./session-cache.js";
import { createSessionActionTools } from "./session-actions.js";
import { createSessionPageRenderers } from "./session-page.js";
const state = {
    snapshot: null,
    route: parseRoute(window.location.pathname),
    stream: null,
    flash: null,
    selectedWorkspaceName: null,
    selectedAgentId: null,
    selectedAgentTab: "notes",
    sessionData: {},
    sessionScroll: {
        windowY: 0,
        anchors: {},
    },
    workspaceCreateModal: {
        open: false,
        value: "",
    },
};
const FEED_PAGE_SIZE = 40;
const MAX_VISIBLE_FEED_ITEMS = 120;
const DEFAULT_HISTORY_PAGE_SIZE = 20;
const DEFAULT_MAX_VISIBLE_HISTORY_ITEMS = 80;
let renderQueued = false;
const { bindSessionScrollMemory, captureRenderScrollSnapshot, restoreRenderScrollSnapshot, saveElementScrollAnchor, syncSessionScrollMemoryFromDom, } = createScrollTools(state);
function scheduleRender() {
    if (renderQueued) {
        return;
    }
    renderQueued = true;
    requestAnimationFrame(() => {
        renderQueued = false;
        render();
    });
}
async function api(path, init) {
    const response = await fetch(path, {
        headers: { "content-type": "application/json" },
        ...init,
    });
    if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(payload.error || response.statusText);
    }
    return response.json();
}
function parseRoute(pathname) {
    if (pathname === "/workspaces") {
        return { name: "workspaces" };
    }
    if (pathname === "/settings") {
        return { name: "settings" };
    }
    const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/);
    if (sessionMatch) {
        return { name: "session", sessionId: decodeURIComponent(sessionMatch[1]) };
    }
    return { name: "dashboard" };
}
function navigate(path, replace = false) {
    if (replace) {
        window.history.replaceState({}, "", path);
    }
    else {
        window.history.pushState({}, "", path);
    }
    state.route = parseRoute(window.location.pathname);
    bindSessionStream();
    render();
}
function qs(selector) {
    const element = document.querySelector(selector);
    if (!element) {
        throw new Error(`Missing element: ${selector}`);
    }
    return element;
}
function availableSubgoalStages() {
    const fromSnapshot = Array.isArray(state.snapshot?.subgoalStages)
        ? state.snapshot.subgoalStages.map((value) => String(value ?? "").trim()).filter(Boolean)
        : [];
    if (fromSnapshot.length > 0) {
        return [...new Set(fromSnapshot)];
    }
    const fromPolicies = Array.isArray(state.snapshot?.config?.agents)
        ? state.snapshot.config.agents.flatMap((agent) => Array.isArray(agent?.policy?.ownedStages)
            ? agent.policy.ownedStages.map((value) => String(value ?? "").trim()).filter(Boolean)
            : [])
        : [];
    const fromSession = state.route.name === "session" && Array.isArray(state.sessionData?.[state.route.sessionId]?.snapshot?.subgoals)
        ? state.sessionData[state.route.sessionId].snapshot.subgoals.map((subgoal) => String(subgoal?.stage ?? "").trim()).filter(Boolean)
        : [];
    return [...new Set([...fromPolicies, ...fromSession])];
}
function renderHint(text) {
    const tip = escapeHtml(text);
    return `<span class="hint" tabindex="0" role="note" aria-label="${tip}" data-tip="${tip}">?</span>`;
}
function renderLabel(text, help) {
    return `<span class="field-label">${escapeHtml(text)}${help ? renderHint(help) : ""}</span>`;
}
const { configuredChannelList, defaultListenChannelsForAgent, defaultPublishChannelForAgent, parseChannelListInput, parseLineListInput, remapSemanticChannel, renderAgentCheckboxPicker, renderChannelCheckboxPicker, renderChannelSelect, renderModelSelect, renderOptionCheckboxPicker, renderReasoningEffortSelect, renderStageCheckboxPicker, } = createConfigControlTools({
    escapeHtml,
    availableSubgoalStages,
});
function setFlash(kind, text) {
    state.flash = { kind, text };
    paintFlash();
}
function clearFlash() {
    state.flash = null;
    paintFlash();
}
function paintFlash() {
    const root = document.querySelector("#flash");
    if (!root) {
        return;
    }
    if (!state.flash) {
        root.innerHTML = "";
        root.className = "flash-slot";
        return;
    }
    root.className = `flash-slot ${state.flash.kind}`;
    root.innerHTML = `<span>${escapeHtml(state.flash.text)}</span><button id="flash-dismiss" class="ghost tiny">Dismiss</button>`;
    const dismiss = root.querySelector("#flash-dismiss");
    if (dismiss) {
        dismiss.onclick = () => clearFlash();
    }
}
function currentSession() {
    const route = state.route;
    if (!state.snapshot || route.name !== "session") {
        return null;
    }
    return (state.snapshot.sessions || []).find((session) => session.id === route.sessionId) || null;
}
function activeSessions() {
    return (state.snapshot?.sessions || []).filter((session) => Boolean(session.isLive));
}
function currentConfig() {
    return state.snapshot?.config || { defaults: {}, workspaces: [], agents: [] };
}
function currentCodexAuthStatus() {
    return state.snapshot?.codexAuthStatus || null;
}
function currentCodexUsageStatus() {
    return state.snapshot?.codexUsageStatus || null;
}
function modelOptions(config) {
    const options = new Set();
    for (const value of state.snapshot?.modelCatalog?.models || []) {
        const text = String(value ?? "").trim();
        if (text) {
            options.add(text);
        }
    }
    for (const value of config?.defaults?.modelOptions || []) {
        const text = String(value ?? "").trim();
        if (text) {
            options.add(text);
        }
    }
    const defaultModel = String(config?.defaults?.model || "").trim();
    if (defaultModel) {
        options.add(defaultModel);
    }
    for (const agent of config?.agents || []) {
        const model = String(agent?.model || "").trim();
        if (model) {
            options.add(model);
        }
    }
    return [...options];
}
function modelCatalogSummary() {
    const catalog = state.snapshot?.modelCatalog;
    if (!catalog) {
        return "Model list unavailable.";
    }
    const sourceMap = {
        "models_cache": "Codex models cache",
        "config": "Codex config",
        "models_cache+config": "Codex models cache + config",
        "none": "no Codex model source",
    };
    const source = sourceMap[String(catalog.source || "none")] || String(catalog.source || "unknown source");
    const fetchedAt = String(catalog.fetchedAt || "").trim();
    return fetchedAt ? `Auto-loaded from ${source}. Cache fetched at ${fetchedAt}.` : `Auto-loaded from ${source}.`;
}
function mcpOptions() {
    const values = (state.snapshot?.mcpCatalog?.servers || [])
        .map((value) => String(value ?? "").trim())
        .filter((value) => Boolean(value));
    return Array.from(new Set(values));
}
function mcpCatalogSummary() {
    const catalog = state.snapshot?.mcpCatalog;
    if (!catalog) {
        return "MCP catalog unavailable.";
    }
    if (!catalog.servers?.length) {
        return "No MCP servers detected in the available Codex config sources.";
    }
    return `Selectable MCP servers discovered from ${String(catalog.source || "the active Codex config source")}.`;
}
function reasoningEffortOptions(config) {
    const values = new Set(["minimal", "low", "medium", "high", "xhigh"]);
    const selected = String(config?.defaults?.modelReasoningEffort || "").trim();
    if (selected) {
        values.add(selected);
    }
    return [...values];
}
function tailClientText(value, maxChars = 12000) {
    const text = String(value ?? "");
    if (text.length <= maxChars) {
        return text;
    }
    return text.slice(text.length - maxChars);
}
function ensureTerminalRow(lines, row) {
    while (lines.length <= row) {
        lines.push("");
    }
}
function setTerminalCell(lines, row, col, char) {
    ensureTerminalRow(lines, row);
    let line = lines[row] || "";
    if (line.length < col) {
        line = line.padEnd(col, " ");
    }
    if (col >= line.length) {
        line += char;
    }
    else {
        line = `${line.slice(0, col)}${char}${line.slice(col + 1)}`;
    }
    lines[row] = line;
}
function parseTerminalCount(raw, fallback) {
    const value = Number(raw || "");
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
function cleanTerminalText(value) {
    const raw = String(value ?? "");
    const lines = [""];
    let row = 0;
    let col = 0;
    let savedRow = 0;
    let savedCol = 0;
    const moveTo = (nextRow, nextCol) => {
        row = Math.max(0, nextRow);
        col = Math.max(0, nextCol);
        ensureTerminalRow(lines, row);
    };
    const clearScreen = () => {
        lines.length = 0;
        lines.push("");
        row = 0;
        col = 0;
    };
    for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index];
        if (char === "\u001b") {
            const next = raw[index + 1];
            if (next === "]") {
                const bellIndex = raw.indexOf("\u0007", index + 2);
                const stIndex = raw.indexOf("\u001b\\", index + 2);
                const endIndex = bellIndex === -1 ? stIndex : stIndex === -1 ? bellIndex : Math.min(bellIndex, stIndex);
                if (endIndex === -1) {
                    break;
                }
                index = raw[endIndex] === "\u0007" ? endIndex : endIndex + 1;
                continue;
            }
            if (next === "[") {
                let cursor = index + 2;
                while (cursor < raw.length && !/[@-~]/.test(raw[cursor])) {
                    cursor += 1;
                }
                if (cursor >= raw.length) {
                    break;
                }
                const finalByte = raw[cursor];
                const parameterText = raw.slice(index + 2, cursor);
                const normalizedParams = parameterText.replace(/^\?/, "").split(";");
                switch (finalByte) {
                    case "A":
                        moveTo(row - parseTerminalCount(normalizedParams[0], 1), col);
                        break;
                    case "B":
                        moveTo(row + parseTerminalCount(normalizedParams[0], 1), col);
                        break;
                    case "C":
                        moveTo(row, col + parseTerminalCount(normalizedParams[0], 1));
                        break;
                    case "D":
                        moveTo(row, col - parseTerminalCount(normalizedParams[0], 1));
                        break;
                    case "E":
                        moveTo(row + parseTerminalCount(normalizedParams[0], 1), 0);
                        break;
                    case "F":
                        moveTo(row - parseTerminalCount(normalizedParams[0], 1), 0);
                        break;
                    case "G":
                        moveTo(row, parseTerminalCount(normalizedParams[0], 1) - 1);
                        break;
                    case "H":
                    case "f":
                        moveTo(parseTerminalCount(normalizedParams[0], 1) - 1, parseTerminalCount(normalizedParams[1], 1) - 1);
                        break;
                    case "J":
                        if (["", "2", "3"].includes(normalizedParams[0] || "")) {
                            clearScreen();
                        }
                        break;
                    case "K":
                        ensureTerminalRow(lines, row);
                        lines[row] = (lines[row] || "").slice(0, col);
                        break;
                    case "s":
                        savedRow = row;
                        savedCol = col;
                        break;
                    case "u":
                        moveTo(savedRow, savedCol);
                        break;
                    default:
                        break;
                }
                index = cursor;
                continue;
            }
            continue;
        }
        if (char === "\r") {
            col = 0;
            continue;
        }
        if (char === "\n") {
            row += 1;
            ensureTerminalRow(lines, row);
            continue;
        }
        if (char === "\b") {
            col = Math.max(0, col - 1);
            continue;
        }
        if (char === "\t") {
            col += 4 - (col % 4 || 4);
            continue;
        }
        if (char < " ") {
            continue;
        }
        setTerminalCell(lines, row, col, char);
        col += 1;
    }
    const rendered = lines
        .slice(-120)
        .map((line) => line.replace(/[ \t]+$/g, ""))
        .join("\n")
        .replace(/\u203A/g, ">")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return rendered || "-";
}
function ensureSelectedWorkspace() {
    const config = currentConfig();
    const names = (config.workspaces || []).map((workspace) => workspace.name);
    if (names.length === 0) {
        state.selectedWorkspaceName = null;
        return null;
    }
    if (state.selectedWorkspaceName && names.includes(state.selectedWorkspaceName)) {
        return state.selectedWorkspaceName;
    }
    state.selectedWorkspaceName = config.defaults.defaultWorkspaceName && names.includes(config.defaults.defaultWorkspaceName)
        ? config.defaults.defaultWorkspaceName
        : names[0];
    return state.selectedWorkspaceName;
}
function selectedWorkspace() {
    const name = ensureSelectedWorkspace();
    if (!name) {
        return null;
    }
    return (currentConfig().workspaces || []).find((workspace) => workspace.name === name) || null;
}
function clientSlugify(value) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "-")
        .replace(/^-+|-+$/g, "") || "workspace";
}
const { renderDashboardPage, renderSettingsPage, renderWorkspacesPage, } = createPageRenderers({
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
});
function bindSessionStream() {
    state.stream?.close();
    state.stream = null;
    if (state.route.name !== "session") {
        return;
    }
    const session = currentSession();
    if (!session || session.status === "stopped") {
        return;
    }
    const sessionId = session.id;
    state.stream = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
    state.stream.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        if (payload.snapshot) {
            upsertSession(payload.snapshot);
        }
        if (payload.type === "event" && payload.event) {
            prependFeedEvent(sessionId, payload.event);
            if (state.route.name === "session" && state.route.sessionId === sessionId) {
                scheduleRender();
            }
            return;
        }
        if (payload.type === "stream" && payload.agentId && payload.stream) {
            const kind = payload.stream === "stderr" ? "stderr" : "stdout";
            const text = String(payload.text || "");
            prependLiveHistory(sessionId, payload.agentId, kind, text);
            appendAgentStreamTail(sessionId, payload.agentId, kind, text);
            if (state.route.name === "session" &&
                state.route.sessionId === sessionId &&
                state.selectedAgentId === payload.agentId) {
                scheduleRender();
            }
            return;
        }
        if (payload.type === "agent" && payload.agent) {
            upsertAgentSnapshot(sessionId, payload.agent);
            if (state.route.name === "session" &&
                state.route.sessionId === sessionId &&
                state.selectedAgentId === payload.agent.id &&
                !["stdout", "stderr"].includes(historyKindForTab(currentAgentTab()))) {
                void withGuard(loadVisibleAgentHistory(true));
            }
            if (state.route.name === "session" && state.route.sessionId === sessionId) {
                scheduleRender();
            }
            return;
        }
        if (payload.type === "session" && state.route.name === "session" && state.route.sessionId === sessionId) {
            scheduleRender();
        }
    };
    state.stream.onerror = () => {
        if (state.stream?.readyState === EventSource.CLOSED) {
            state.stream = null;
        }
    };
}
function upsertSession(snapshot) {
    if (!state.snapshot) {
        return;
    }
    const sessions = state.snapshot.sessions || [];
    const index = sessions.findIndex((session) => session.id === snapshot.id);
    if (index >= 0) {
        sessions[index] = snapshot;
    }
    else {
        sessions.unshift(snapshot);
    }
    sessions.sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}
async function refreshState() {
    const payload = await api("/api/state");
    state.snapshot = payload;
    ensureSelectedWorkspace();
    bindSessionStream();
    render();
}
function render() {
    const scrollSnapshot = captureRenderScrollSnapshot();
    const root = qs("#app");
    const snapshot = state.snapshot;
    const sessions = (snapshot?.sessions || []);
    root.innerHTML = `
    <div class="app-shell route-${state.route.name}">
      <aside class="rail">
        <div class="rail-brand">
          <div class="brand-mark" aria-hidden="true">ct</div>
          <div class="brand-copy">
            <p class="eyebrow">codex_research_team</p>
            <h1>Control Room</h1>
          </div>
        </div>
        <nav class="rail-nav">
          <button class="nav-item ${state.route.name === "dashboard" ? "active" : ""}" data-nav="/">Dashboard</button>
          <button class="nav-item ${state.route.name === "workspaces" ? "active" : ""}" data-nav="/workspaces">Workspaces</button>
          <button class="nav-item ${state.route.name === "settings" ? "active" : ""}" data-nav="/settings">Settings</button>
        </nav>
        <section class="rail-section">
          <div class="section-head">
            <h2>Recent Sessions</h2>
            <button id="refresh-state" class="ghost tiny">Refresh</button>
          </div>
          <div class="session-stack">
            ${sessions.length === 0 ? `<p class="muted">No sessions yet.</p>` : sessions.map(renderRailSessionCard).join("")}
          </div>
        </section>
      </aside>
      <main class="page">
        <header class="page-topbar">
          <div class="page-heading">
            <p class="eyebrow page-label">${escapeHtml(pageKicker())}</p>
            <h2>${escapeHtml(pageTitle())}</h2>
          </div>
          <div class="topbar-actions">
            <button id="top-dashboard" class="ghost">Dashboard</button>
            <button id="top-workspaces" class="ghost">Workspaces</button>
            <button id="top-settings" class="ghost">Settings</button>
          </div>
        </header>
        <div id="flash" class="flash-slot"></div>
        <section class="page-body">
          ${renderPage()}
        </section>
      </main>
    </div>
  `;
    paintFlash();
    wireChromeActions();
    wirePageActions();
    bindSessionScrollMemory();
    if (scrollSnapshot) {
        restoreRenderScrollSnapshot(scrollSnapshot);
        requestAnimationFrame(() => restoreRenderScrollSnapshot(scrollSnapshot));
    }
}
function pageKicker() {
    if (state.route.name === "workspaces") {
        return "Workspace library";
    }
    if (state.route.name === "settings") {
        return "Runtime setup";
    }
    if (state.route.name === "session") {
        return "Live session";
    }
    return "Overview";
}
function pageTitle() {
    if (state.route.name === "workspaces") {
        return "Workspaces";
    }
    if (state.route.name === "settings") {
        return "Settings";
    }
    if (state.route.name === "session") {
        return currentSession()?.title || "Session";
    }
    return "Dashboard";
}
function renderRailSessionCard(session) {
    const errorCount = (session.agents || []).filter((agent) => agent.status === "error").length;
    const waitingCount = (session.agents || []).filter((agent) => agent.waitingForInput).length;
    const isSelected = state.route.name === "session" ? state.route.sessionId === session.id : false;
    return `
    <button class="session-link ${isSelected ? "active" : ""}" data-nav="/sessions/${encodeURIComponent(session.id)}">
      <strong>${escapeHtml(session.title)}</strong>
      <span>${escapeHtml(session.status)} - ${escapeHtml(session.workspaceName)}</span>
      <small>${escapeHtml(session.updatedAt)}</small>
      <div class="mini-stats">
        <span>${escapeHtml(String(waitingCount))} waiting</span>
        <span>${escapeHtml(String(errorCount))} errors</span>
      </div>
    </button>
  `;
}
function renderPage() {
    if (!state.snapshot) {
        return `<section class="panel"><h3>Loading</h3><p class="muted">Loading current state.</p></section>`;
    }
    if (state.route.name === "workspaces") {
        return renderWorkspacesPage();
    }
    if (state.route.name === "settings") {
        return renderSettingsPage();
    }
    if (state.route.name === "session") {
        return renderSessionPage();
    }
    return renderDashboardPage();
}
function ensureSelectedAgent(session) {
    const agents = session?.agents || [];
    if (agents.length === 0) {
        state.selectedAgentId = null;
        return null;
    }
    const match = agents.find((agent) => agent.id === state.selectedAgentId);
    if (match) {
        return match;
    }
    state.selectedAgentId = session.selectedAgentId || agents[0].id;
    return agents.find((agent) => agent.id === state.selectedAgentId) || agents[0];
}
function currentAgentTab() {
    const allowed = new Set(["notes", "message", "prompt", "stdout", "stderr", "error"]);
    if (!allowed.has(state.selectedAgentTab)) {
        state.selectedAgentTab = "notes";
    }
    return state.selectedAgentTab;
}
function historyKindForTab(tab) {
    if (tab === "message") {
        return "messages";
    }
    if (tab === "prompt") {
        return "prompts";
    }
    if (tab === "stdout") {
        return "stdout";
    }
    if (tab === "stderr") {
        return "stderr";
    }
    if (tab === "error") {
        return "errors";
    }
    return "notes";
}
function historyPageSize(kind) {
    if (kind === "prompts") {
        return 1;
    }
    if (kind === "messages") {
        return 8;
    }
    if (kind === "notes") {
        return 12;
    }
    if (kind === "errors") {
        return 12;
    }
    return DEFAULT_HISTORY_PAGE_SIZE;
}
function maxVisibleHistoryItems(kind) {
    if (kind === "prompts") {
        return 12;
    }
    if (kind === "messages") {
        return 40;
    }
    return DEFAULT_MAX_VISIBLE_HISTORY_ITEMS;
}
const { agentHistoryCache, appendAgentStreamTail, ensureSessionPageData, eventKey, feedCache, loadAgentHistory, loadSessionFeed, loadVisibleAgentHistory, prependFeedEvent, prependLiveHistory, upsertAgentSnapshot, } = createSessionCacheTools({
    state,
    api,
    scheduleRender,
    currentSession,
    ensureSelectedAgent,
    currentAgentTab,
    historyKindForTab,
    historyPageSize,
    maxVisibleHistoryItems,
    tailClientText,
    withGuard,
    FEED_PAGE_SIZE,
    MAX_VISIBLE_FEED_ITEMS,
});
const { renderAgentPickerItem, renderFeedItem, renderFocusedAgentCard, renderHistoryEntry, renderListFooter, renderSessionFeed, renderSessionPage, renderSubgoalBoard, } = createSessionPageRenderers({
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
});
const { restartSessionAgent, resumeCurrentSession, sendSessionCommand, stopCurrentSession, stopSessionAgent, wireSessionActions, } = createSessionActionTools({
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
});
const { wirePageActions } = createPageActionTools({
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
});
function wireChromeActions() {
    document.querySelectorAll("[data-nav]").forEach((element) => {
        element.onclick = (event) => {
            event.preventDefault();
            const path = element.getAttribute("data-nav");
            if (path) {
                navigate(path);
            }
        };
    });
    const refresh = document.querySelector("#refresh-state");
    if (refresh) {
        refresh.onclick = () => void withGuard(refreshState());
    }
    const topDashboard = document.querySelector("#top-dashboard");
    if (topDashboard) {
        topDashboard.onclick = () => navigate("/");
    }
    const topWorkspaces = document.querySelector("#top-workspaces");
    if (topWorkspaces) {
        topWorkspaces.onclick = () => navigate("/workspaces");
    }
    const topSettings = document.querySelector("#top-settings");
    if (topSettings) {
        topSettings.onclick = () => navigate("/settings");
    }
}
async function withGuard(task) {
    try {
        await task;
    }
    catch (error) {
        setFlash("error", error.message);
    }
}
window.addEventListener("popstate", () => {
    state.route = parseRoute(window.location.pathname);
    bindSessionStream();
    render();
});
window.addEventListener("scroll", () => {
    if (state.route.name === "session") {
        state.sessionScroll.windowY = window.scrollY;
    }
}, { passive: true });
window.addEventListener("DOMContentLoaded", () => {
    void withGuard(refreshState());
});
