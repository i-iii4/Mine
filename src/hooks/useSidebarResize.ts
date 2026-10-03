import { useState, useCallback, useRef, useEffect, useLayoutEffect, startTransition } from "react";
import {
  SIDEBAR_MAX_WIDTH_PX,
  sidebarMinWidth,
  sidebarCollapseThreshold,
} from "@/lib/appLayout";
import { getDesignMode, useDesignMode } from "@/lib/designMode";
import { setWindowSidebar } from "@/lib/commands";
import type { SidebarLayout } from "@/types";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_WIDTH = SIDEBAR_MAX_WIDTH_PX;
const CSS_VAR = "--sidebar-width";

// MIN_WIDTH (three equal columns) and COLLAPSE_THRESHOLD (half of min) depend
// on the design variant's chrome; see appLayout.

// ─── Ownership ──────────────────────────────────────────────────────────────
//
// The sidebar belongs to the window, not to the tab (SPEC_TABS.md, В56, В78):
// the backend keeps its layout, first-run width included, and sends every
// change to all tabs of the window and to its tab bar. A tab clamps what it
// receives to what the panel can show, changes it with `setWindowSidebar`
// only when the person does, and shows the change at once; the echo that
// follows says the same. A page that is not a tab (a dev browser route)
// keeps the layout in memory, starting at the minimum.

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function initialLayout(windowSidebar: SidebarLayout | null): { width: number; collapsed: boolean } {
  const design = getDesignMode();
  if (!windowSidebar) return { width: sidebarMinWidth(design), collapsed: false };
  return {
    width: clamp(windowSidebar.width_px, sidebarMinWidth(design), MAX_WIDTH),
    collapsed: windowSidebar.collapsed,
  };
}

function writeCssVar(width: number): void {
  document.documentElement.style.setProperty(CSS_VAR, `${width}px`);
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export interface UseSidebarResizeReturn {
  /** Width used for layout logic (Grid reflow). RAF-throttled during drag. */
  width: number;
  /** Whether the sidebar is collapsed */
  collapsed: boolean;
  /** Whether a drag-resize is in progress */
  isResizing: boolean;
  /** Begin a resize drag (called by handle component) */
  startResize: (startX: number, startWidth: number) => void;
  /** Update width during drag (called on every pointermove) */
  updateResize: (clientX: number) => void;
  /** Finish the resize drag */
  endResize: () => void;
  /** Toggle collapsed/expanded */
  toggleCollapsed: () => void;
}

/**
 * The sidebar's width and collapsed state, and the drag that resizes it.
 * `windowSidebar` is the layout of this tab's window as the backend last sent
 * it (bootstrap, then `window-sidebar-changed`); null for a page that is not
 * a tab.
 */
export function useSidebarResize(windowSidebar: SidebarLayout | null = null): UseSidebarResizeReturn {
  const design = useDesignMode();
  const MIN_WIDTH = sidebarMinWidth(design);
  const COLLAPSE_THRESHOLD = sidebarCollapseThreshold(design);

  const [storedWidth, setStoredWidth] = useState(() => initialLayout(windowSidebar).width);
  const [collapsed, setCollapsed] = useState(() => initialLayout(windowSidebar).collapsed);
  const [isResizing, setIsResizing] = useState(false);
  const [dragWidth, setDragWidth] = useState(() => {
    const { width, collapsed: c } = initialLayout(windowSidebar);
    return c ? 0 : width;
  });

  // The window owns the layout: a change made here goes to the backend, which
  // tells every tab of the window and its tab bar.
  const ownedByWindowRef = useRef(windowSidebar !== null);
  ownedByWindowRef.current = windowSidebar !== null;
  const commit = useCallback((width: number, nextCollapsed: boolean) => {
    if (!ownedByWindowRef.current) return;
    void setWindowSidebar({ width_px: Math.round(width), collapsed: nextCollapsed }).catch((error: unknown) => {
      console.error("Could not store the window's sidebar:", error);
    });
  }, []);

  const startRef = useRef({ startX: 0, startWidth: 0 });
  const rafIdRef = useRef<number | null>(null);
  const pendingWidthRef = useRef(0);
  // Set when the drag itself crosses the collapse point and closes the panel
  // live; the remaining pointer events for that gesture are then ignored.
  const collapsedByDragRef = useRef(false);
  // Live-collapse only after the drag has held a real (≥ threshold) width, so an
  // expand-drag out of the collapsed state isn't killed the instant it starts.
  const armedForCollapseRef = useRef(false);

  // Keep refs in sync so the stable callbacks read fresh values at fire time.
  const storedWidthRef = useRef(storedWidth);
  useEffect(() => { storedWidthRef.current = storedWidth; }, [storedWidth]);
  const minWidthRef = useRef(MIN_WIDTH);
  minWidthRef.current = MIN_WIDTH;
  const collapseRef = useRef(COLLAPSE_THRESHOLD);
  collapseRef.current = COLLAPSE_THRESHOLD;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  // Display width drives React-side consumers (Grid reflow). The actual sidebar
  // layout uses var(--sidebar-width), updated synchronously in updateResize so
  // the panel and its columns follow the cursor at full refresh rate.
  const width = isResizing ? dragWidth : collapsed ? 0 : storedWidth;

  // Mount + sync: seed / update CSS variable before paint.
  useLayoutEffect(() => {
    if (!isResizing) writeCssVar(width);
  }, [width, isResizing]);

  // Design variant change moves the minimum; lift a stored width now below it.
  // The window's stored width is left alone: every page clamps it on arrival.
  useEffect(() => {
    setStoredWidth((w) => clamp(w, MIN_WIDTH, MAX_WIDTH));
  }, [MIN_WIDTH]);

  // The window's layout changed: another tab, the tab bar's button, the View
  // menu or the two-finger swipe (В56). A drag in progress here keeps the
  // panel under the pointer; its own result follows when it ends.
  const isResizingRef = useRef(isResizing);
  isResizingRef.current = isResizing;
  const windowWidth = windowSidebar?.width_px;
  const windowCollapsed = windowSidebar?.collapsed;
  useEffect(() => {
    if (windowWidth === undefined || windowCollapsed === undefined || isResizingRef.current) return;
    setStoredWidth(clamp(windowWidth, minWidthRef.current, MAX_WIDTH));
    setCollapsed(windowCollapsed);
  }, [windowCollapsed, windowWidth]);

  const startResize = useCallback((startX: number, startWidth: number) => {
    startRef.current = { startX, startWidth };
    pendingWidthRef.current = startWidth;
    collapsedByDragRef.current = false;
    // Armed only when starting from a real width. Starting collapsed (width 0)
    // means this is an expand-drag — follow the cursor out, don't re-collapse it.
    armedForCollapseRef.current = startWidth >= collapseRef.current;
    if (collapsedRef.current) setCollapsed(false);
    setDragWidth(startWidth);
    setIsResizing(true);
    document.body.classList.add("sidebar-resizing");
  }, []);

  const updateResize = useCallback((clientX: number) => {
    if (collapsedByDragRef.current) return;
    const { startX, startWidth } = startRef.current;
    const raw = startWidth + (clientX - startX);
    const next = clamp(raw, 0, MAX_WIDTH);

    // Once the drag reaches a real width, arm live-collapse for the way back.
    if (next >= collapseRef.current) armedForCollapseRef.current = true;

    if (armedForCollapseRef.current && next < collapseRef.current) {
      // Past the <1-icon point — collapse at once. No rubber-band through a
      // near-empty icon column; the rest of this gesture is ignored.
      collapsedByDragRef.current = true;
      pendingWidthRef.current = next;
      setIsResizing(false);
      setCollapsed(true);
      commit(storedWidthRef.current, true);
      document.body.classList.remove("sidebar-resizing");
      return;
    }

    // Above the collapse point: follow the cursor 1:1 (rubber-band band snaps
    // back to the minimum on release; above the minimum it stays put).
    writeCssVar(next);
    pendingWidthRef.current = next;

    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        const pending = pendingWidthRef.current;
        startTransition(() => {
          setDragWidth(pending);
        });
      });
    }
  }, [commit]);

  const endResize = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (collapsedByDragRef.current) {
      // The drag already collapsed the panel live — nothing to settle.
      collapsedByDragRef.current = false;
      return;
    }
    setIsResizing(false);
    document.body.classList.remove("sidebar-resizing");

    const finalWidth = pendingWidthRef.current;
    if (finalWidth < collapseRef.current) {
      // Safety net if a fast gesture skipped the live-collapse check.
      setCollapsed(true);
      setDragWidth(storedWidthRef.current);
      commit(storedWidthRef.current, true);
    } else {
      // Within the rubber-band band (or above) — snap to at least the minimum.
      const clamped = clamp(finalWidth, minWidthRef.current, MAX_WIDTH);
      setCollapsed(false);
      setStoredWidth(clamped);
      setDragWidth(clamped);
      commit(clamped, false);
    }
  }, [commit]);

  const toggleCollapsed = useCallback(() => {
    const next = !collapsedRef.current;
    collapsedRef.current = next;
    setCollapsed(next);
    commit(storedWidthRef.current, next);
  }, [commit]);

  // Cleanup pending RAF on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  return { width, collapsed, isResizing, startResize, updateResize, endResize, toggleCollapsed };
}
