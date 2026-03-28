type AnyObject = Record<string, any>;

type SessionCacheDeps = {
  state: AnyObject;
  api: (path: string, init?: RequestInit) => Promise<any>;
  scheduleRender: () => void;
  currentSession: () => AnyObject | null;
  ensureSelectedAgent: (session: AnyObject) => AnyObject | null;
  currentAgentTab: () => string;
  historyKindForTab: (tab: string) => string;
  historyPageSize: (kind: string) => number;
  maxVisibleHistoryItems: (kind: string) => number;
  tailClientText: (value: unknown, maxChars?: number) => string;
  withGuard: (task: Promise<void>) => Promise<void>;
  FEED_PAGE_SIZE: number;
  MAX_VISIBLE_FEED_ITEMS: number;
};

export function createSessionCacheTools(deps: SessionCacheDeps) {
  const {
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
  } = deps;

  function blankPageCache(): AnyObject {
    return {
      items: [],
      nextBefore: null,
      hasMore: false,
      serverHasMore: false,
      overflowBackfill: false,
      loaded: false,
      loading: false,
      lastLoadedBefore: null,
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

  function recomputePageHasMore(cache: AnyObject): void {
    cache.hasMore = Boolean(cache.serverHasMore || cache.overflowBackfill);
    if (!cache.hasMore) {
      cache.nextBefore = null;
    }
  }

  function refreshPageCursor(cache: AnyObject): void {
    if (!cache.serverHasMore && !cache.overflowBackfill) {
      cache.nextBefore = null;
      return;
    }
    const cursors = (cache.items || [])
      .map((item: AnyObject) => Number(item?._cursor))
      .filter((value: number) => Number.isFinite(value) && value > 0 && value < Number.MAX_SAFE_INTEGER);
    if (cursors.length === 0) {
      cache.nextBefore = null;
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
      cache.serverHasMore = false;
      cache.overflowBackfill = false;
      cache.loaded = false;
      cache.lastLoadedBefore = null;
    }
    const before = options.reset ? null : cache.nextBefore;
    const requestCursor = before == null ? "__latest__" : String(before);
    if (!options.reset && !options.force && cache.loaded && cache.lastLoadedBefore === requestCursor) {
      return;
    }
    cache.loading = true;
    cache.error = null;
    if (state.route.name === "session" && state.route.sessionId === sessionId) {
      scheduleRender();
    }
    try {
      const payload = await api(`/api/sessions/${encodeURIComponent(sessionId)}/feed?limit=${FEED_PAGE_SIZE}${before ? `&before=${encodeURIComponent(String(before))}` : ""}`);
      const nextItems = Array.isArray(payload.items) ? payload.items : [];
      cache.items = options.reset
        ? nextItems
        : [...cache.items, ...nextItems.filter((item: AnyObject) => !cache.items.some((current: AnyObject) => eventKey(current) === eventKey(item)))];
      cache.serverHasMore = Boolean(payload.hasMore);
      cache.overflowBackfill = false;
      cache.nextBefore = payload.nextBefore ?? null;
      cache.lastLoadedBefore = requestCursor;
      cache.loaded = true;
      refreshPageCursor(cache);
      recomputePageHasMore(cache);
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
      cache.serverHasMore = false;
      cache.overflowBackfill = false;
      cache.loaded = false;
      cache.lastLoadedBefore = null;
    }
    const before = options.reset ? null : cache.nextBefore;
    const requestCursor = before == null ? "__latest__" : String(before);
    if (!options.reset && !options.force && cache.loaded && cache.lastLoadedBefore === requestCursor) {
      return;
    }
    cache.loading = true;
    cache.error = null;
    if (state.route.name === "session" && state.route.sessionId === sessionId) {
      scheduleRender();
    }
    try {
      const payload = await api(`/api/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/history?kind=${encodeURIComponent(kind)}&limit=${historyPageSize(kind)}${before ? `&before=${encodeURIComponent(String(before))}` : ""}`);
      const nextItems = Array.isArray(payload.items) ? payload.items : [];
      cache.items = options.reset
        ? nextItems
        : [...cache.items, ...nextItems.filter((item: AnyObject) => !cache.items.some((current: AnyObject) => historyEntryKey(current) === historyEntryKey(item)))];
      cache.serverHasMore = Boolean(payload.hasMore);
      cache.overflowBackfill = false;
      cache.nextBefore = payload.nextBefore ?? null;
      cache.lastLoadedBefore = requestCursor;
      cache.loaded = true;
      cache.items = (cache.items || []).slice(0, maxVisibleHistoryItems(kind));
      refreshPageCursor(cache);
      recomputePageHasMore(cache);
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
    const merged = uniqueItems([event, ...(cache.items || [])], eventKey);
    cache.items = merged.slice(0, MAX_VISIBLE_FEED_ITEMS);
    cache.loaded = true;
    cache.overflowBackfill = cache.overflowBackfill || merged.length > MAX_VISIBLE_FEED_ITEMS;
    refreshPageCursor(cache);
    recomputePageHasMore(cache);
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
    const merged = uniqueItems([liveEntry, ...(cache.items || [])], historyEntryKey);
    cache.items = merged.slice(0, maxVisibleHistoryItems(kind));
    cache.loaded = true;
    cache.overflowBackfill = cache.overflowBackfill || merged.length > maxVisibleHistoryItems(kind);
    refreshPageCursor(cache);
    recomputePageHasMore(cache);
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

  return {
    agentHistoryCache,
    appendAgentStreamTail,
    blankPageCache,
    ensureSessionData,
    ensureSessionPageData,
    eventKey,
    feedCache,
    historyEntryKey,
    loadAgentHistory,
    loadSessionFeed,
    loadVisibleAgentHistory,
    prependFeedEvent,
    prependLiveHistory,
    recomputePageHasMore,
    refreshPageCursor,
    uniqueItems,
    upsertAgentSnapshot,
  };
}
