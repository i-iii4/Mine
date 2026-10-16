import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarLayout } from "@/types";
import { SIDEBAR_MAX_WIDTH_PX, SIDEBAR_MIN_WIDTH_PX } from "@/lib/appLayout";
import { SIDEBAR_WIDTH_MOTION_MS, useSidebarResize } from "./useSidebarResize";

const commands = vi.hoisted(() => ({
  setWindowSidebar: vi.fn(async (_sidebar: { width_px: number; collapsed: boolean }) => {}),
}));

vi.mock("@/lib/commands", () => ({
  setWindowSidebar: commands.setWindowSidebar,
}));

describe("useSidebarResize: the window's sidebar (SPEC_TABS.md, В56, В78)", () => {
  const min = () => SIDEBAR_MIN_WIDTH_PX;

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

  it("stops a drag at the maximum", () => {
    const { result } = renderHook(() => useSidebarResize({ width_px: 480, collapsed: false }));
    act(() => result.current.startResize(480, 480));
    act(() => result.current.updateResize(480 + 5000));
    act(() => result.current.endResize());
    expect(result.current.width).toBe(SIDEBAR_MAX_WIDTH_PX);
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

  it("does not animate the width with Reduce motion", () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }));
    try {
      const { result } = renderHook(() => useSidebarResize({ width_px: 480, collapsed: false }));
      act(() => result.current.toggleCollapsed());
      expect(result.current.collapsed).toBe(true);
      expect(result.current.widthAnimating).toBe(false);
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  it("takes none of the row while the sidebar lies over the feed, and keeps its target (47.3c)", () => {
    const cssWidth = () => document.documentElement.style.getPropertyValue("--sidebar-width");
    const { result, rerender } = renderHook(
      ({ overlaid }: { overlaid: boolean }) => useSidebarResize({ width_px: 480, collapsed: false }, overlaid),
      { initialProps: { overlaid: true } },
    );
    expect(cssWidth()).toBe("0px");
    expect(result.current.collapsed).toBe(false);

    // Wide again: back beside the feed at the target, nothing stored.
    rerender({ overlaid: false });
    expect(cssWidth()).toBe("min(480px, 100vw - 390px)");
    expect(commands.setWindowSidebar).not.toHaveBeenCalled();
  });

  it("keeps the layout in memory on a page that is not a tab, and nothing in localStorage", () => {
    const { result } = renderHook(() => useSidebarResize(null));
    // The first-run width is the window's; without a window, the minimum.
    expect(result.current.width).toBe(min());

    act(() => result.current.toggleCollapsed());

    expect(result.current.collapsed).toBe(true);
    expect(commands.setWindowSidebar).not.toHaveBeenCalled();
    expect(localStorage.getItem("mine:sidebar")).toBeNull();
    expect(SIDEBAR_MAX_WIDTH_PX).toBeGreaterThan(min());
  });
});
