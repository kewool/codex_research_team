const PAGE_SIZE_BY_KIND = {
    rail: 16,
    dashboard: 24,
};
function defaultListState(kind) {
    return {
        visibleCount: PAGE_SIZE_BY_KIND[kind],
        hasMore: true,
        loading: false,
        bottomLoadLocked: false,
        scrollTop: 0,
    };
}
export function createSessionListTools(deps) {
    const { state } = deps;
    function ensureSessionLists() {
        if (!state.sessionLists) {
            state.sessionLists = {
                rail: defaultListState("rail"),
                dashboard: defaultListState("dashboard"),
            };
        }
        return state.sessionLists;
    }
    function sessionListState(kind) {
        const lists = ensureSessionLists();
        if (!lists[kind]) {
            lists[kind] = defaultListState(kind);
        }
        return lists[kind];
    }
    function allSessions() {
        return Array.isArray(state.snapshot?.sessions) ? state.snapshot.sessions : [];
    }
    function visibleSessions(kind) {
        const current = sessionListState(kind);
        return allSessions().slice(0, current.visibleCount);
    }
    function sessionsMeta(kind) {
        const all = allSessions();
        const current = sessionListState(kind);
        const shownCount = Math.min(current.visibleCount, all.length);
        return {
            shownCount,
            totalCount: all.length,
            hasMore: shownCount < all.length,
        };
    }
    function loadMoreSessions(kind) {
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
    function updateSessionListScroll(kind, scrollTop) {
        sessionListState(kind).scrollTop = Math.max(0, scrollTop || 0);
    }
    function restoreSessionListScrolls() {
        const lists = ensureSessionLists();
        Object.keys(lists).forEach((kind) => {
            const element = document.querySelector(`[data-session-list-kind="${kind}"]`);
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
