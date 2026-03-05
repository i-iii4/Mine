import { useState, useCallback, useRef, useEffect } from "react";

// ─── Constants ──────────────────────────────────────────────────────────────

const STORAGE_KEY = "arena:sidebar";
const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 220;
const MAX_WIDTH = 480;
const COLLAPSE_THRESHOLD = 100;

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

// ─── Hook ───────────────────────────────────────────────────────────────────

export interface UseSidebarResizeReturn {
  /** Current sidebar width in px. 0 when collapsed. */
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
  // Live width during drag — can go below MIN_WIDTH (down to 0)
  const [dragWidth, setDragWidth] = useState(0);

  const startRef = useRef({ startX: 0, startWidth: 0 });

  // Keep a ref in sync for toggleCollapsed to read fresh width
  const storedWidthRef = useRef(storedWidth);
  useEffect(() => { storedWidthRef.current = storedWidth; }, [storedWidth]);

  // During resize: show live dragWidth. Otherwise: storedWidth or 0 (collapsed).
  const width = isResizing ? Math.max(0, dragWidth) : collapsed ? 0 : storedWidth;

  const startResize = useCallback((startX: number, startWidth: number) => {
    startRef.current = { startX, startWidth };
    setDragWidth(startWidth);
    setIsResizing(true);
    document.body.classList.add("sidebar-resizing");
  }, []);

  const updateResize = useCallback((clientX: number) => {
    const { startX, startWidth } = startRef.current;
    const raw = startWidth + (clientX - startX);
    // Allow width to go to 0 during drag — collapse decision is deferred to endResize
    setDragWidth(Math.max(0, raw));
  }, []);

  const endResize = useCallback(() => {
    setIsResizing(false);
    document.body.classList.remove("sidebar-resizing");

    // Read the latest dragWidth via functional setState pattern
    setDragWidth((finalWidth) => {
      if (finalWidth < COLLAPSE_THRESHOLD) {
        // Collapse — keep storedWidth unchanged for re-expand
        setCollapsed(true);
        persist(storedWidthRef.current, true);
      } else {
        const clamped = clamp(finalWidth, MIN_WIDTH, MAX_WIDTH);
        setCollapsed(false);
        setStoredWidth(clamped);
        persist(clamped, false);
      }
      return finalWidth;
    });
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      persist(storedWidthRef.current, next);
      return next;
    });
  }, []);

  return { width, collapsed, isResizing, startResize, updateResize, endResize, toggleCollapsed };
}
