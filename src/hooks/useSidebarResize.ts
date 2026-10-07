import { useState, useCallback, useRef, useEffect, useLayoutEffect, startTransition } from "react";
import {
  SIDEBAR_MAX_WIDTH_PX,
  sidebarMinWidth,
} from "@/lib/appLayout";
import { getDesignMode, useDesignMode } from "@/lib/designMode";
import { setWindowSidebar } from "@/lib/commands";
import type { SidebarLayout } from "@/types";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_WIDTH = SIDEBAR_MAX_WIDTH_PX;
const CSS_VAR = "--sidebar-width";

// MIN_WIDTH (three equal columns) depends on the design variant's chrome; see
// appLayout. A drag keeps the panel between it and MAX_WIDTH: it never
// collapses the panel, which the sidebar button and its hotkey do (user's
// decision of 07.10.2026).

// ─── Ownership ──────────────────────────────────────────────────────────────
//
// Every tab has its own sidebar, kept by the backend between sessions in
// windows.json; a new tab opens with the sidebar of the tab it was opened from
// (SPEC_TABS.md, В56). A tab clamps what it receives to what the panel can
// show, changes it with `setWindowSidebar` only when the person does, and
// shows the change at once; the echo that follows says the same. A page that
// is not a tab (a dev browser route) keeps the layout in memory, starting at
// the minimum.

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
  /** The bounds a drag and the keyboard keep the panel in. */
  minWidth: number;
  maxWidth: number;
  /** Begin a resize drag (called by handle component) */
  startResize: (startX: number, startWidth: number) => void;
  /** Update width during drag (called on every pointermove) */
  updateResize: (clientX: number) => void;
  /** Finish the resize drag */
  endResize: () => void;
  /** Set the width at once (the handle's keyboard), clamped to the bounds */
  resizeTo: (width: number) => void;
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

  // Keep refs in sync so the stable callbacks read fresh values at fire time.
  const storedWidthRef = useRef(storedWidth);
  useEffect(() => { storedWidthRef.current = storedWidth; }, [storedWidth]);
  const minWidthRef = useRef(MIN_WIDTH);
  minWidthRef.current = MIN_WIDTH;
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
    setDragWidth(startWidth);
    setIsResizing(true);
    document.body.classList.add("sidebar-resizing");
  }, []);

  // The line follows the cursor 1:1 between the bounds and stops at them.
  const updateResize = useCallback((clientX: number) => {
    const { startX, startWidth } = startRef.current;
    const next = clamp(startWidth + (clientX - startX), minWidthRef.current, MAX_WIDTH);
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
  }, []);

  const endResize = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    setIsResizing(false);
    document.body.classList.remove("sidebar-resizing");
    const finalWidth = clamp(pendingWidthRef.current, minWidthRef.current, MAX_WIDTH);
    setStoredWidth(finalWidth);
    setDragWidth(finalWidth);
    commit(finalWidth, false);
  }, [commit]);

  const resizeTo = useCallback((nextWidth: number) => {
    const next = clamp(nextWidth, minWidthRef.current, MAX_WIDTH);
    setStoredWidth(next);
    commit(next, collapsedRef.current);
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

  return {
    width,
    collapsed,
    isResizing,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
    startResize,
    updateResize,
    endResize,
    resizeTo,
    toggleCollapsed,
  };
}
