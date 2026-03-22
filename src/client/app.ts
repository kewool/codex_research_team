type AnyObject = Record<string, any>;
type RouteState = { name: "dashboard" } | { name: "workspaces" } | { name: "settings" } | { name: "session"; sessionId: string };
type FlashState = { kind: "error" | "info"; text: string } | null;

const state = {
  snapshot: null as AnyObject | null,
  route: parseRoute(window.location.pathname),
  stream: null as EventSource | null,
  flash: null as FlashState,
  selectedWorkspaceName: null as string | null,
  selectedAgentId: null as string | null,
  selectedAgentTab: "notes" as string,
  sessionData: {} as Record<string, any>,
  sessionScroll: {
    windowY: 0,
    anchors: {} as Record<string, any>,
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
type ScrollAnchorMode = "append" | "prepend";
type ScrollAnchorSnapshot = {
  top: number;
  left: number;
  distanceFromBottom: number;
  nearTop: boolean;
  nearBottom: boolean;
  mode: ScrollAnchorMode;
};
type RenderScrollSnapshot = {
  windowY: number;
  anchors: Record<string, ScrollAnchorSnapshot>;
};

function captureRenderScrollSnapshot(): RenderScrollSnapshot | null {
  if (state.route.name !== "session") {
    return null;
  }
  const anchors: Record<string, ScrollAnchorSnapshot> = {};
  document.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((element) => {
    const key = element.dataset.scrollKey;
    if (!key) {
      return;
    }
    const saved = state.sessionScroll.anchors[key] as ScrollAnchorSnapshot | undefined;
    if (saved) {
      anchors[key] = { ...saved };
      return;
    }
    const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const top = Math.max(0, Math.min(maxTop, element.scrollTop));
    const distanceFromBottom = Math.max(0, maxTop - top);
    anchors[key] = {
      top,
      left: element.scrollLeft,
      distanceFromBottom,
      nearTop: top <= 12,
      nearBottom: distanceFromBottom <= 12,
      mode: element.dataset.scrollMode === "prepend" ? "prepend" : "append",
    };
  });
  return {
    windowY: state.sessionScroll.windowY || window.scrollY,
    anchors,
  };
}

function restoreRenderScrollSnapshot(snapshot: RenderScrollSnapshot | null): void {
  if (!snapshot || state.route.name !== "session") {
    return;
  }
  const scrollRoot = document.scrollingElement;
  if (scrollRoot) {
    scrollRoot.scrollTop = snapshot.windowY;
  } else {
    window.scrollTo(0, snapshot.windowY);
  }
  document.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((element) => {
    const key = element.dataset.scrollKey;
    if (!key) {
      return;
    }
    const saved = snapshot.anchors[key];
    if (!saved) {
      return;
    }
    const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    if (saved.mode === "prepend") {
      element.scrollTop = saved.nearTop ? 0 : Math.max(0, Math.min(maxTop, maxTop - saved.distanceFromBottom));
    } else {
      element.scrollTop = Math.max(0, Math.min(maxTop, saved.top));
    }
    const maxLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    element.scrollLeft = Math.max(0, Math.min(maxLeft, saved.left));
  });
  state.sessionScroll.windowY = snapshot.windowY;
  state.sessionScroll.anchors = { ...state.sessionScroll.anchors, ...snapshot.anchors };
  syncSessionScrollMemoryFromDom();
}

function syncSessionScrollMemoryFromDom(): void {
  if (state.route.name !== "session") {
    return;
  }
  state.sessionScroll.windowY = window.scrollY;
  document.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((element) => {
    const key = element.dataset.scrollKey;
    if (!key) {
      return;
    }
    const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const top = Math.max(0, Math.min(maxTop, element.scrollTop));
    const distanceFromBottom = Math.max(0, maxTop - top);
    state.sessionScroll.anchors[key] = {
      top,
      left: element.scrollLeft,
      distanceFromBottom,
      nearTop: top <= 12,
      nearBottom: distanceFromBottom <= 12,
      mode: element.dataset.scrollMode === "prepend" ? "prepend" : "append",
    };
  });
}

function bindSessionScrollMemory(): void {
  if (state.route.name !== "session") {
    return;
  }
  syncSessionScrollMemoryFromDom();
  document.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((element) => {
    if (element.dataset.scrollBound === "1") {
      return;
    }
    element.dataset.scrollBound = "1";
    element.addEventListener("scroll", () => syncSessionScrollMemoryFromDom(), { passive: true });
  });
}

function scheduleRender(): void {
  if (renderQueued) {
    return;
  }
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

async function api(path: string, init?: RequestInit) {
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

function parseRoute(pathname: string): RouteState {
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

function navigate(path: string, replace = false): void {
  if (replace) {
    window.history.replaceState({}, "", path);
  } else {
    window.history.pushState({}, "", path);
  }
  state.route = parseRoute(window.location.pathname);
  bindSessionStream();
  render();
}

function qs<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element as T;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function availableSubgoalStages(): string[] {
  const fromSnapshot = Array.isArray(state.snapshot?.subgoalStages)
    ? state.snapshot.subgoalStages.map((value: unknown) => String(value ?? "").trim()).filter(Boolean)
    : [];
  if (fromSnapshot.length > 0) {
    return [...new Set(fromSnapshot)];
  }
  const fromPolicies = Array.isArray(state.snapshot?.config?.agents)
    ? state.snapshot.config.agents.flatMap((agent: AnyObject) =>
        Array.isArray(agent?.policy?.ownedStages)
          ? agent.policy.ownedStages.map((value: unknown) => String(value ?? "").trim()).filter(Boolean)
          : []
      )
    : [];
  const fromSession = state.route.name === "session" && Array.isArray(state.sessionData?.[state.route.sessionId]?.snapshot?.subgoals)
    ? state.sessionData[state.route.sessionId].snapshot.subgoals.map((subgoal: AnyObject) => String(subgoal?.stage ?? "").trim()).filter(Boolean)
    : [];
  return [...new Set([...fromPolicies, ...fromSession])];
}

function renderHint(text: string): string {
  const tip = escapeHtml(text);
  return `<span class="hint" tabindex="0" role="note" aria-label="${tip}" data-tip="${tip}">?</span>`;
}

function renderLabel(text: string, help?: string): string {
  return `<span class="field-label">${escapeHtml(text)}${help ? renderHint(help) : ""}</span>`;
}

function setFlash(kind: "error" | "info", text: string): void {
  state.flash = { kind, text };
  paintFlash();
}

function clearFlash(): void {
  state.flash = null;
  paintFlash();
}

function paintFlash(): void {
  const root = document.querySelector<HTMLDivElement>("#flash");
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
  const dismiss = root.querySelector<HTMLButtonElement>("#flash-dismiss");
  if (dismiss) {
    dismiss.onclick = () => clearFlash();
  }
}

function currentSession(): AnyObject | null {
  const route = state.route;
  if (!state.snapshot || route.name !== "session") {
    return null;
  }
  return ((state.snapshot.sessions as AnyObject[]) || []).find((session) => session.id === route.sessionId) || null;
}

function activeSessions(): AnyObject[] {
  return ((state.snapshot?.sessions as AnyObject[]) || []).filter((session) => Boolean(session.isLive));
}

function currentConfig(): AnyObject {
  return state.snapshot?.config || { defaults: {}, workspaces: [], agents: [] };
}

function currentCodexAuthStatus(): AnyObject | null {
  return (state.snapshot?.codexAuthStatus as AnyObject) || null;
}

function currentCodexUsageStatus(): AnyObject | null {
  return (state.snapshot?.codexUsageStatus as AnyObject) || null;
}

function modelOptions(config: AnyObject): string[] {
  const options = new Set<string>();
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

function modelCatalogSummary(): string {
  const catalog = state.snapshot?.modelCatalog;
  if (!catalog) {
    return "Model list unavailable.";
  }
  const sourceMap: Record<string, string> = {
    "models_cache": "Codex models cache",
    "config": "Codex config",
    "models_cache+config": "Codex models cache + config",
    "none": "no Codex model source",
  };
  const source = sourceMap[String(catalog.source || "none")] || String(catalog.source || "unknown source");
  const fetchedAt = String(catalog.fetchedAt || "").trim();
  return fetchedAt ? `Auto-loaded from ${source}. Cache fetched at ${fetchedAt}.` : `Auto-loaded from ${source}.`;
}

function mcpOptions(): string[] {
  const values = (state.snapshot?.mcpCatalog?.servers || [])
    .map((value: unknown) => String(value ?? "").trim())
    .filter((value: string) => Boolean(value));
  return Array.from(new Set<string>(values));
}

function mcpCatalogSummary(): string {
  const catalog = state.snapshot?.mcpCatalog;
  if (!catalog) {
    return "MCP catalog unavailable.";
  }
  if (!catalog.servers?.length) {
    return "No MCP servers detected in the available Codex config sources.";
  }
  return `Selectable MCP servers discovered from ${String(catalog.source || "the active Codex config source")}.`;
}

function reasoningEffortOptions(config: AnyObject): string[] {
  const values = new Set<string>(["minimal", "low", "medium", "high", "xhigh"]);
  const selected = String(config?.defaults?.modelReasoningEffort || "").trim();
  if (selected) {
    values.add(selected);
  }
  return [...values];
}

function tailClientText(value: unknown, maxChars = 12000): string {
  const text = String(value ?? "");
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(text.length - maxChars);
}

function ensureTerminalRow(lines: string[], row: number): void {
  while (lines.length <= row) {
    lines.push("");
  }
}

function setTerminalCell(lines: string[], row: number, col: number, char: string): void {
  ensureTerminalRow(lines, row);
  let line = lines[row] || "";
  if (line.length < col) {
    line = line.padEnd(col, " ");
  }
  if (col >= line.length) {
    line += char;
  } else {
    line = `${line.slice(0, col)}${char}${line.slice(col + 1)}`;
  }
  lines[row] = line;
}

function parseTerminalCount(raw: string | undefined, fallback: number): number {
  const value = Number(raw || "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function cleanTerminalText(value: unknown): string {
  const raw = String(value ?? "");
  const lines = [""];
  let row = 0;
  let col = 0;
  let savedRow = 0;
  let savedCol = 0;

  const moveTo = (nextRow: number, nextCol: number) => {
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
function ensureSelectedWorkspace(): string | null {
  const config = currentConfig();
  const names = (config.workspaces || []).map((workspace: AnyObject) => workspace.name);
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

function selectedWorkspace(): AnyObject | null {
  const name = ensureSelectedWorkspace();
  if (!name) {
    return null;
  }
  return (currentConfig().workspaces || []).find((workspace: AnyObject) => workspace.name === name) || null;
}

function clientSlugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
}
function bindSessionStream(): void {
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
      if (
        state.route.name === "session" &&
        state.route.sessionId === sessionId &&
        state.selectedAgentId === payload.agentId
      ) {
        scheduleRender();
      }
      return;
    }
    if (payload.type === "agent" && payload.agent) {
      upsertAgentSnapshot(sessionId, payload.agent);
      if (
        state.route.name === "session" &&
        state.route.sessionId === sessionId &&
        state.selectedAgentId === payload.agent.id &&
        !["stdout", "stderr"].includes(historyKindForTab(currentAgentTab()))
      ) {
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

function upsertSession(snapshot: AnyObject): void {
  if (!state.snapshot) {
    return;
  }
  const sessions = (state.snapshot.sessions as AnyObject[]) || [];
  const index = sessions.findIndex((session) => session.id === snapshot.id);
  if (index >= 0) {
    sessions[index] = snapshot;
  } else {
    sessions.unshift(snapshot);
  }
  sessions.sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

async function refreshState(): Promise<void> {
  const payload = await api("/api/state");
  state.snapshot = payload;
  ensureSelectedWorkspace();
  bindSessionStream();
  render();
}

function render(): void {
  const scrollSnapshot = captureRenderScrollSnapshot();
  const root = qs<HTMLDivElement>("#app");
  const snapshot = state.snapshot;
  const sessions = ((snapshot?.sessions as AnyObject[]) || []);

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

function pageKicker(): string {
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

function pageTitle(): string {
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

function renderRailSessionCard(session: AnyObject): string {
  const errorCount = (session.agents || []).filter((agent: AnyObject) => agent.status === "error").length;
  const waitingCount = (session.agents || []).filter((agent: AnyObject) => agent.waitingForInput).length;
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

function renderPage(): string {
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

function renderDashboardPage(): string {
  const config = state.snapshot?.config;
  const sessions = (state.snapshot?.sessions as AnyObject[]) || [];
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
      <div class="session-grid">
        ${sessions.length === 0 ? `<p class="muted">No sessions yet.</p>` : sessions.map(renderDashboardSessionCard).join("")}
      </div>
    </section>
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
function configuredChannelList(config: AnyObject): string[] {
  const teamChannels = parseChannelListInput((config?.defaults?.extraChannels || []).join(","));
  const values = [
    String(config?.defaults?.goalChannel || "").trim(),
    String(config?.defaults?.operatorChannel || "").trim(),
    ...teamChannels,
    ...((config?.agents || []).flatMap((agent: AnyObject) => [
      String(agent?.publishChannel || "").trim(),
      ...((agent?.listenChannels || []).map((value: unknown) => String(value ?? "").trim())),
    ])),
  ];
  return [...new Set(values.filter(Boolean))];
}

function parseChannelListInput(value: string): string[] {
  return [...new Set(
    String(value || "")
      .split(/[\n,]+/g)
      .map((item) => item.trim())
      .filter(Boolean),
  )];
}

function defaultPublishChannelForAgent(config: AnyObject): string {
  const channels = configuredChannelList(config).filter((channel) => channel !== String(config?.defaults?.goalChannel || "goal") && channel !== String(config?.defaults?.operatorChannel || "operator"));
  return channels[0] || String(config?.defaults?.goalChannel || "goal");
}

function defaultListenChannelsForAgent(config: AnyObject): string[] {
  const goal = String(config?.defaults?.goalChannel || "goal");
  const operator = String(config?.defaults?.operatorChannel || "operator");
  return [...new Set([goal, operator])];
}

function remapSemanticChannel(channel: string, previousDefaults: AnyObject, nextDefaults: AnyObject): string {
  const value = String(channel || "").trim();
  if (!value) {
    return "";
  }
  const pairs: Array<[string, string]> = [
    [String(previousDefaults?.goalChannel || "goal"), String(nextDefaults?.goalChannel || "goal")],
    [String(previousDefaults?.operatorChannel || "operator"), String(nextDefaults?.operatorChannel || "operator")],
  ];
  for (const [before, after] of pairs) {
    if (value === before && after) {
      return after;
    }
  }
  return value;
}

function renderChannelSelect(attributes: string, channels: string[], selected: string, emptyLabel = "Select channel"): string {
  const deduped = [...new Set([...channels, selected].map((value) => String(value || "").trim()).filter(Boolean))];
  const options = [
    `<option value="">${escapeHtml(emptyLabel)}</option>`,
    ...deduped.map((channel) => `<option value="${escapeHtml(channel)}" ${selected === channel ? "selected" : ""}>${escapeHtml(channel)}</option>`),
  ];
  return `<select ${attributes}>${options.join("")}</select>`;
}

function renderChannelCheckboxPicker(attributeName: string, index: number, channels: string[], selectedValues: string[]): string {
  const selected = [...new Set(selectedValues.map((value) => String(value || "").trim()).filter(Boolean))];
  const options = [...new Set([...channels, ...selected])];
  return `
    <div class="channel-picker">
      ${options.map((channel) => `
        <label class="channel-chip">
          <input type="checkbox" ${attributeName}="${index}" value="${escapeHtml(channel)}" ${selected.includes(channel) ? "checked" : ""} />
          <span>${escapeHtml(channel)}</span>
        </label>
      `).join("")}
    </div>
  `;
}

function renderAgentCheckboxPicker(attributeName: string, index: number, options: string[], selectedValues: string[]): string {
  const selected = [...new Set(selectedValues.map((value) => String(value || "").trim()).filter(Boolean))];
  const values = [...new Set([...options, ...selected])];
  return `
    <div class="channel-picker">
      ${values.map((value) => `
        <label class="channel-chip">
          <input type="checkbox" ${attributeName}="${index}" value="${escapeHtml(value)}" ${selected.includes(value) ? "checked" : ""} />
          <span>${escapeHtml(value)}</span>
        </label>
      `).join("")}
    </div>
  `;
}

function renderOptionCheckboxPicker(attributeName: string, options: string[], selectedValues: string[]): string {
  const selected = [...new Set(selectedValues.map((value) => String(value || "").trim()).filter(Boolean))];
  const values = [...new Set([...options, ...selected])];
  return `
    <div class="channel-picker">
      ${values.map((value) => `
        <label class="channel-chip">
          <input type="checkbox" ${attributeName} value="${escapeHtml(value)}" ${selected.includes(value) ? "checked" : ""} />
          <span>${escapeHtml(value)}</span>
        </label>
      `).join("")}
    </div>
  `;
}

function renderStageCheckboxPicker(attributeName: string, index: number, selectedValues: string[]): string {
  return `
    <div class="channel-picker">
      ${availableSubgoalStages().map((stage) => `
        <label class="channel-chip">
          <input type="checkbox" ${attributeName}="${index}" value="${escapeHtml(stage)}" ${selectedValues.includes(stage) ? "checked" : ""} />
          <span>${escapeHtml(stage)}</span>
        </label>
      `).join("")}
    </div>
  `;
}

function parseLineListInput(value: string): string[] {
  return [...new Set(
    String(value || "")
      .split(/\r?\n/g)
      .map((item) => item.trim())
      .filter(Boolean),
  )];
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

function renderModelSelect(attributes: string, options: string[], selected: string | null, emptyLabel: string): string {
  const normalized = String(selected || "").trim();
  const deduped = [...new Set(options.filter(Boolean))];
  const selectOptions = [
    `<option value="">${escapeHtml(emptyLabel)}</option>`,
    ...deduped.map((model) => `<option value="${escapeHtml(model)}" ${normalized === model ? "selected" : ""}>${escapeHtml(model)}</option>`),
  ];
  return `<select ${attributes}>${selectOptions.join("")}</select>`;
}

function renderReasoningEffortSelect(attributes: string, options: string[], selected: string | null, emptyLabel: string): string {
  const normalized = String(selected || "").trim();
  const deduped = [...new Set(options.filter(Boolean))];
  const selectOptions = [
    `<option value="">${escapeHtml(emptyLabel)}</option>`,
    ...deduped.map((value) => `<option value="${escapeHtml(value)}" ${normalized === value ? "selected" : ""}>${escapeHtml(value)}</option>`),
  ];
  return `<select ${attributes}>${selectOptions.join("")}</select>`;
}
function tokenValue(usage: AnyObject | null | undefined, key: string): number {
  return Number(usage?.[key] || 0);
}

function formatTokenCount(value: unknown): string {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function formatTokenUsage(usage: AnyObject | null | undefined): string {
  const input = formatTokenCount(tokenValue(usage, "inputTokens"));
  const cached = formatTokenCount(tokenValue(usage, "cachedInputTokens"));
  const output = formatTokenCount(tokenValue(usage, "outputTokens"));
  return `in ${input} / cache ${cached} / out ${output}`;
}

function formatPercent(value: unknown): string {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "--";
  }
  return `${Math.round(number)}%`;
}

function formatRemainingPercent(usedPercent: unknown): string {
  const used = Number(usedPercent);
  if (!Number.isFinite(used)) {
    return "--";
  }
  const remaining = Math.max(0, Math.min(100, 100 - used));
  return `${Math.round(remaining)}%`;
}

function formatLimitReset(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) {
    return "No reset time";
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return "No reset time";
  }
  return `Resets ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)}`;
}

function renderUsageMetricCard(label: string, window: AnyObject | null | undefined, status: AnyObject | null): string {
  const available = Boolean(status?.available && window);
  const value = available ? formatRemainingPercent(window?.usedPercent) : "--";
  const note = available
    ? `${formatPercent(window?.usedPercent)} used - ${formatLimitReset(window?.resetsAt)}`
    : "No recent quota data";
  return `
    <article class="metric-card panel">
      <span class="metric-label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small class="metric-note">${escapeHtml(note)}</small>
    </article>
  `;
}

function ensureSelectedAgent(session: AnyObject): AnyObject | null {
  const agents = (session?.agents as AnyObject[]) || [];
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

function currentAgentTab(): string {
  const allowed = new Set(["notes", "message", "prompt", "stdout", "stderr", "error"]);
  if (!allowed.has(state.selectedAgentTab)) {
    state.selectedAgentTab = "notes";
  }
  return state.selectedAgentTab;
}

function historyKindForTab(tab: string): string {
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

function historyPageSize(kind: string): number {
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

function maxVisibleHistoryItems(kind: string): number {
  if (kind === "prompts") {
    return 12;
  }
  if (kind === "messages") {
    return 40;
  }
  return DEFAULT_MAX_VISIBLE_HISTORY_ITEMS;
}

function blankPageCache(): AnyObject {
  return {
    items: [],
    nextBefore: null,
    hasMore: false,
    loaded: false,
    loading: false,
    error: null,
  };
}

function ensureSessionData(sessionId: string): AnyObject {
  if (!state.sessionData[sessionId]) {
    state.sessionData[sessionId] = {
      feed: blankPageCache(),
      agentHistory: {},
    };
  }
  return state.sessionData[sessionId];
}

function feedCache(sessionId: string): AnyObject {
  return ensureSessionData(sessionId).feed;
}

function agentHistoryCache(sessionId: string, agentId: string, kind: string): AnyObject {
  const store = ensureSessionData(sessionId);
  const key = `${agentId}:${kind}`;
  if (!store.agentHistory[key]) {
    store.agentHistory[key] = blankPageCache();
  }
  return store.agentHistory[key];
}

function eventKey(event: AnyObject): string {
  return String(event.sequence ?? `${event.timestamp}:${event.sender}:${event.channel}:${event.content}`);
}

function historyEntryKey(entry: AnyObject): string {
  return String(entry._cursor ?? entry.id ?? `${entry.timestamp}:${entry.kind}:${entry.text}`);
}

function uniqueItems(items: AnyObject[], keyOf: (item: AnyObject) => string): AnyObject[] {
  const seen = new Set<string>();
  const output: AnyObject[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }
  return output;
}

function refreshPageCursor(cache: AnyObject): void {
  const cursors = (cache.items || [])
    .map((item: AnyObject) => Number(item?._cursor))
    .filter((value: number) => Number.isFinite(value) && value > 0 && value < Number.MAX_SAFE_INTEGER);
  if (cursors.length === 0) {
    return;
  }
  const nextBefore = Math.min(...cursors) - 1;
  cache.nextBefore = nextBefore > 0 ? nextBefore : null;
}

async function loadSessionFeed(sessionId: string, options: AnyObject = {}): Promise<void> {
  const cache = feedCache(sessionId);
  if (cache.loading) {
    return;
  }
  if (!options.reset && cache.loaded && !cache.hasMore && !options.force) {
    return;
  }
  if (options.reset) {
    cache.items = [];
    cache.nextBefore = null;
    cache.hasMore = false;
    cache.loaded = false;
  }
  cache.loading = true;
  cache.error = null;
  if (state.route.name === "session" && state.route.sessionId === sessionId) {
    scheduleRender();
  }
  try {
    const before = options.reset ? null : cache.nextBefore;
    const payload = await api(`/api/sessions/${encodeURIComponent(sessionId)}/feed?limit=${FEED_PAGE_SIZE}${before ? `&before=${encodeURIComponent(String(before))}` : ""}`);
    const nextItems = Array.isArray(payload.items) ? payload.items : [];
    cache.items = options.reset
      ? nextItems
      : [...cache.items, ...nextItems.filter((item: AnyObject) => !cache.items.some((current: AnyObject) => eventKey(current) === eventKey(item)))];
    cache.nextBefore = payload.nextBefore ?? null;
    cache.hasMore = Boolean(payload.hasMore);
    cache.loaded = true;
    refreshPageCursor(cache);
  } finally {
    cache.loading = false;
    if (state.route.name === "session" && state.route.sessionId === sessionId) {
      scheduleRender();
    }
  }
}

async function loadAgentHistory(sessionId: string, agentId: string, kind: string, options: AnyObject = {}): Promise<void> {
  const cache = agentHistoryCache(sessionId, agentId, kind);
  if (cache.loading) {
    return;
  }
  if (!options.reset && cache.loaded && !cache.hasMore && !options.force) {
    return;
  }
  if (options.reset) {
    cache.items = [];
    cache.nextBefore = null;
    cache.hasMore = false;
    cache.loaded = false;
  }
  cache.loading = true;
  cache.error = null;
  if (state.route.name === "session" && state.route.sessionId === sessionId) {
    scheduleRender();
  }
  try {
    const before = options.reset ? null : cache.nextBefore;
    const payload = await api(`/api/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/history?kind=${encodeURIComponent(kind)}&limit=${historyPageSize(kind)}${before ? `&before=${encodeURIComponent(String(before))}` : ""}`);
    const nextItems = Array.isArray(payload.items) ? payload.items : [];
    cache.items = options.reset
      ? nextItems
      : [...cache.items, ...nextItems.filter((item: AnyObject) => !cache.items.some((current: AnyObject) => historyEntryKey(current) === historyEntryKey(item)))];
    cache.nextBefore = payload.nextBefore ?? null;
    cache.hasMore = Boolean(payload.hasMore);
    cache.loaded = true;
    cache.items = (cache.items || []).slice(0, maxVisibleHistoryItems(kind));
    refreshPageCursor(cache);
  } finally {
    cache.loading = false;
    if (state.route.name === "session" && state.route.sessionId === sessionId) {
      scheduleRender();
    }
  }
}

async function loadVisibleAgentHistory(force = false): Promise<void> {
  const session = currentSession();
  if (!session) {
    return;
  }
  const agent = ensureSelectedAgent(session);
  if (!agent) {
    return;
  }
  const kind = historyKindForTab(currentAgentTab());
  if (kind === "stdout" || kind === "stderr") {
    return;
  }
  const cache = agentHistoryCache(session.id, agent.id, kind);
  await loadAgentHistory(session.id, agent.id, kind, { reset: force || !cache.loaded, force });
}

function prependFeedEvent(sessionId: string, event: AnyObject): void {
  const cache = feedCache(sessionId);
  cache.items = uniqueItems([event, ...(cache.items || [])], eventKey).slice(0, MAX_VISIBLE_FEED_ITEMS);
  cache.loaded = true;
  cache.hasMore = cache.hasMore || Boolean(cache.nextBefore) || cache.items.length >= MAX_VISIBLE_FEED_ITEMS;
  refreshPageCursor(cache);
}

function prependLiveHistory(sessionId: string, agentId: string, kind: string, text: string): void {
  if (!String(text || "").trim()) {
    return;
  }
  const cache = agentHistoryCache(sessionId, agentId, kind);
  const liveEntry = {
    id: `live-${agentId}-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    kind,
    text,
    label: null,
    _cursor: Number.MAX_SAFE_INTEGER,
  };
  cache.items = uniqueItems([liveEntry, ...(cache.items || [])], historyEntryKey).slice(0, maxVisibleHistoryItems(kind));
  cache.loaded = true;
  cache.hasMore = cache.hasMore || Boolean(cache.nextBefore) || cache.items.length >= maxVisibleHistoryItems(kind);
  refreshPageCursor(cache);
}

function appendAgentStreamTail(sessionId: string, agentId: string, kind: "stdout" | "stderr", text: string): void {
  const sessions = (state.snapshot?.sessions as AnyObject[]) || [];
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) {
    return;
  }
  const agents = (session.agents as AnyObject[]) || [];
  const agent = agents.find((entry) => entry.id === agentId);
  if (!agent) {
    return;
  }
  const field = kind === "stderr" ? "stderrTail" : "stdoutTail";
  agent[field] = tailClientText(`${String(agent[field] || "")}${text}`);
}

function upsertAgentSnapshot(sessionId: string, nextAgent: AnyObject): void {
  const sessions = (state.snapshot?.sessions as AnyObject[]) || [];
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) {
    return;
  }
  const agents = (session.agents as AnyObject[]) || [];
  const index = agents.findIndex((agent) => agent.id === nextAgent.id);
  if (index >= 0) {
    agents[index] = { ...agents[index], ...nextAgent };
  } else {
    agents.push(nextAgent);
  }
}

function ensureSessionPageData(session: AnyObject, selectedAgent: AnyObject | null): void {
  const feed = feedCache(session.id);
  if (!feed.loaded && !feed.loading) {
    void withGuard(loadSessionFeed(session.id, { reset: true }));
  }
  if (!selectedAgent) {
    return;
  }
  const kind = historyKindForTab(currentAgentTab());
  const cache = agentHistoryCache(session.id, selectedAgent.id, kind);
  if (!cache.loaded && !cache.loading) {
    void withGuard(loadAgentHistory(session.id, selectedAgent.id, kind, { reset: true }));
  }
}

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
        <div class="subgoal-memory">
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
      <div class="subgoal-board" data-subgoal-count="${escapeHtml(String(activeSubgoals.length))}">
        ${activeSubgoals.map((subgoal: AnyObject) => renderSubgoalCard(subgoal)).join("")}
      </div>
    ` : `<p class="muted">No active subgoals yet.</p>`}
    ${mergedSubgoals.length > 0 ? `
      <details class="subgoal-archive">
        <summary>Merged topics ${escapeHtml(String(mergedSubgoals.length))}</summary>
        <div class="subgoal-board subgoal-board-archived" data-subgoal-count="${escapeHtml(String(mergedSubgoals.length))}">
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
  const isStopped = session.status === "stopped";
  const isLive = Boolean(session.isLive);
  const isResumable = !isLive;
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
        <span>${escapeHtml(isLive ? "live" : "saved")}</span>
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
      ${selectedAgent ? renderFocusedAgentCard(session.id, selectedAgent) : `<section class="panel empty-panel"><p class="muted">No agent selected.</p></section>`}
    </section>
  `;
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

function renderFocusedAgentCard(sessionId: string, agent: AnyObject): string {
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
        <span class="status-pill ${escapeHtml(agent.status)}">${escapeHtml(agent.status)}</span>
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
        <div class="history-list" data-agent-history="1" data-agent-id="${escapeHtml(agent.id)}" data-history-kind="${escapeHtml(historyKindForTab(tab))}" data-scroll-key="${escapeHtml(`agent-output:${agent.id}:${tab}`)}" data-scroll-mode="append">${renderAgentTabContent(sessionId, agent, tab)}</div>
      </section>
    </section>
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
        <strong>${escapeHtml(event.sender)}</strong>
        <span>${escapeHtml(event.channel)}</span>
      </header>
      ${metaBits.length > 0 ? `<div class="feed-meta">${metaBits.map((bit) => {
        const badgeClass = bit === "conflict" ? " conflict" : bit === "obsolete" ? " obsolete" : "";
        return `<span class="feed-badge${badgeClass}">${escapeHtml(bit)}</span>`;
      }).join("")}</div>` : ""}
      <p>${escapeHtml(event.content)}</p>
      <small>${escapeHtml(event.timestamp)}</small>
    </article>
  `;
}

function renderAgentSummary(agent: AnyObject): string {
  return `
    <article class="panel summary-chip ${agent.waitingForInput ? "waiting" : ""} ${agent.status === "error" ? "error" : ""}">
      <div class="section-head tight">
        <strong>${escapeHtml(agent.name)}</strong>
        <span class="status-pill ${escapeHtml(agent.status)}">${escapeHtml(agent.status)}</span>
      </div>
      <div class="mini-stats two-line">
        <span>turn ${escapeHtml(String(agent.turnCount))}</span>
        <span>pending ${escapeHtml(String(agent.pendingSignals))}</span>
        <span>${escapeHtml(agent.completion)}</span>
      </div>
    </article>
  `;
}

function renderAgentDetailCard(agent: AnyObject): string {
  return `
    <article class="panel agent-detail-card ${agent.waitingForInput ? "waiting" : ""} ${agent.status === "error" ? "error" : ""}">
      <div class="section-head tight">
        <div>
          <h4>${escapeHtml(agent.name)}</h4>
          <p class="muted">${escapeHtml(agent.brief)}</p>
        </div>
        <span class="status-pill ${escapeHtml(agent.status)}">${escapeHtml(agent.status)}</span>
      </div>
      <div class="agent-meta-bar">
        <span><strong>Turns</strong>${escapeHtml(String(agent.turnCount))}</span>
        <span><strong>Pending</strong>${escapeHtml(String(agent.pendingSignals))}</span>
        <span><strong>Last Input</strong>${escapeHtml(agent.lastInput || "-")}</span>
        <span><strong>Last Tokens</strong>${escapeHtml(formatTokenUsage(agent.lastUsage))}</span>
        <span><strong>Total Tokens</strong>${escapeHtml(formatTokenUsage(agent.totalUsage))}</span>
      </div>
      <div class="detail-grid">
        <section><h5>Working Notes</h5><pre>${escapeHtml((agent.workingNotes || []).join("\n") || "-")}</pre></section>
        <section><h5>Team Message</h5><pre>${escapeHtml(agent.teamMessage || "-")}</pre></section>
        <section><h5>Last Prompt</h5><pre>${escapeHtml(agent.lastPrompt || "-")}</pre></section>
        <section><h5>Last Error</h5><pre>${escapeHtml(agent.lastError || "-")}</pre></section>
        <section><h5>Stdout</h5><pre>${escapeHtml(agent.stdoutTail || "-")}</pre></section>
        <section><h5>Stderr</h5><pre>${escapeHtml(agent.stderrTail || "-")}</pre></section>
      </div>
    </article>
  `;
}
function wireChromeActions(): void {
  document.querySelectorAll<HTMLElement>("[data-nav]").forEach((element) => {
    element.onclick = (event) => {
      event.preventDefault();
      const path = element.getAttribute("data-nav");
      if (path) {
        navigate(path);
      }
    };
  });
  const refresh = document.querySelector<HTMLButtonElement>("#refresh-state");
  if (refresh) {
    refresh.onclick = () => void withGuard(refreshState());
  }
  const topDashboard = document.querySelector<HTMLButtonElement>("#top-dashboard");
  if (topDashboard) {
    topDashboard.onclick = () => navigate("/");
  }
  const topWorkspaces = document.querySelector<HTMLButtonElement>("#top-workspaces");
  if (topWorkspaces) {
    topWorkspaces.onclick = () => navigate("/workspaces");
  }
  const topSettings = document.querySelector<HTMLButtonElement>("#top-settings");
  if (topSettings) {
    topSettings.onclick = () => navigate("/settings");
  }
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
  wireSessionActions();
}

function wireDashboardActions(): void {
  const launch = document.querySelector<HTMLButtonElement>("#launch-session");
  if (launch) {
    launch.onclick = () => void withGuard(startSessionFromDashboard());
  }
}

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
function wireSessionActions(): void {
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

  const feedList = document.querySelector<HTMLElement>("[data-feed-list]");
  if (feedList && feedList.dataset.historyBound !== "1") {
    feedList.dataset.historyBound = "1";
    feedList.addEventListener("scroll", () => {
      if (feedList.scrollTop + feedList.clientHeight >= feedList.scrollHeight - 120) {
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
      if (historyList.scrollTop + historyList.clientHeight >= historyList.scrollHeight - 120) {
        void withGuard(loadAgentHistory(session.id, agentId, kind));
      }
    }, { passive: true });
  }
}

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
  const payload = await api(`/api/sessions/${encodeURIComponent(session.id)}/instructions`, {
    method: "POST",
    body: JSON.stringify({ channel, text, targetAgentId }),
  });
  upsertSession(payload.session);
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
  clearFlash();
  render();
}

async function withGuard(task: Promise<void>): Promise<void> {
  try {
    await task;
  } catch (error) {
    setFlash("error", (error as Error).message);
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



















