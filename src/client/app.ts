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
  return ((state.snapshot?.sessions as AnyObject[]) || []).filter((session) => session.status !== "stopped");
}

function currentConfig(): AnyObject {
  return state.snapshot?.config || { defaults: {}, workspaces: [], agents: [] };
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
      prependLiveHistory(sessionId, payload.agentId, kind, String(payload.text || ""));
      if (
        state.route.name === "session" &&
        state.route.sessionId === sessionId &&
        state.selectedAgentId === payload.agentId &&
        historyKindForTab(currentAgentTab()) === kind
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
    <div class="app-shell">
      <aside class="rail">
        <div class="rail-brand">
          <p class="eyebrow">Codex Group</p>
          <h1>Persistent Agent Room</h1>
          <p>Create sessions, manage workspaces, and monitor agents from separated views.</p>
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
          <div>
            <p class="eyebrow">Local Web UI</p>
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
  const workspaceOptions = (config?.workspaces || [])
    .map((workspace: AnyObject) => `<option value="${escapeHtml(workspace.name)}" ${config.defaults.defaultWorkspaceName === workspace.name ? "selected" : ""}>${escapeHtml(workspace.name)}</option>`)
    .join("");
  const active = activeSessions();
  return `
    <section class="hero panel hero-panel">
      <div class="hero-copy">
        <p class="eyebrow">Launch</p>
        <h3>Start New Session</h3>
        <p>This page is for creating sessions and browsing the list. Live monitoring happens on the session detail page.</p>
      </div>
      <div class="launch-form">
        <label>
          <span>Goal</span>
          <textarea id="launch-goal" placeholder="Example: analyze the sample audio in the workspace and plan an MR reconstruction workflow"></textarea>
        </label>
        <div class="launch-grid">
          <label>
            <span>Title</span>
            <input id="launch-title" placeholder="Optional" />
          </label>
          <label>
            <span>Workspace</span>
            <select id="launch-workspace">${workspaceOptions}</select>
          </label>
        </div>
        <div class="inline-actions">
          <button id="launch-session" class="primary">Start Session</button>
          <button data-nav="/workspaces" class="ghost">Manage Workspaces</button>
          <button data-nav="/settings" class="ghost">Manage Settings</button>
        </div>
      </div>
    </section>
    <section class="summary-row">
      <article class="metric-card panel"><span class="metric-label">Active Sessions</span><strong>${escapeHtml(String(active.length))}</strong></article>
      <article class="metric-card panel"><span class="metric-label">Saved Sessions</span><strong>${escapeHtml(String(sessions.length))}</strong></article>
      <article class="metric-card panel"><span class="metric-label">Workspaces</span><strong>${escapeHtml(String((config?.workspaces || []).length))}</strong></article>
      <article class="metric-card panel"><span class="metric-label">Agents</span><strong>${escapeHtml(String((config?.agents || []).length))}</strong></article>
    </section>
    <section class="panel page-section">
      <div class="section-head">
        <h3>Session Overview</h3>
        <p class="muted">Pick a session to open its detail view.</p>
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
  const values = [
    String(config?.defaults?.goalChannel || "").trim(),
    String(config?.defaults?.researchChannel || "").trim(),
    String(config?.defaults?.implementationChannel || "").trim(),
    String(config?.defaults?.reviewChannel || "").trim(),
    String(config?.defaults?.operatorChannel || "").trim(),
    ...((config?.defaults?.extraChannels || []).map((value: unknown) => String(value ?? "").trim())),
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

function defaultPublishChannelForRole(role: string, config: AnyObject): string {
  if (role === "implementation") {
    return String(config?.defaults?.implementationChannel || "implementation");
  }
  if (role === "review") {
    return String(config?.defaults?.reviewChannel || "review");
  }
  if (role === "general") {
    return String(config?.defaults?.goalChannel || "goal");
  }
  return String(config?.defaults?.researchChannel || "research");
}

function defaultListenChannelsForRole(role: string, config: AnyObject): string[] {
  const goal = String(config?.defaults?.goalChannel || "goal");
  const research = String(config?.defaults?.researchChannel || "research");
  const implementation = String(config?.defaults?.implementationChannel || "implementation");
  const review = String(config?.defaults?.reviewChannel || "review");
  const operator = String(config?.defaults?.operatorChannel || "operator");
  if (role === "implementation") {
    return [research, review, operator];
  }
  if (role === "review") {
    return [implementation, operator];
  }
  if (role === "general") {
    return [goal, research, implementation, review, operator];
  }
  return [goal, research, implementation, operator];
}

function remapSemanticChannel(channel: string, previousDefaults: AnyObject, nextDefaults: AnyObject): string {
  const value = String(channel || "").trim();
  if (!value) {
    return "";
  }
  const pairs: Array<[string, string]> = [
    [String(previousDefaults?.goalChannel || "goal"), String(nextDefaults?.goalChannel || "goal")],
    [String(previousDefaults?.researchChannel || "research"), String(nextDefaults?.researchChannel || "research")],
    [String(previousDefaults?.implementationChannel || "implementation"), String(nextDefaults?.implementationChannel || "implementation")],
    [String(previousDefaults?.reviewChannel || "review"), String(nextDefaults?.reviewChannel || "review")],
    [String(previousDefaults?.operatorChannel || "operator"), String(nextDefaults?.operatorChannel || "operator")],
  ];
  for (const [before, after] of pairs) {
    if (value === before && after) {
      return after;
    }
  }
  return value;
}

function renderRoleSelect(attributes: string, selected: string): string {
  const roles = ["research", "implementation", "review", "general"];
  return `
    <select ${attributes}>
      ${roles.map((role) => `<option value="${role}" ${selected === role ? "selected" : ""}>${role}</option>`).join("")}
    </select>
  `;
}

function renderChannelSelect(attributes: string, channels: string[], selected: string, emptyLabel = "Select channel"): string {
  const deduped = [...new Set([...channels, selected].map((value) => String(value || "").trim()).filter(Boolean))];
  const options = [
    `<option value="">${escapeHtml(emptyLabel)}</option>`,
    ...deduped.map((channel) => `<option value="${escapeHtml(channel)}" ${selected === channel ? "selected" : ""}>${escapeHtml(channel)}</option>`),
  ];
  return `<select ${attributes}>${options.join("")}</select>`;
}

function renderListenChannelPicker(index: number, channels: string[], selectedValues: string[]): string {
  const selected = [...new Set(selectedValues.map((value) => String(value || "").trim()).filter(Boolean))];
  const options = [...new Set([...channels, ...selected])];
  return `
    <div class="channel-picker">
      ${options.map((channel) => `
        <label class="channel-chip">
          <input type="checkbox" data-agent-listen-option="${index}" value="${escapeHtml(channel)}" ${selected.includes(channel) ? "checked" : ""} />
          <span>${escapeHtml(channel)}</span>
        </label>
      `).join("")}
    </div>
  `;
}

function renderWorkspacesPage(): string {
  const config = currentConfig();
  const current = selectedWorkspace();
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
            <span>Default workspace</span>
          </label>
          <button class="ghost tiny" data-remove-workspace="${index}">Delete</button>
        </div>
        <label>
          <span>Name</span>
          <input data-workspace-name="${index}" value="${escapeHtml(workspace.name)}" placeholder="Workspace name" />
        </label>
        <label>
          <span>Path</span>
          <input data-workspace-path="${index}" value="${escapeHtml(workspace.path)}" placeholder="Workspace path" />
        </label>
      </article>
    `;
  }).join("");

  return `
    <section class="page-section settings-workspace-layout">
      <section class="panel workspace-list-panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Workspaces</p>
            <h3>Workspace Presets</h3>
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
            <p class="eyebrow">Selected Workspace</p>
            <h3>${escapeHtml(current?.name || "No workspace selected")}</h3>
            <p class="muted">Workspace changes stay local to this page until you save them.</p>
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
  `;
}

function renderSettingsPage(): string {
  const config = currentConfig();
  const options = modelOptions(config);
  const channels = configuredChannelList(config);
  const internalChannels = ["status", "system", "control"];
  const agentRows = (config.agents || []).map((agent: AnyObject, index: number) => `
    <article class="agent-editor-card">
      <div class="workspace-row-head">
        <strong>${escapeHtml(agent.name)}</strong>
        <button class="ghost tiny" data-remove-agent="${index}">Delete</button>
      </div>
      <div class="two-col-grid">
        <label>
          <span>Name</span>
          <input data-agent-name="${index}" value="${escapeHtml(agent.name)}" placeholder="Agent name" />
        </label>
        <label>
          <span>Role</span>
          ${renderRoleSelect(`data-agent-role="${index}"`, String(agent.role || "research"))}
        </label>
      </div>
      <div class="two-col-grid">
        <label>
          <span>Publish channel</span>
          ${renderChannelSelect(`data-agent-channel="${index}"`, channels, String(agent.publishChannel || ""), "Select publish channel")}
        </label>
        <label>
          <span>Listen channels</span>
          ${renderListenChannelPicker(index, channels, Array.isArray(agent.listenChannels) ? agent.listenChannels : [])}
        </label>
      </div>
      <label>
        <span>Model</span>
        ${renderModelSelect(`data-agent-model="${index}"`, options, agent.model, "Use default model")}
      </label>
      <label>
        <span>Brief</span>
        <textarea data-agent-brief="${index}" placeholder="Agent brief">${escapeHtml(agent.brief)}</textarea>
      </label>
    </article>
  `).join("");

  return `
    <section class="page-section split-layout">
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Runtime</p>
            <h3>Codex Runtime Settings</h3>
          </div>
          <button id="save-runtime-team" class="primary">Save Runtime & Team</button>
        </div>
        <div class="settings-form-grid">
          <label><span>Language</span><input id="cfg-language" value="${escapeHtml(config.defaults.language)}" /></label>
          <label><span>Server Host</span><input id="cfg-host" value="${escapeHtml(config.defaults.serverHost)}" /></label>
          <label><span>Server Port</span><input id="cfg-port" value="${escapeHtml(String(config.defaults.serverPort))}" /></label>
          <label><span>History Tail</span><input id="cfg-history-tail" value="${escapeHtml(String(config.defaults.historyTail))}" /></label>
          <label class="wide"><span>Codex Command</span><input id="cfg-codex-command" value="${escapeHtml(config.defaults.codexCommand)}" /></label>
          <label><span>Default Model</span>${renderModelSelect('id="cfg-model"', options, config.defaults.model, "No default model")}</label>
          <label><span>Sandbox</span>
            <select id="cfg-sandbox">
              ${["read-only", "workspace-write", "danger-full-access"].map((item) => `<option value="${item}" ${config.defaults.sandbox === item ? "selected" : ""}>${item}</option>`).join("")}
            </select>
          </label>
          <label><span>Approval</span>
            <select id="cfg-approval">
              ${["untrusted", "on-request", "on-failure", "never"].map((item) => `<option value="${item}" ${config.defaults.approvalPolicy === item ? "selected" : ""}>${item}</option>`).join("")}
            </select>
          </label>
          <div class="wide auto-models-box">
            <div class="section-head tight">
              <div>
                <span>Detected Models</span>
                <p class="muted">${escapeHtml(modelCatalogSummary())}</p>
              </div>
              <button id="refresh-models" class="ghost tiny">Reload</button>
            </div>
            <pre>${escapeHtml(options.join("\n") || "No models detected yet.")}</pre>
          </div>
          <label class="check-line"><input id="cfg-search" type="checkbox" ${config.defaults.search ? "checked" : ""} /><span>Allow internet search</span></label>
          <label class="check-line"><input id="cfg-dangerous" type="checkbox" ${config.defaults.dangerousBypass ? "checked" : ""} /><span>Dangerous bypass</span></label>
        </div>
      </section>
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Channels</p>
            <h3>Workflow Channels</h3>
            <p class="muted">Rename the workflow channels here. Internal channels stay reserved.</p>
          </div>
        </div>
        <div class="settings-form-grid">
          <label><span>Goal channel</span><input id="cfg-goal-channel" value="${escapeHtml(config.defaults.goalChannel || "goal")}" /></label>
          <label><span>Research channel</span><input id="cfg-research-channel" value="${escapeHtml(config.defaults.researchChannel || "research")}" /></label>
          <label><span>Implementation channel</span><input id="cfg-implementation-channel" value="${escapeHtml(config.defaults.implementationChannel || "implementation")}" /></label>
          <label><span>Review channel</span><input id="cfg-review-channel" value="${escapeHtml(config.defaults.reviewChannel || "review")}" /></label>
          <label><span>Operator channel</span><input id="cfg-operator-channel" value="${escapeHtml(config.defaults.operatorChannel || "operator")}" /></label>
          <label class="wide">
            <span>Extra channels</span>
            <textarea id="cfg-extra-channels" placeholder="one channel per line or comma-separated">${escapeHtml((config.defaults.extraChannels || []).join("\n"))}</textarea>
          </label>
          <div class="wide auto-models-box">
            <div class="section-head tight">
              <div>
                <span>Current channel list</span>
                <p class="muted">These are the values shown to agents when editing publish/listen channels.</p>
              </div>
            </div>
            <pre>${escapeHtml(channels.join("\n") || "-")}</pre>
          </div>
          <div class="wide auto-models-box">
            <div class="section-head tight">
              <div>
                <span>Internal channels</span>
                <p class="muted">Reserved for runtime and logging.</p>
              </div>
            </div>
            <pre>${escapeHtml(internalChannels.join("\n"))}</pre>
          </div>
        </div>
      </section>
    </section>
    <section class="page-section">
      <section class="panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Agents</p>
            <h3>Team Presets</h3>
            <p class="muted">Roles control agent behavior. Publish and listen channels are fully editable here.</p>
          </div>
          <div class="inline-actions">
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
  const targetOptions = [`<option value="">All agents</option>`, ...agents.map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}</option>`)].join("");

  return `
    <section class="panel session-hero">
      <div>
        <p class="eyebrow">Session Detail</p>
        <h3>${escapeHtml(session.title)}</h3>
        <p class="goal-copy">${escapeHtml(session.goal)}</p>
      </div>
      <div class="hero-meta">
        <span class="status-pill ${escapeHtml(session.status)}">${escapeHtml(session.status)}</span>
        <span>${escapeHtml(session.workspaceName)}</span>
        <span>${escapeHtml(session.workspacePath)}</span>
      </div>
    </section>
    <section class="summary-row">
      <article class="metric-card panel"><span class="metric-label">Events</span><strong>${escapeHtml(String(session.eventCount))}</strong></article>
      <article class="metric-card panel"><span class="metric-label">Waiting Input</span><strong>${escapeHtml(String(waiting))}</strong></article>
      <article class="metric-card panel"><span class="metric-label">Errors</span><strong>${escapeHtml(String(errors))}</strong></article>
      <article class="metric-card panel"><span class="metric-label">Completed Agents</span><strong>${escapeHtml(String(done))}</strong></article>
      <article class="metric-card panel"><span class="metric-label">Input Tokens</span><strong>${escapeHtml(formatTokenCount(tokenValue(session.totalUsage, "inputTokens")))}</strong></article>
      <article class="metric-card panel"><span class="metric-label">Cached Tokens</span><strong>${escapeHtml(formatTokenCount(tokenValue(session.totalUsage, "cachedInputTokens")))}</strong></article>
      <article class="metric-card panel"><span class="metric-label">Output Tokens</span><strong>${escapeHtml(formatTokenCount(tokenValue(session.totalUsage, "outputTokens")))}</strong></article>
    </section>
    <section class="panel command-deck">
      <div class="section-head">
        <div>
          <p class="eyebrow">Operator</p>
          <h3>Live Session Commands</h3>
        </div>
        <div class="inline-actions">
          <button data-nav="/" class="ghost">Dashboard</button>
          <button id="session-refresh" class="ghost">Refresh Snapshot</button>
        </div>
      </div>
      <div class="command-layout">
        <textarea id="session-command" placeholder="${isStopped ? "Resume this session to send new instructions" : "Enter a new goal or an additional instruction"}" ${isStopped ? "disabled" : ""}></textarea>
        <div class="command-controls">
          <label>
            <span>Instruction Target</span>
            <select id="session-target" ${isStopped ? "disabled" : ""}>${targetOptions}</select>
          </label>
          <button id="session-send-goal" class="primary" ${isStopped ? "disabled" : ""}>Replace Goal</button>
          <button id="session-send-operator" ${isStopped ? "disabled" : ""}>Send Instruction</button>
          ${isStopped ? `<button id="session-resume" class="primary">Resume Session</button>` : `<button id="session-stop" class="ghost danger">Stop Session</button>`}
        </div>
      </div>
    </section>
    <section class="session-layout">
      <section class="panel feed-column">
        <div class="section-head">
          <h3>Team Feed</h3>
          <p class="muted">Live collaboration log</p>
        </div>
        <div class="feed-list tall" data-feed-list="1" data-scroll-key="team-feed" data-scroll-mode="prepend">${renderSessionFeed(session.id)}</div>
      </section>
      <section class="agent-column">
        <section class="panel">
          <div class="section-head">
            <div>
              <p class="eyebrow">Agents</p>
              <h3>Agent Selector</h3>
            </div>
            <p class="muted">View one agent at a time.</p>
          </div>
          <div class="agent-picker">
            ${agents.map(renderAgentPickerItem).join("")}
          </div>
        </section>
        ${selectedAgent ? renderFocusedAgentCard(session.id, selectedAgent) : `<section class="panel empty-panel"><p class="muted">No agent selected.</p></section>`}
      </section>
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
          <p class="eyebrow">Selected Agent</p>
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
      <div class="inline-actions input-actions">
        <button data-agent-input="${escapeHtml(agent.id)}:1">1</button>
        <button data-agent-input="${escapeHtml(agent.id)}:2">2</button>
        <button data-agent-input="${escapeHtml(agent.id)}:3">3</button>
        <input data-agent-custom="${escapeHtml(agent.id)}" placeholder="custom input" />
        <button data-agent-send="${escapeHtml(agent.id)}" class="primary">Send</button>
      </div>
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
  if (meta.directInput) {
    metaBits.push("direct input");
  }
  return `
    <article class="feed-item">
      <header>
        <strong>${escapeHtml(event.sender)}</strong>
        <span>${escapeHtml(event.channel)}</span>
      </header>
      ${metaBits.length > 0 ? `<div class="feed-meta">${metaBits.map((bit) => `<span class="feed-badge">${escapeHtml(bit)}</span>`).join("")}</div>` : ""}
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
      <div class="inline-actions input-actions">
        <button data-agent-input="${escapeHtml(agent.id)}:1">1</button>
        <button data-agent-input="${escapeHtml(agent.id)}:2">2</button>
        <button data-agent-input="${escapeHtml(agent.id)}:3">3</button>
        <input data-agent-custom="${escapeHtml(agent.id)}" placeholder="custom input" />
        <button data-agent-send="${escapeHtml(agent.id)}" class="primary">Send</button>
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
    quickCreate.onclick = () => void withGuard(quickCreateWorkspace());
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
      const role = "research";
      agents.push({
        id: `agent_${nextIndex}`,
        name: `agent_${nextIndex}`,
        role,
        brief: "Research independently and share novel findings.",
        publishChannel: defaultPublishChannelForRole(role, config),
        listenChannels: defaultListenChannelsForRole(role, config),
        maxTurns: 0,
        model: null,
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
  const name = window.prompt("Workspace name");
  if (!name?.trim()) {
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
  state.selectedWorkspaceName = name.trim();
  setFlash("info", `Workspace created: ${name.trim()}`);
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
  ensureSelectedWorkspace();
  setFlash("info", "Runtime and team settings saved.");
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
  current.defaults.model = qs<HTMLSelectElement>("#cfg-model").value.trim() || null;
  current.defaults.modelOptions = [];
  current.defaults.goalChannel = qs<HTMLInputElement>("#cfg-goal-channel").value.trim() || "goal";
  current.defaults.researchChannel = qs<HTMLInputElement>("#cfg-research-channel").value.trim() || "research";
  current.defaults.implementationChannel = qs<HTMLInputElement>("#cfg-implementation-channel").value.trim() || "implementation";
  current.defaults.reviewChannel = qs<HTMLInputElement>("#cfg-review-channel").value.trim() || "review";
  current.defaults.operatorChannel = qs<HTMLInputElement>("#cfg-operator-channel").value.trim() || "operator";
  current.defaults.extraChannels = parseChannelListInput(qs<HTMLTextAreaElement>("#cfg-extra-channels").value);
  current.defaults.sandbox = qs<HTMLSelectElement>("#cfg-sandbox").value;
  current.defaults.approvalPolicy = qs<HTMLSelectElement>("#cfg-approval").value;
  current.defaults.search = qs<HTMLInputElement>("#cfg-search").checked;
  current.defaults.dangerousBypass = qs<HTMLInputElement>("#cfg-dangerous").checked;
  current.agents = Array.from(document.querySelectorAll<HTMLElement>(".agent-editor-card")).map((row, index) => {
    const name = (row.querySelector("[data-agent-name]") as HTMLInputElement)?.value.trim() || `agent_${index + 1}`;
    const role = (row.querySelector("[data-agent-role]") as HTMLSelectElement)?.value.trim() || "research";
    const model = (row.querySelector("[data-agent-model]") as HTMLSelectElement)?.value.trim() || null;
    const publishChannel = remapSemanticChannel(
      (row.querySelector("[data-agent-channel]") as HTMLSelectElement)?.value.trim() || defaultPublishChannelForRole(role, current),
      previousDefaults,
      current.defaults,
    ) || defaultPublishChannelForRole(role, current);
    const listenChannels = Array.from(row.querySelectorAll<HTMLInputElement>('[data-agent-listen-option]'))
      .filter((input) => input.checked)
      .map((input) => input.value.trim())
      .map((value) => remapSemanticChannel(value, previousDefaults, current.defaults))
      .filter(Boolean);
    return {
      id: name.replace(/[^a-zA-Z0-9_]+/g, "_").toLowerCase(),
      name,
      role,
      publishChannel,
      brief: (row.querySelector("[data-agent-brief]") as HTMLTextAreaElement)?.value.trim() || "Research independently and share novel findings.",
      listenChannels: listenChannels.length > 0 ? listenChannels : defaultListenChannelsForRole(role, current),
      maxTurns: 0,
      model,
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
  document.querySelectorAll<HTMLButtonElement>("[data-agent-input]").forEach((button) => {
    button.onclick = () => {
      const [agentId, text] = (button.dataset.agentInput || "").split(":");
      void withGuard(sendAgentInput(agentId, text));
    };
  });
  document.querySelectorAll<HTMLButtonElement>("[data-agent-send]").forEach((button) => {
    button.onclick = () => {
      const agentId = button.dataset.agentSend || "";
      const input = document.querySelector<HTMLInputElement>(`[data-agent-custom="${agentId}"]`);
      void withGuard(sendAgentInput(agentId, input?.value || ""));
      if (input) {
        input.value = "";
      }
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

async function sendAgentInput(agentId: string, text: string): Promise<void> {
  const session = currentSession();
  if (!session || !text.trim()) {
    return;
  }
  const payload = await api(`/api/sessions/${encodeURIComponent(session.id)}/inputs`, {
    method: "POST",
    body: JSON.stringify({ agentId, text }),
  });
  upsertSession(payload.session);
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


















