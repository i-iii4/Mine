import { useState, useCallback, useRef, useEffect, useLayoutEffect, startTransition } from "react";
import { setWindowSidebar } from "@/lib/commands";
import { SIDEBAR_MIN_WIDTH_PX } from "@/lib/appLayout";
import { motionEasing, motionMs } from "@/lib/motion";
import {
  clampSidebarTarget,
  sidebarDragBounds,
  sidebarWidthCss,
  sidebarWidthPx,
} from "@/lib/sidebarPlacement";
import type { SidebarLayout } from "@/types";
import { writeSidebarWidth } from "@/lib/sidebarWidth";

// ─── Constants ──────────────────────────────────────────────────────────────

/** How long the sidebar takes to collapse or open by its button in Full. */
export const SIDEBAR_WIDTH_MOTION_MS = 200;

/** The curve of that motion in Full. */
export const SIDEBAR_WIDTH_EASING = "ease";

/** The motion of the sidebar's width in Full (`widthTransition`): the panel
 *  beside the feed and its segment in the top row move by the same one, so
 *  the segment's line follows the panel's (DESIGN_SYSTEM.md, «Движение
 *  верхних рядов»). */
export const SIDEBAR_WIDTH_TRANSITION = `width ${SIDEBAR_WIDTH_MOTION_MS}ms ${SIDEBAR_WIDTH_EASING}`;

/** Which way the width moves: an opening to the open width, a collapse and
 *  leaving the row to none. Minimal times them 150 and 100 ms
 *  (SPEC_MOTION_LEVELS.md, С1). */
export type SidebarWidthPhase = "enter" | "exit";

/** One run of the width's motion: its way and its time, read from the level
 *  as it starts, so a level chosen meanwhile waits for the next run (УД11). */
interface WidthMotion {
  phase: SidebarWidthPhase;
  ms: number;
}

/** The width's motion for `phase` at the level in force; none at once (Off,
 *  a key). */
function widthMotionFor(phase: SidebarWidthPhase, byKey: boolean): WidthMotion | null {
  const ms = motionMs(SIDEBAR_WIDTH_MOTION_MS, phase, { byKey });
  return ms === 0 ? null : { phase, ms };
}

/** The CSS transition of a run of the width's motion: one value for the
 *  panel and its segment; global.css gives the second row's left edge the
 *  same by the phase (`data-sidebar-width-animating`). */
function widthTransitionOf(motion: WidthMotion): string {
  return `width ${motion.ms}ms ${motionEasing(SIDEBAR_WIDTH_MOTION_MS, motion.phase, SIDEBAR_WIDTH_EASING)}`;
}

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
  // A page that is not a tab starts at `S_min`, as it always did; a drag
  // takes it lower (PLAN 50.36).
  if (!windowSidebar) return { width: SIDEBAR_MIN_WIDTH_PX, collapsed: false };
  return {
    width: clampSidebarTarget(windowSidebar.width_px),
    collapsed: windowSidebar.collapsed,
  };
}

/** The sidebar beside the feed leaving the row or coming back into it as the
 *  window crosses the threshold of the sidebar over the feed, with its
 *  motion. The keyboard's visit has none: it shows and goes at once on every
 *  level (SPEC_MOTION_LEVELS.md, УД4). */
interface SidebarCrossing {
  kind: "leave" | "enter";
  motion: WidthMotion;
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
  /** The CSS transition of the panel's width and its segment's in the top
   *  row: the level's for the run under way, "none" at rest (С1). */
  widthTransition: string;
  /** The way the width moves while it animates, null at rest: the shell
   *  names it for the second row's left edge (global.css). */
  widthPhase: SidebarWidthPhase | null;
  /** The sidebar's width beside the feed when open, px, as its CSS gives it
   *  in the window now (`sidebarWidthCss`): the width a collapse leaves and
   *  an opening reaches. The list keeps this width's look while the width
   *  moves (sidebarListMorph.ts; user's decision of 01.11.2026). */
  openWidth: number;
  /** The sidebar beside the feed is on the page: always while the window
   *  holds it, and for the motion of its leaving when the window narrows past
   *  the threshold (SPEC_NARROW_WINDOW.md, У7). */
  besideShown: boolean;
  /** The sidebar stands open beside the feed, or is leaving it: what stands
   *  over it in the top row, the space switcher, the collections' filter and
   *  `+`, is on the page while this holds. Open, and for the motion of a
   *  collapse and of leaving the row past the threshold (У7), so it leaves
   *  with the sidebar's width; not while collapsed at rest, nor where the
   *  width stands at once, in Off and by a key (DESIGN_SYSTEM.md, «Верхние
   *  ряды», «Одно название в ряду»). The sidebar shown for the keyboard is
   *  open. */
  besideOpenShown: boolean;
  /** Begin a resize drag from the width shown now (called by handle component) */
  startResize: (startX: number, startWidth: number) => void;
  /** Update width during drag (called on every pointermove) */
  updateResize: (clientX: number) => void;
  /** Finish the resize drag */
  endResize: () => void;
  /** Set the width at once (the handle's keyboard), within the window's bounds */
  resizeTo: (width: number) => void;
  /** Toggle collapsed/expanded; `byKey`, a key did it, and the width
   *  stands at once on every level (SPEC_MOTION_LEVELS.md, УД4). */
  toggleCollapsed: (byKey?: boolean) => void;
}

/**
 * The sidebar's width and collapsed state, and the drag that resizes it.
 * `windowSidebar` is the layout of this tab's window as the backend last sent
 * it (bootstrap, then `window-sidebar-changed`); null for a page that is not
 * a tab. `overlaid`: the window is too narrow for the sidebar beside the
 * feed (SPEC_NARROW_WINDOW.md, У1); the sidebar takes none of the row then,
 * and lies over the feed when open with a width of its own (SidebarOverlay).
 * `openForKeyboard`: a collapsed sidebar shows for the keyboard's visit
 * (SPEC_KEYBOARD.md, М8). It is not the person's setting: `collapsed` below and
 * what the backend keeps stay as they are, so a reload comes back collapsed.
 * It shows and goes at once (SPEC_MOTION_LEVELS.md, УД4). `windowChangeByKey`
 * says whether the window's last layout came from a key, the View menu
 * (УД4, п. 1): its collapse or opening stands at once.
 */
export function useSidebarResize(
  windowSidebar: SidebarLayout | null = null,
  overlaid = false,
  openForKeyboard = false,
  windowChangeByKey: () => boolean = () => false,
): UseSidebarResizeReturn {
  const [storedWidth, setStoredWidth] = useState(() => initialLayout(windowSidebar).width);
  const [storedCollapsed, setCollapsed] = useState(() => initialLayout(windowSidebar).collapsed);
  const collapsed = storedCollapsed && !openForKeyboard;
  const [isResizing, setIsResizing] = useState(false);
  const [dragWidth, setDragWidth] = useState(() => {
    const { width, collapsed: c } = initialLayout(windowSidebar);
    return c ? 0 : width;
  });
  const [widthMotion, setWidthMotion] = useState<WidthMotion | null>(null);

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
  // window. Off and a key keep it off, and a key stops a run under way: the
  // width stands at once (SPEC_MOTION_LEVELS.md, С1). The run's timer is its
  // time at the level (Р3).
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animateWidth = useCallback((phase: SidebarWidthPhase, byKey: boolean) => {
    if (animationTimerRef.current !== null) {
      clearTimeout(animationTimerRef.current);
      animationTimerRef.current = null;
    }
    const motion = widthMotionFor(phase, byKey);
    setWidthMotion(motion);
    if (motion === null) return;
    animationTimerRef.current = setTimeout(() => {
      animationTimerRef.current = null;
      setWidthMotion(null);
    }, motion.ms);
  }, []);

  const startRef = useRef({ startX: 0, startWidth: 0 });
  const rafIdRef = useRef<number | null>(null);
  const pendingWidthRef = useRef(0);

  // Keep refs in sync so the stable callbacks read fresh values at fire time.
  const collapsedRef = useRef(storedCollapsed);
  collapsedRef.current = storedCollapsed;

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
    // A change of the window is the pointer's: it moves by the level.
    const motion = collapsed ? null : widthMotionFor(overlaid ? "exit" : "enter", false);
    setCrossing(motion === null ? null : { kind: overlaid ? "leave" : "enter", motion });
  }
  useEffect(() => {
    if (crossing === null) return undefined;
    const timer = setTimeout(() => setCrossing(null), crossing.motion.ms);
    return () => clearTimeout(timer);
  }, [crossing]);

  // Mount + sync: seed / update CSS variable before paint. At rest the
  // variable is the squeeze expression; the drag writes plain pixels. Over
  // the feed the sidebar takes none of the row. Coming back into the row it
  // starts from none for a frame, so its width moves in. The rows' columns
  // keep the open width throughout (user's decision of 05.11.2026): the name's
  // column stands still while the panel's edge moves over it.
  useLayoutEffect(() => {
    if (isResizing) return undefined;
    const open = sidebarWidthCss(storedWidth);
    const target = collapsed || overlaid ? "0px" : open;
    if (crossing?.kind === "enter") {
      writeSidebarWidth("0px", open);
      const frame = requestAnimationFrame(() => writeSidebarWidth(target, open));
      return () => cancelAnimationFrame(frame);
    }
    writeSidebarWidth(target, open);
    return undefined;
  }, [collapsed, crossing, overlaid, storedWidth, isResizing]);

  // The window's layout changed: another tab, the tab bar's button, the View
  // menu or the two-finger swipe (В56). A drag in progress here keeps the
  // panel under the pointer; its own result follows when it ends.
  const isResizingRef = useRef(isResizing);
  isResizingRef.current = isResizing;
  const windowWidth = windowSidebar?.width_px;
  const windowCollapsed = windowSidebar?.collapsed;
  const windowChangeByKeyRef = useRef(windowChangeByKey);
  windowChangeByKeyRef.current = windowChangeByKey;
  useEffect(() => {
    if (windowWidth === undefined || windowCollapsed === undefined || isResizingRef.current) return;
    setStoredWidth(clampSidebarTarget(windowWidth));
    if (windowCollapsed !== collapsedRef.current) {
      collapsedRef.current = windowCollapsed;
      animateWidth(windowCollapsed ? "exit" : "enter", windowChangeByKeyRef.current());
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
    writeSidebarWidth(`${next}px`);
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
  const toggleCollapsed = useCallback((byKey = false) => {
    const next = !collapsedRef.current;
    collapsedRef.current = next;
    animateWidth(next ? "exit" : "enter", byKey);
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

  const besideShown = !overlaid || crossing?.kind === "leave";
  const runningMotion = crossing?.motion ?? widthMotion;
  const widthMoving = runningMotion !== null;
  return {
    width,
    collapsed,
    isResizing,
    widthAnimating: widthMoving,
    widthTransition: runningMotion === null ? "none" : widthTransitionOf(runningMotion),
    widthPhase: runningMotion?.phase ?? null,
    openWidth: sidebarWidthPx(storedWidth, window.innerWidth),
    besideShown,
    // A collapse keeps it for the width's motion to none; an opening shows it
    // at once, its width moving in from none.
    besideOpenShown: besideShown && (!collapsed || widthMoving),
    startResize,
    updateResize,
    endResize,
    resizeTo,
    toggleCollapsed,
  };
}
