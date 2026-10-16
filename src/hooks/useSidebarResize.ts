import { useState, useCallback, useRef, useEffect, useLayoutEffect, startTransition } from "react";
import { setWindowSidebar } from "@/lib/commands";
import { motionDuration } from "@/lib/motion";
import {
  clampSidebarTarget,
  sidebarDragBounds,
  sidebarWidthCss,
} from "@/lib/sidebarPlacement";
import type { SidebarLayout } from "@/types";

// ─── Constants ──────────────────────────────────────────────────────────────

const CSS_VAR = "--sidebar-width";
/** How long the sidebar takes to collapse or open by its button. */
export const SIDEBAR_WIDTH_MOTION_MS = 200;

// ─── Ownership ──────────────────────────────────────────────────────────────
//
// Every tab has its own sidebar, kept by the backend between sessions in
// windows.json; a new tab opens with the sidebar of the tab it was opened from
// (SPEC_TABS.md, В56). A tab clamps what it receives to what the panel can
// show, changes it with `setWindowSidebar` only when the person does, and
// shows the change at once; the echo that follows says the same. A page that
// is not a tab (a dev browser route) keeps the layout in memory, starting at
// the minimum.
//
// The stored width is the one the person last dragged the edge to (`S_target`,
// SPEC_NARROW_WINDOW.md, У2). A narrow window squeezes the sidebar below it
// (У1): `--sidebar-width` holds a CSS `min()` of the target and what the
// window leaves beside the narrowest feed, so a window's resize squeezes the
// sidebar without a render and never changes the target. Widening, the
// sidebar grows back to exactly the target.

function initialLayout(windowSidebar: SidebarLayout | null): { width: number; collapsed: boolean } {
  if (!windowSidebar) return { width: clampSidebarTarget(0), collapsed: false };
  return {
    width: clampSidebarTarget(windowSidebar.width_px),
    collapsed: windowSidebar.collapsed,
  };
}

/** The sidebar beside the feed leaving the row or coming back into it as the
 *  window crosses the threshold of the sidebar over the feed. */
type SidebarCrossing = "leave" | "enter";

function writeCssVar(value: string): void {
  document.documentElement.style.setProperty(CSS_VAR, value);
}

/** The width a drag or a key may give the sidebar in the window as it is now. */
function clampToWindow(width: number): number {
  const { min, max } = sidebarDragBounds(window.innerWidth);
  return Math.min(max, Math.max(min, width));
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export interface UseSidebarResizeReturn {
  /** The width the person gave the sidebar, the drag's width while a drag
   *  runs (RAF-throttled), 0 collapsed. A narrow window shows less of it
   *  (`sidebarPlacement`). */
  width: number;
  /** Whether the sidebar is collapsed */
  collapsed: boolean;
  /** Whether a drag-resize is in progress */
  isResizing: boolean;
  /** Whether the sidebar's width is moving to a collapse or an opening, or
   *  out of the row and back as the window crosses the threshold of the
   *  sidebar over the feed: the only times it animates. A window's resize or
   *  a drag moves it at once. */
  widthAnimating: boolean;
  /** The sidebar beside the feed is on the page: always while the window
   *  holds it, and for the motion of its leaving when the window narrows past
   *  the threshold (SPEC_NARROW_WINDOW.md, У7). */
  besideShown: boolean;
  /** Begin a resize drag from the width shown now (called by handle component) */
  startResize: (startX: number, startWidth: number) => void;
  /** Update width during drag (called on every pointermove) */
  updateResize: (clientX: number) => void;
  /** Finish the resize drag */
  endResize: () => void;
  /** Set the width at once (the handle's keyboard), within the window's bounds */
  resizeTo: (width: number) => void;
  /** Toggle collapsed/expanded */
  toggleCollapsed: () => void;
}

/**
 * The sidebar's width and collapsed state, and the drag that resizes it.
 * `windowSidebar` is the layout of this tab's window as the backend last sent
 * it (bootstrap, then `window-sidebar-changed`); null for a page that is not
 * a tab. `overlaid`: the window is too narrow for the sidebar beside the
 * feed (SPEC_NARROW_WINDOW.md, У1); the sidebar takes none of the row then,
 * and lies over the feed when open with a width of its own (SidebarOverlay).
 */
export function useSidebarResize(
  windowSidebar: SidebarLayout | null = null,
  overlaid = false,
): UseSidebarResizeReturn {
  const [storedWidth, setStoredWidth] = useState(() => initialLayout(windowSidebar).width);
  const [collapsed, setCollapsed] = useState(() => initialLayout(windowSidebar).collapsed);
  const [isResizing, setIsResizing] = useState(false);
  const [dragWidth, setDragWidth] = useState(() => {
    const { width, collapsed: c } = initialLayout(windowSidebar);
    return c ? 0 : width;
  });
  const [widthAnimating, setWidthAnimating] = useState(false);

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

  // A collapse or an opening animates the width; the transition is on only
  // for its run, so a window's resize does not trail the sidebar behind the
  // window. Reduced motion keeps it off.
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animateWidth = useCallback(() => {
    const duration = motionDuration(SIDEBAR_WIDTH_MOTION_MS);
    if (duration === 0) return;
    if (animationTimerRef.current !== null) clearTimeout(animationTimerRef.current);
    setWidthAnimating(true);
    animationTimerRef.current = setTimeout(() => {
      animationTimerRef.current = null;
      setWidthAnimating(false);
    }, duration);
  }, []);

  const startRef = useRef({ startX: 0, startWidth: 0 });
  const rafIdRef = useRef<number | null>(null);
  const pendingWidthRef = useRef(0);

  // Keep refs in sync so the stable callbacks read fresh values at fire time.
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  // Display width drives React-side consumers (the handle). The actual sidebar
  // layout uses var(--sidebar-width), updated synchronously in updateResize so
  // the panel and its columns follow the cursor at full refresh rate.
  const width = isResizing ? dragWidth : collapsed ? 0 : storedWidth;

  // The window crosses the threshold of the sidebar over the feed
  // (SPEC_NARROW_WINDOW.md, У7): the sidebar beside the feed leaves the row
  // and comes back with the motion of a collapse and an opening, while the
  // resize itself still moves nothing. Decided in the render that sees the
  // crossing, so a leaving sidebar stays on the page for its motion.
  const [crossing, setCrossing] = useState<SidebarCrossing | null>(null);
  const [lastOverlaid, setLastOverlaid] = useState(overlaid);
  if (overlaid !== lastOverlaid) {
    setLastOverlaid(overlaid);
    const moves = !collapsed && motionDuration(SIDEBAR_WIDTH_MOTION_MS) > 0;
    setCrossing(moves ? (overlaid ? "leave" : "enter") : null);
  }
  useEffect(() => {
    if (crossing === null) return undefined;
    const timer = setTimeout(() => setCrossing(null), SIDEBAR_WIDTH_MOTION_MS);
    return () => clearTimeout(timer);
  }, [crossing]);

  // Mount + sync: seed / update CSS variable before paint. At rest the
  // variable is the squeeze expression; the drag writes plain pixels. Over
  // the feed the sidebar takes none of the row. Coming back into the row it
  // starts from none for a frame, so its width moves in.
  useLayoutEffect(() => {
    if (isResizing) return undefined;
    const target = collapsed || overlaid ? "0px" : sidebarWidthCss(storedWidth);
    if (crossing === "enter") {
      writeCssVar("0px");
      const frame = requestAnimationFrame(() => writeCssVar(target));
      return () => cancelAnimationFrame(frame);
    }
    writeCssVar(target);
    return undefined;
  }, [collapsed, crossing, overlaid, storedWidth, isResizing]);

  // The window's layout changed: another tab, the tab bar's button, the View
  // menu or the two-finger swipe (В56). A drag in progress here keeps the
  // panel under the pointer; its own result follows when it ends.
  const isResizingRef = useRef(isResizing);
  isResizingRef.current = isResizing;
  const windowWidth = windowSidebar?.width_px;
  const windowCollapsed = windowSidebar?.collapsed;
  useEffect(() => {
    if (windowWidth === undefined || windowCollapsed === undefined || isResizingRef.current) return;
    setStoredWidth(clampSidebarTarget(windowWidth));
    if (windowCollapsed !== collapsedRef.current) {
      collapsedRef.current = windowCollapsed;
      animateWidth();
    }
    setCollapsed(windowCollapsed);
  }, [animateWidth, windowCollapsed, windowWidth]);

  const startResize = useCallback((startX: number, startWidth: number) => {
    // The drag starts from the width on screen, the squeezed one in a narrow
    // window, so the edge does not jump to the target under the pointer.
    const start = clampToWindow(startWidth);
    startRef.current = { startX, startWidth: start };
    pendingWidthRef.current = start;
    setDragWidth(start);
    setIsResizing(true);
    document.body.classList.add("sidebar-resizing");
  }, []);

  // The line follows the cursor 1:1 between the bounds and stops at them: the
  // narrowest sidebar, and the widest the window holds beside the narrowest
  // feed (У2).
  const updateResize = useCallback((clientX: number) => {
    const { startX, startWidth } = startRef.current;
    const next = clampToWindow(startWidth + (clientX - startX));
    writeCssVar(`${next}px`);
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

  // The drag's end is the new target (У2).
  const endResize = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    setIsResizing(false);
    document.body.classList.remove("sidebar-resizing");
    const finalWidth = clampToWindow(pendingWidthRef.current);
    setStoredWidth(finalWidth);
    setDragWidth(finalWidth);
    commit(finalWidth, false);
  }, [commit]);

  const resizeTo = useCallback((nextWidth: number) => {
    const next = clampToWindow(nextWidth);
    setStoredWidth(next);
    commit(next, collapsedRef.current);
  }, [commit]);

  const storedWidthRef = useRef(storedWidth);
  storedWidthRef.current = storedWidth;
  const toggleCollapsed = useCallback(() => {
    const next = !collapsedRef.current;
    collapsedRef.current = next;
    animateWidth();
    setCollapsed(next);
    commit(storedWidthRef.current, next);
  }, [animateWidth, commit]);

  // Cleanup pending RAF and the animation's timer on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
      if (animationTimerRef.current !== null) {
        clearTimeout(animationTimerRef.current);
      }
    };
  }, []);

  return {
    width,
    collapsed,
    isResizing,
    widthAnimating: widthAnimating || crossing !== null,
    besideShown: !overlaid || crossing === "leave",
    startResize,
    updateResize,
    endResize,
    resizeTo,
    toggleCollapsed,
  };
}
