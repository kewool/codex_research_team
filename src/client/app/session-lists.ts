type AnyObject = Record<string, any>;

export type SessionListKind = "rail" | "dashboard";

type SessionListState = {
  visibleCount: number;
  hasMore: boolean;
  loading: boolean;
  bottomLoadLocked: boolean;
  scrollTop: number;
};

type SessionListDeps = {
  state: AnyObject;
};

const PAGE_SIZE_BY_KIND: Record<SessionListKind, number> = {
  rail: 16,
  dashboard: 24,
};

function defaultListState(kind: SessionListKind): SessionListState {
  return {
    visibleCount: PAGE_SIZE_BY_KIND[kind],
    hasMore: true,
    loading: false,
    bottomLoadLocked: false,
    scrollTop: 0,
  };
}

export function createSessionListTools(deps: SessionListDeps) {
  const { state } = deps;

  function ensureSessionLists(): Record<SessionListKind, SessionListState> {
    if (!state.sessionLists) {
      state.sessionLists = {
        rail: defaultListState("rail"),
        dashboard: defaultListState("dashboard"),
      };
    }
    return state.sessionLists;
  }

  function sessionListState(kind: SessionListKind): SessionListState {
    const lists = ensureSessionLists();
    if (!lists[kind]) {
      lists[kind] = defaultListState(kind);
    }
    return lists[kind];
  }

  function allSessions(): AnyObject[] {
    return Array.isArray(state.snapshot?.sessions) ? state.snapshot.sessions : [];
  }

  function visibleSessions(kind: SessionListKind): AnyObject[] {
    const current = sessionListState(kind);
    return allSessions().slice(0, current.visibleCount);
  }

  function sessionsMeta(kind: SessionListKind): {
    shownCount: number;
    totalCount: number;
    hasMore: boolean;
  } {
    const all = allSessions();
    const current = sessionListState(kind);
    const shownCount = Math.min(current.visibleCount, all.length);
    return {
      shownCount,
      totalCount: all.length,
      hasMore: shownCount < all.length,
    };
  }

  function loadMoreSessions(kind: SessionListKind): boolean {
    const current = sessionListState(kind);
    const { totalCount } = sessionsMeta(kind);
    if (current.visibleCount >= totalCount) {
      current.hasMore = false;
      return false;
    }
    current.visibleCount = Math.min(totalCount, current.visibleCount + PAGE_SIZE_BY_KIND[kind]);
    current.hasMore = current.visibleCount < totalCount;
    return true;
  }

  function updateSessionListScroll(kind: SessionListKind, scrollTop: number): void {
    sessionListState(kind).scrollTop = Math.max(0, scrollTop || 0);
  }

  function restoreSessionListScrolls(): void {
    const lists = ensureSessionLists();
    (Object.keys(lists) as SessionListKind[]).forEach((kind) => {
      const element = document.querySelector<HTMLElement>(`[data-session-list-kind="${kind}"]`);
      if (!element) {
        return;
      }
      element.scrollTop = Math.max(0, lists[kind].scrollTop || 0);
    });
  }

  return {
    loadMoreSessions,
    restoreSessionListScrolls,
    sessionListState,
    sessionsMeta,
    updateSessionListScroll,
    visibleSessions,
  };
}
