import { useState, useCallback, useRef, useEffect, useLayoutEffect, startTransition } from "react";
import {
  SIDEBAR_MAX_WIDTH_PX,
  sidebarMinWidth,
  sidebarCollapseThreshold,
  sidebarDefaultWidth,
} from "@/lib/appLayout";
import { getDesignMode, useDesignMode } from "@/lib/designMode";

// ─── Constants ──────────────────────────────────────────────────────────────

const STORAGE_KEY = "arena:sidebar";
const MAX_WIDTH = SIDEBAR_MAX_WIDTH_PX;
const CSS_VAR = "--sidebar-width";

// MIN_WIDTH (three equal columns), COLLAPSE_THRESHOLD (⅔ of min) and the
// first-run DEFAULT all depend on the design variant's chrome — see appLayout.

// ─── Persistence ────────────────────────────────────────────────────────────

interface SidebarPersisted {
  width: number;
  collapsed: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function loadPersisted(minWidth: number, defaultWidth: number): SidebarPersisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { width: defaultWidth, collapsed: false };
    const parsed = JSON.parse(raw);
    if (typeof parsed.width !== "number" || typeof parsed.collapsed !== "boolean") {
      return { width: defaultWidth, collapsed: false };
    }
    return {
      width: clamp(parsed.width, minWidth, MAX_WIDTH),
      collapsed: parsed.collapsed,
    };
  } catch {
    return { width: defaultWidth, collapsed: false };
  }
}

function persist(width: number, collapsed: boolean): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ width, collapsed }));
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

export function useSidebarResize(): UseSidebarResizeReturn {
  const design = useDesignMode();
  const MIN_WIDTH = sidebarMinWidth(design);
  const COLLAPSE_THRESHOLD = sidebarCollapseThreshold(design);

  const [storedWidth, setStoredWidth] = useState(() => {
    const d = getDesignMode();
    return loadPersisted(sidebarMinWidth(d), sidebarDefaultWidth(d)).width;
  });
  const [collapsed, setCollapsed] = useState(() => {
    const d = getDesignMode();
    return loadPersisted(sidebarMinWidth(d), sidebarDefaultWidth(d)).collapsed;
  });
  const [isResizing, setIsResizing] = useState(false);
  const [dragWidth, setDragWidth] = useState(() => {
    const d = getDesignMode();
    const { width, collapsed: c } = loadPersisted(sidebarMinWidth(d), sidebarDefaultWidth(d));
    return c ? 0 : width;
  });

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
  // localStorage is self-correcting (loadPersisted re-clamps on next load).
  useEffect(() => {
    setStoredWidth((w) => clamp(w, MIN_WIDTH, MAX_WIDTH));
  }, [MIN_WIDTH]);

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
      persist(storedWidthRef.current, true);
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
  }, []);

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
      persist(storedWidthRef.current, true);
    } else {
      // Within the rubber-band band (or above) — snap to at least the minimum.
      const clamped = clamp(finalWidth, minWidthRef.current, MAX_WIDTH);
      setCollapsed(false);
      setStoredWidth(clamped);
      setDragWidth(clamped);
      persist(clamped, false);
    }
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      persist(storedWidthRef.current, next);
      return next;
    });
  }, []);

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
