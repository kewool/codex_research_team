export type ScrollAnchorMode = "append" | "prepend";

export type ScrollAnchorSnapshot = {
  top: number;
  left: number;
  distanceFromBottom: number;
  nearTop: boolean;
  nearBottom: boolean;
  mode: ScrollAnchorMode;
};

export type RenderScrollSnapshot = {
  windowY: number;
  anchors: Record<string, ScrollAnchorSnapshot>;
};

export function createScrollTools(state: any) {
  function saveElementScrollAnchor(element: HTMLElement, modeOverride?: ScrollAnchorMode): void {
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
      mode: modeOverride ?? (element.dataset.scrollMode === "prepend" ? "prepend" : "append"),
    };
  }

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
      saveElementScrollAnchor(element);
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

  return {
    bindSessionScrollMemory,
    captureRenderScrollSnapshot,
    restoreRenderScrollSnapshot,
    saveElementScrollAnchor,
    syncSessionScrollMemoryFromDom,
  };
}
