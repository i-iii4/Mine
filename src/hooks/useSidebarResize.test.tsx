import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarLayout } from "@/types";
import { APP_MAIN_MIN_WIDTH_PX, SIDEBAR_MAX_WIDTH_PX, SIDEBAR_MIN_WIDTH_PX, sidebarBesideMinWidthPx } from "@/lib/appLayout";
import { MOTION_EASE, MOTION_ENTER_MS, MOTION_EXIT_MS, MOTION_LEVELS } from "@/lib/motion";
import { setMotionLevel } from "@/test/motionLevel";
import { SIDEBAR_WIDTH_MOTION_MS, SIDEBAR_WIDTH_TRANSITION, useSidebarResize } from "./useSidebarResize";

const commands = vi.hoisted(() => ({
  setWindowSidebar: vi.fn(async (_sidebar: { width_px: number; collapsed: boolean }) => {}),
}));

vi.mock("@/lib/commands", () => ({
  setWindowSidebar: commands.setWindowSidebar,
}));

describe("useSidebarResize: the window's sidebar (SPEC_TABS.md, В56, В78)", () => {
  // A drag and a stored width go down to the compact item's minimum
  // (PLAN 50.36); a page that is not a tab still starts at S_min.
  const min = () => sidebarBesideMinWidthPx();

  const wideWindow = window.innerWidth;

  beforeEach(() => {
    commands.setWindowSidebar.mockClear();
    localStorage.clear();
    window.innerWidth = wideWindow;
  });

  it("starts from the window's layout, clamped to what the panel can show", () => {
    const { result } = renderHook(() => useSidebarResize({ width_px: 480, collapsed: false }));
    expect(result.current.width).toBe(480);
    expect(result.current.collapsed).toBe(false);

    const narrow = renderHook(() => useSidebarResize({ width_px: 100, collapsed: false }));
    expect(narrow.result.current.width).toBe(min());
    // The clamped value stays on screen: nothing is stored until the person
    // changes the sidebar.
    expect(commands.setWindowSidebar).not.toHaveBeenCalled();
    const wide = renderHook(() => useSidebarResize({ width_px: 5000, collapsed: true }));
    expect(wide.result.current.collapsed).toBe(true);
    expect(wide.result.current.width).toBe(0);
  });

  it("names the open width beside the feed, collapsed too, squeezed as the CSS squeezes it", () => {
    window.innerWidth = 1400;
    const { result } = renderHook(() => useSidebarResize({ width_px: 480, collapsed: true }));
    // The width an opening reaches, while the width shown is none.
    expect(result.current.width).toBe(0);
    expect(result.current.openWidth).toBe(480);
    window.innerWidth = 800;
    const squeezed = renderHook(() => useSidebarResize({ width_px: 480, collapsed: false }));
    expect(squeezed.result.current.openWidth).toBe(800 - 390);
  });

  it("keeps the rows' columns at the open width while the sidebar's width goes to none and back (user's decision of 05.11.2026)", () => {
    const root = document.documentElement.style;
    const { result } = renderHook(() => useSidebarResize({ width_px: 480, collapsed: false }));
    const open = root.getPropertyValue("--sidebar-width");
    expect(open).toContain("480px");
    expect(root.getPropertyValue("--sidebar-columns-width")).toBe(open);
    act(() => result.current.toggleCollapsed());
    expect(root.getPropertyValue("--sidebar-width")).toBe("0px");
    expect(root.getPropertyValue("--sidebar-columns-width")).toBe(open);
    act(() => result.current.toggleCollapsed());
    expect(root.getPropertyValue("--sidebar-width")).toBe(open);
    expect(root.getPropertyValue("--sidebar-columns-width")).toBe(open);
  });

  describe("opened for the keyboard (SPEC_KEYBOARD.md, М8)", () => {
    const hidden: SidebarLayout = { width_px: 480, collapsed: true };
    const visit = (layout: SidebarLayout = hidden) => renderHook(
      ({ open, sidebar }: { open: boolean; sidebar: SidebarLayout }) => useSidebarResize(sidebar, false, open),
      { initialProps: { open: false, sidebar: layout } },
    );

    it.each(MOTION_LEVELS)("shows a collapsed sidebar at once and takes it away at once in %s, and stores nothing (SPEC_MOTION_LEVELS.md, УД4)", (level) => {
      setMotionLevel(level);
      const root = document.documentElement.style;
      const { result, rerender } = visit();
      expect(result.current.collapsed).toBe(true);
      expect(root.getPropertyValue("--sidebar-width")).toBe("0px");

      rerender({ open: true, sidebar: hidden });
      expect(result.current.collapsed).toBe(false);
      expect(result.current.width).toBe(480);
      expect(result.current.widthAnimating).toBe(false);
      expect(result.current.widthTransition).toBe("none");
      expect(root.getPropertyValue("--sidebar-width")).toContain("480px");

      rerender({ open: false, sidebar: hidden });
      expect(result.current.collapsed).toBe(true);
      expect(result.current.widthAnimating).toBe(false);
      expect(result.current.besideOpenShown).toBe(false);
      expect(root.getPropertyValue("--sidebar-width")).toBe("0px");
      expect(commands.setWindowSidebar).not.toHaveBeenCalled();
    });

    it("comes back collapsed after a reload during the visit, what is stored having not moved", () => {
      const { rerender, unmount } = visit();
      rerender({ open: true, sidebar: hidden });
      unmount();
      const reloaded = renderHook(() => useSidebarResize(hidden));
      expect(reloaded.result.current.collapsed).toBe(true);
      expect(commands.setWindowSidebar).not.toHaveBeenCalled();
    });

    it("leaves a sidebar the person keeps open as it is, without a motion", () => {
      const open: SidebarLayout = { width_px: 480, collapsed: false };
      const { result, rerender } = visit(open);
      rerender({ open: true, sidebar: open });
      expect(result.current.collapsed).toBe(false);
      expect(result.current.widthAnimating).toBe(false);
    });

    it("takes what a drag of the edge stored during the visit", () => {
      const { result, rerender } = visit();
      rerender({ open: true, sidebar: hidden });
      // The stored state came back open; the page ends the visit's flag on it.
      const shown: SidebarLayout = { width_px: 480, collapsed: false };
      rerender({ open: false, sidebar: shown });
      expect(result.current.collapsed).toBe(false);
      expect(commands.setWindowSidebar).not.toHaveBeenCalled();
    });

    it("takes no width of the row over the feed, the sidebar there having its own", () => {
      const { result, rerender } = renderHook(
        ({ open }: { open: boolean }) => useSidebarResize(hidden, true, open),
        { initialProps: { open: false } },
      );
      rerender({ open: true });
      expect(result.current.widthAnimating).toBe(false);
      expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe("0px");
      expect(commands.setWindowSidebar).not.toHaveBeenCalled();
    });
  });

  it("follows the window when another tab, the tab bar or the menu changes it", () => {
    const { result, rerender } = renderHook(
      ({ layout }: { layout: SidebarLayout }) => useSidebarResize(layout),
      { initialProps: { layout: { width_px: 480, collapsed: false } } },
    );

    rerender({ layout: { width_px: 480, collapsed: true } });
    expect(result.current.collapsed).toBe(true);
    rerender({ layout: { width_px: 520, collapsed: false } });
    expect(result.current.collapsed).toBe(false);
    expect(result.current.width).toBe(520);
    // What the window said is not said back.
    expect(commands.setWindowSidebar).not.toHaveBeenCalled();
  });

  it("stores a toggle in the window and shows it at once", () => {
    const { result } = renderHook(() => useSidebarResize({ width_px: 480, collapsed: false }));

    act(() => result.current.toggleCollapsed());

    expect(result.current.collapsed).toBe(true);
    expect(commands.setWindowSidebar).toHaveBeenCalledWith({ width_px: 480, collapsed: true });
    act(() => result.current.toggleCollapsed());
    expect(commands.setWindowSidebar).toHaveBeenLastCalledWith({ width_px: 480, collapsed: false });
  });

  it("stores the width a drag ends on, and no layout while it runs", () => {
    const { result } = renderHook(() => useSidebarResize({ width_px: 480, collapsed: false }));

    act(() => result.current.startResize(480, 480));
    act(() => result.current.updateResize(500.4));
    expect(commands.setWindowSidebar).not.toHaveBeenCalled();
    act(() => result.current.endResize());

    expect(commands.setWindowSidebar).toHaveBeenCalledWith({ width_px: 500, collapsed: false });
    expect(result.current.width).toBeCloseTo(500.4);
  });

  it("stops a drag at the minimum and never collapses the panel (07.10.2026)", () => {
    const { result } = renderHook(() => useSidebarResize({ width_px: 480, collapsed: false }));

    act(() => result.current.startResize(480, 480));
    // Far past the old collapse point, to the window's left edge.
    act(() => result.current.updateResize(0));
    expect(result.current.collapsed).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe(`${min()}px`);
    act(() => result.current.endResize());

    expect(result.current.collapsed).toBe(false);
    expect(result.current.width).toBe(min());
    expect(commands.setWindowSidebar).toHaveBeenLastCalledWith({ width_px: min(), collapsed: false });
  });

  it("stops a drag where the narrowest feed begins, with no cap of its own (23.10.2026)", () => {
    window.innerWidth = 2560;
    const { result } = renderHook(() => useSidebarResize({ width_px: 480, collapsed: false }));
    act(() => result.current.startResize(480, 480));
    act(() => result.current.updateResize(480 + 5000));
    act(() => result.current.endResize());
    expect(result.current.width).toBe(2560 - APP_MAIN_MIN_WIDTH_PX);
    expect(result.current.width).toBeGreaterThan(SIDEBAR_MAX_WIDTH_PX);
  });

  it("sets the width from the keyboard within the bounds, and stores it", () => {
    const { result } = renderHook(() => useSidebarResize({ width_px: 480, collapsed: false }));
    act(() => result.current.resizeTo(496));
    expect(result.current.width).toBe(496);
    expect(commands.setWindowSidebar).toHaveBeenLastCalledWith({ width_px: 496, collapsed: false });
    act(() => result.current.resizeTo(0));
    expect(result.current.width).toBe(min());
  });

  it("keeps a drag under the pointer when the window's layout arrives during it", () => {
    const { result, rerender } = renderHook(
      ({ layout }: { layout: SidebarLayout }) => useSidebarResize(layout),
      { initialProps: { layout: { width_px: 480, collapsed: false } } },
    );
    act(() => result.current.startResize(480, 480));
    act(() => result.current.updateResize(560));
    rerender({ layout: { width_px: 400, collapsed: true } });
    expect(result.current.isResizing).toBe(true);
    expect(result.current.collapsed).toBe(false);
    act(() => result.current.endResize());
    expect(commands.setWindowSidebar).toHaveBeenLastCalledWith({ width_px: 560, collapsed: false });
  });

  it("lets CSS squeeze the panel in a narrow window and keeps the dragged width (SPEC_NARROW_WINDOW.md, У1, У2)", () => {
    const { result } = renderHook(() => useSidebarResize({ width_px: 480, collapsed: false }));
    const cssWidth = () => document.documentElement.style.getPropertyValue("--sidebar-width");
    expect(cssWidth()).toBe("min(480px, 100vw - 390px)");

    // A window's resize renders nothing and stores nothing.
    act(() => {
      window.innerWidth = 700;
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.width).toBe(480);
    expect(cssWidth()).toBe("min(480px, 100vw - 390px)");
    expect(commands.setWindowSidebar).not.toHaveBeenCalled();
    act(() => result.current.toggleCollapsed());
    expect(cssWidth()).toBe("0px");
    act(() => result.current.toggleCollapsed());
    expect(cssWidth()).toBe("min(480px, 100vw - 390px)");
  });

  it("drags from the width shown in a narrow window, up to what the window holds beside the feed", () => {
    window.innerWidth = 800;
    const { result } = renderHook(() => useSidebarResize({ width_px: 480, collapsed: false }));

    // 800 leaves 410 beside the narrowest feed.
    act(() => result.current.startResize(410, 480));
    expect(result.current.width).toBe(410);
    act(() => result.current.updateResize(410 + 300));
    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe("410px");
    act(() => result.current.updateResize(360));
    act(() => result.current.endResize());

    // The drag's end is the width the panel returns to.
    expect(result.current.width).toBe(360);
    expect(commands.setWindowSidebar).toHaveBeenLastCalledWith({ width_px: 360, collapsed: false });
    act(() => result.current.resizeTo(5000));
    expect(result.current.width).toBe(410);
  });

  it("animates the width only for a collapse or an opening", () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ layout }: { layout: SidebarLayout }) => useSidebarResize(layout),
        { initialProps: { layout: { width_px: 480, collapsed: false } } },
      );
      expect(result.current.widthAnimating).toBe(false);

      act(() => result.current.toggleCollapsed());
      expect(result.current.widthAnimating).toBe(true);
      act(() => vi.advanceTimersByTime(SIDEBAR_WIDTH_MOTION_MS));
      expect(result.current.widthAnimating).toBe(false);

      // The window's echo of that toggle moves nothing again.
      rerender({ layout: { width_px: 480, collapsed: true } });
      expect(result.current.widthAnimating).toBe(false);
      // The window opens it: the tab bar's button, the View menu.
      rerender({ layout: { width_px: 480, collapsed: false } });
      expect(result.current.widthAnimating).toBe(true);
      act(() => vi.advanceTimersByTime(SIDEBAR_WIDTH_MOTION_MS));

      // Neither a drag nor another width from the window animates.
      act(() => result.current.startResize(480, 480));
      act(() => result.current.updateResize(520));
      act(() => result.current.endResize());
      rerender({ layout: { width_px: 400, collapsed: false } });
      expect(result.current.widthAnimating).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves the sidebar out of the row and back as the window crosses the threshold (У7)", () => {
    vi.useFakeTimers();
    const cssWidth = () => document.documentElement.style.getPropertyValue("--sidebar-width");
    try {
      const { result, rerender } = renderHook(
        ({ overlaid, collapsed }: { overlaid: boolean; collapsed: boolean }) =>
          useSidebarResize({ width_px: 480, collapsed }, overlaid),
        { initialProps: { overlaid: false, collapsed: false } },
      );
      expect(result.current.besideShown).toBe(true);

      // Narrowing past it: the sidebar stays for the motion of its leaving.
      rerender({ overlaid: true, collapsed: false });
      expect(result.current.besideShown).toBe(true);
      expect(result.current.widthAnimating).toBe(true);
      expect(cssWidth()).toBe("0px");
      act(() => vi.advanceTimersByTime(SIDEBAR_WIDTH_MOTION_MS));
      expect(result.current.besideShown).toBe(false);
      expect(result.current.widthAnimating).toBe(false);

      // Widening past it: in from none, then to its width, moving.
      rerender({ overlaid: false, collapsed: false });
      expect(result.current.besideShown).toBe(true);
      expect(result.current.widthAnimating).toBe(true);
      expect(cssWidth()).toBe("0px");
      act(() => vi.advanceTimersToNextFrame());
      expect(cssWidth()).toBe("min(480px, 100vw - 390px)");
      act(() => vi.advanceTimersByTime(SIDEBAR_WIDTH_MOTION_MS));
      expect(result.current.widthAnimating).toBe(false);

      // A collapsed sidebar has nothing to move.
      rerender({ overlaid: false, collapsed: true });
      act(() => vi.advanceTimersByTime(SIDEBAR_WIDTH_MOTION_MS));
      rerender({ overlaid: true, collapsed: true });
      expect(result.current.widthAnimating).toBe(false);
      expect(result.current.besideShown).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // What stands over the sidebar in the top row leaves with it and comes back
  // with it (DESIGN_SYSTEM.md, «Одно название в ряду», «Движение верхних
  // рядов»; user's decision of 11.11.2026).
  describe("the top row's part over the sidebar (besideOpenShown)", () => {
    const cssWidth = () => document.documentElement.style.getPropertyValue("--sidebar-width");

    it("stays for the 200 ms of a collapse, its width going to none, and is gone collapsed", () => {
      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useSidebarResize({ width_px: 480, collapsed: false }));
        expect(result.current.besideOpenShown).toBe(true);

        act(() => result.current.toggleCollapsed());
        expect(result.current.collapsed).toBe(true);
        expect(result.current.besideOpenShown).toBe(true);
        expect(result.current.widthAnimating).toBe(true);
        expect(cssWidth()).toBe("0px");
        act(() => vi.advanceTimersByTime(SIDEBAR_WIDTH_MOTION_MS - 1));
        expect(result.current.besideOpenShown).toBe(true);
        act(() => vi.advanceTimersByTime(1));
        expect(result.current.besideOpenShown).toBe(false);
        expect(result.current.widthAnimating).toBe(false);

        // Opening, it is there at once, its width moving in from none.
        act(() => result.current.toggleCollapsed());
        expect(result.current.besideOpenShown).toBe(true);
        expect(result.current.widthAnimating).toBe(true);
        expect(cssWidth()).toBe("min(480px, 100vw - 390px)");
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves with the window's collapse from another tab, the tab bar or the menu", () => {
      vi.useFakeTimers();
      try {
        const { result, rerender } = renderHook(
          ({ layout }: { layout: SidebarLayout }) => useSidebarResize(layout),
          { initialProps: { layout: { width_px: 480, collapsed: false } } },
        );
        rerender({ layout: { width_px: 480, collapsed: true } });
        expect(result.current.besideOpenShown).toBe(true);
        act(() => vi.advanceTimersByTime(SIDEBAR_WIDTH_MOTION_MS));
        expect(result.current.besideOpenShown).toBe(false);
        rerender({ layout: { width_px: 480, collapsed: false } });
        expect(result.current.besideOpenShown).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("is not there for a sidebar collapsed from the start", () => {
      const { result } = renderHook(() => useSidebarResize({ width_px: 480, collapsed: true }));
      expect(result.current.besideShown).toBe(true);
      expect(result.current.besideOpenShown).toBe(false);
    });

    it("comes with the keyboard's visit and leaves at once with its end (SPEC_KEYBOARD.md, М8; SPEC_MOTION_LEVELS.md, УД4)", () => {
      const hidden: SidebarLayout = { width_px: 480, collapsed: true };
      const { result, rerender } = renderHook(
        ({ open }: { open: boolean }) => useSidebarResize(hidden, false, open),
        { initialProps: { open: false } },
      );
      expect(result.current.besideOpenShown).toBe(false);
      rerender({ open: true });
      expect(result.current.besideOpenShown).toBe(true);
      rerender({ open: false });
      expect(result.current.besideOpenShown).toBe(false);
    });

    it("leaves past the threshold with the sidebar beside the feed, and is not there over it (У7, У12)", () => {
      vi.useFakeTimers();
      try {
        const { result, rerender } = renderHook(
          ({ overlaid }: { overlaid: boolean }) => useSidebarResize({ width_px: 480, collapsed: false }, overlaid),
          { initialProps: { overlaid: false } },
        );
        rerender({ overlaid: true });
        expect(result.current.besideOpenShown).toBe(true);
        act(() => vi.advanceTimersByTime(SIDEBAR_WIDTH_MOTION_MS));
        expect(result.current.besideOpenShown).toBe(false);
        rerender({ overlaid: false });
        expect(result.current.besideOpenShown).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("does not animate the width in Off (SPEC_MOTION_LEVELS.md, С1)", () => {
    setMotionLevel("off");
    const { result } = renderHook(() => useSidebarResize({ width_px: 480, collapsed: false }));
    act(() => result.current.toggleCollapsed());
    expect(result.current.collapsed).toBe(true);
    expect(result.current.widthAnimating).toBe(false);
    expect(result.current.widthTransition).toBe("none");
    expect(result.current.widthPhase).toBeNull();
    // What stood over it in the top row goes at once too.
    expect(result.current.besideOpenShown).toBe(false);

    // Nor across the threshold: the sidebar leaves the row at once.
    const crossing = renderHook(
      ({ overlaid }: { overlaid: boolean }) => useSidebarResize({ width_px: 480, collapsed: false }, overlaid),
      { initialProps: { overlaid: false } },
    );
    crossing.rerender({ overlaid: true });
    expect(crossing.result.current.besideShown).toBe(false);
    expect(crossing.result.current.widthAnimating).toBe(false);
  });

  describe("the width's motion by level (SPEC_MOTION_LEVELS.md, С1)", () => {
    const minimalCollapse = `width ${MOTION_EXIT_MS}ms ${MOTION_EASE}`;
    const minimalOpening = `width ${MOTION_ENTER_MS}ms ${MOTION_EASE}`;

    it("moves by the button in Full for 200 ms on ease, both ways, one value for the panel and its segment", () => {
      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useSidebarResize({ width_px: 480, collapsed: false }));
        expect(result.current.widthTransition).toBe("none");
        act(() => result.current.toggleCollapsed());
        expect(result.current.widthTransition).toBe(SIDEBAR_WIDTH_TRANSITION);
        expect(result.current.widthPhase).toBe("exit");
        act(() => vi.advanceTimersByTime(SIDEBAR_WIDTH_MOTION_MS));
        expect(result.current.widthTransition).toBe("none");
        act(() => result.current.toggleCollapsed());
        expect(result.current.widthTransition).toBe(SIDEBAR_WIDTH_TRANSITION);
        expect(result.current.widthPhase).toBe("enter");
      } finally {
        vi.useRealTimers();
      }
    });

    it("collapses in Minimal for 100 ms and opens for 150 ms on E, its timer the same time", () => {
      vi.useFakeTimers();
      try {
        setMotionLevel("minimal");
        const { result } = renderHook(() => useSidebarResize({ width_px: 480, collapsed: false }));
        act(() => result.current.toggleCollapsed());
        expect(result.current.widthTransition).toBe(minimalCollapse);
        expect(result.current.widthPhase).toBe("exit");
        expect(result.current.besideOpenShown).toBe(true);
        act(() => vi.advanceTimersByTime(MOTION_EXIT_MS - 1));
        expect(result.current.widthAnimating).toBe(true);
        act(() => vi.advanceTimersByTime(1));
        expect(result.current.widthAnimating).toBe(false);
        expect(result.current.besideOpenShown).toBe(false);

        act(() => result.current.toggleCollapsed());
        expect(result.current.widthTransition).toBe(minimalOpening);
        expect(result.current.widthPhase).toBe("enter");
        act(() => vi.advanceTimersByTime(MOTION_ENTER_MS - 1));
        expect(result.current.widthAnimating).toBe(true);
        act(() => vi.advanceTimersByTime(1));
        expect(result.current.widthTransition).toBe("none");
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(MOTION_LEVELS)("stands at once by a key in %s: ⌃⌘S heard by the page and the View menu", (level) => {
      setMotionLevel(level);
      let byKey = false;
      const { result, rerender } = renderHook(
        ({ layout }: { layout: SidebarLayout }) => useSidebarResize(layout, false, false, () => byKey),
        { initialProps: { layout: { width_px: 480, collapsed: false } } },
      );
      act(() => result.current.toggleCollapsed(true));
      expect(result.current.collapsed).toBe(true);
      expect(result.current.widthAnimating).toBe(false);
      expect(result.current.besideOpenShown).toBe(false);
      // The echo of that toggle, then the View menu opening it.
      rerender({ layout: { width_px: 480, collapsed: true } });
      byKey = true;
      rerender({ layout: { width_px: 480, collapsed: false } });
      expect(result.current.collapsed).toBe(false);
      expect(result.current.widthAnimating).toBe(false);
      expect(result.current.widthTransition).toBe("none");
    });

    it("lets a key stop a pointer's run under way: the width stands at once", () => {
      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useSidebarResize({ width_px: 480, collapsed: false }));
        act(() => result.current.toggleCollapsed());
        expect(result.current.widthAnimating).toBe(true);
        act(() => result.current.toggleCollapsed(true));
        expect(result.current.widthAnimating).toBe(false);
        expect(result.current.widthTransition).toBe("none");
      } finally {
        vi.useRealTimers();
      }
    });

    it("moves a change of the window from the tab bar's button by the level", () => {
      setMotionLevel("minimal");
      const { result, rerender } = renderHook(
        ({ layout }: { layout: SidebarLayout }) => useSidebarResize(layout, false, false, () => false),
        { initialProps: { layout: { width_px: 480, collapsed: false } } },
      );
      rerender({ layout: { width_px: 480, collapsed: true } });
      expect(result.current.widthTransition).toBe(minimalCollapse);
    });

    it("times the crossing of the threshold by the level in Minimal: leaving 100 ms, coming back 150 ms (Р3)", () => {
      vi.useFakeTimers();
      try {
        setMotionLevel("minimal");
        const { result, rerender } = renderHook(
          ({ overlaid }: { overlaid: boolean }) => useSidebarResize({ width_px: 480, collapsed: false }, overlaid),
          { initialProps: { overlaid: false } },
        );
        rerender({ overlaid: true });
        expect(result.current.widthTransition).toBe(minimalCollapse);
        expect(result.current.widthPhase).toBe("exit");
        act(() => vi.advanceTimersByTime(MOTION_EXIT_MS - 1));
        expect(result.current.besideShown).toBe(true);
        act(() => vi.advanceTimersByTime(1));
        expect(result.current.besideShown).toBe(false);

        rerender({ overlaid: false });
        expect(result.current.widthTransition).toBe(minimalOpening);
        expect(result.current.widthPhase).toBe("enter");
        act(() => vi.advanceTimersByTime(MOTION_ENTER_MS - 1));
        expect(result.current.widthAnimating).toBe(true);
        act(() => vi.advanceTimersByTime(1));
        expect(result.current.widthAnimating).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("takes none of the row while the sidebar lies over the feed, and keeps its target (47.3c)", async () => {
    const cssWidth = () => document.documentElement.style.getPropertyValue("--sidebar-width");
    const { result, rerender } = renderHook(
      ({ overlaid }: { overlaid: boolean }) => useSidebarResize({ width_px: 480, collapsed: false }, overlaid),
      { initialProps: { overlaid: true } },
    );
    expect(cssWidth()).toBe("0px");
    expect(result.current.collapsed).toBe(false);

    // Wide again: back beside the feed at the target, from none a frame
    // before (У7), nothing stored.
    rerender({ overlaid: false });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(cssWidth()).toBe("min(480px, 100vw - 390px)");
    expect(commands.setWindowSidebar).not.toHaveBeenCalled();
  });

  it("keeps the layout in memory on a page that is not a tab, and nothing in localStorage", () => {
    const { result } = renderHook(() => useSidebarResize(null));
    // The first-run width is the window's; without a window, S_min.
    expect(result.current.width).toBe(SIDEBAR_MIN_WIDTH_PX);

    act(() => result.current.toggleCollapsed());

    expect(result.current.collapsed).toBe(true);
    expect(commands.setWindowSidebar).not.toHaveBeenCalled();
    expect(localStorage.getItem("mine:sidebar")).toBeNull();
    expect(SIDEBAR_MAX_WIDTH_PX).toBeGreaterThan(min());
  });
});
