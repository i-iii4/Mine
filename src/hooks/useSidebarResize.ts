import { useState, useCallback, useRef, useEffect, useLayoutEffect, startTransition } from "react";

// ─── Constants ──────────────────────────────────────────────────────────────

const STORAGE_KEY = "arena:sidebar";
const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 220;
const MAX_WIDTH = 600;
const COLLAPSE_THRESHOLD = 100;
const CSS_VAR = "--sidebar-width";

// ─── Persistence ────────────────────────────────────────────────────────────

interface SidebarPersisted {
  width: number;
  collapsed: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function loadPersisted(): SidebarPersisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { width: DEFAULT_WIDTH, collapsed: false };
    const parsed = JSON.parse(raw);
    if (typeof parsed.width !== "number" || typeof parsed.collapsed !== "boolean") {
      return { width: DEFAULT_WIDTH, collapsed: false };
    }
    return {
      width: clamp(parsed.width, MIN_WIDTH, MAX_WIDTH),
      collapsed: parsed.collapsed,
    };
  } catch {
    return { width: DEFAULT_WIDTH, collapsed: false };
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
  /** Width used for layout logic (compact mode, Grid reflow). RAF-throttled during drag. */
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
  const [storedWidth, setStoredWidth] = useState(() => loadPersisted().width);
  const [collapsed, setCollapsed] = useState(() => loadPersisted().collapsed);
  const [isResizing, setIsResizing] = useState(false);
  const [dragWidth, setDragWidth] = useState(() => {
    const { width, collapsed: c } = loadPersisted();
    return c ? 0 : width;
  });

  const startRef = useRef({ startX: 0, startWidth: 0 });
  const rafIdRef = useRef<number | null>(null);
  const pendingWidthRef = useRef(0);

  // Keep a ref in sync for toggleCollapsed to read fresh width
  const storedWidthRef = useRef(storedWidth);
  useEffect(() => { storedWidthRef.current = storedWidth; }, [storedWidth]);

  // Display width drives React-side consumers (compact flag, Grid reflow).
  // The actual sidebar/handle layout uses var(--sidebar-width), updated synchronously
  // in updateResize so the divider follows the cursor at full refresh rate.
  const width = isResizing ? dragWidth : collapsed ? 0 : storedWidth;

  // Mount + sync: seed / update CSS variable before paint.
  // useLayoutEffect runs after commit but before browser paint, so first frame
  // always shows the correct sidebar width with no flicker.
  useLayoutEffect(() => {
    if (!isResizing) writeCssVar(width);
  }, [width, isResizing]);

  const startResize = useCallback((startX: number, startWidth: number) => {
    startRef.current = { startX, startWidth };
    pendingWidthRef.current = startWidth;
    setDragWidth(startWidth);
    setIsResizing(true);
    document.body.classList.add("sidebar-resizing");
  }, []);

  const updateResize = useCallback((clientX: number) => {
    const { startX, startWidth } = startRef.current;
    const raw = startWidth + (clientX - startX);
    const next = clamp(raw, 0, MAX_WIDTH);

    // Synchronous DOM write: divider line follows cursor at 120fps,
    // bypassing React reconciliation entirely.
    writeCssVar(next);
    pendingWidthRef.current = next;

    // Async React-state commit: RAF-throttled + startTransition so Grid
    // reflow happens lazily without blocking pointer events.
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

    const finalWidth = pendingWidthRef.current;
    if (finalWidth < COLLAPSE_THRESHOLD) {
      // Collapse — keep storedWidth unchanged for re-expand.
      setCollapsed(true);
      setDragWidth(storedWidthRef.current);
      persist(storedWidthRef.current, true);
    } else {
      const clamped = clamp(finalWidth, MIN_WIDTH, MAX_WIDTH);
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
