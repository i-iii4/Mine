import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTabVisible } from "@/lib/tabVisibility";
import type { SidebarIntent } from "@/types";
import {
  SIDEBAR_OVERLAY_COMMAND_EVENT,
  sidebarOverlayReport,
  useSidebarOverlay,
  type UseSidebarOverlayOptions,
} from "./useSidebarOverlay";

const page = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@/lib/pageEvents", () => ({
  listenPage: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    page.handlers.set(event, handler);
    return () => page.handlers.delete(event);
  }),
}));

const commands = vi.hoisted(() => ({
  reportSidebarOverlay: vi.fn(async (_overlay: string) => undefined),
}));

vi.mock("@/lib/commands", () => commands);

const wideWindow = window.innerWidth;

function resizeTo(width: number) {
  act(() => {
    window.innerWidth = width;
    window.dispatchEvent(new Event("resize"));
  });
}

function command(intent: SidebarIntent) {
  act(() => page.handlers.get(SIDEBAR_OVERLAY_COMMAND_EVENT)?.({ payload: intent }));
}

function renderOverlay(overrides: Partial<UseSidebarOverlayOptions> = {}) {
  const options: UseSidebarOverlayOptions = {
    tab: true,
    onWidenWhileOpen: vi.fn(),
    onBesideIntent: vi.fn(),
    ...overrides,
  };
  const hook = renderHook(() => useSidebarOverlay(options));
  return { ...hook, options };
}

describe("useSidebarOverlay: the sidebar over the feed (SPEC_NARROW_WINDOW.md, У4 по У8)", () => {
  beforeEach(() => {
    window.innerWidth = 500;
    page.handlers.clear();
    commands.reportSidebarOverlay.mockClear();
    setTabVisible(true);
  });

  afterEach(() => {
    window.innerWidth = wideWindow;
    setTabVisible(true);
  });

  it("is narrow below 740 px and starts closed, never stored", () => {
    const { result } = renderOverlay();
    expect(result.current.narrow).toBe(true);
    expect(result.current.open).toBe(false);
    expect(commands.reportSidebarOverlay).toHaveBeenLastCalledWith("closed");
  });

  it("opens, closes and toggles, and the backend's mirror follows (У4, 47.3b)", () => {
    const { result } = renderOverlay();
    act(() => result.current.openOverlay());
    expect(result.current.open).toBe(true);
    expect(commands.reportSidebarOverlay).toHaveBeenLastCalledWith("open");
    act(() => result.current.toggle());
    expect(result.current.open).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.open).toBe(true);
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
    expect(commands.reportSidebarOverlay).toHaveBeenLastCalledWith("closed");
  });

  it("hears the toggles and swipes the backend routes to it (У4, У11)", () => {
    const { result } = renderOverlay();
    command({ kind: "toggle" });
    expect(result.current.open).toBe(true);
    command({ kind: "toggle" });
    expect(result.current.open).toBe(false);
    // Right opens, left closes; a repeat changes nothing.
    command({ kind: "swipe", open: true });
    command({ kind: "swipe", open: true });
    expect(result.current.open).toBe(true);
    command({ kind: "swipe", open: false });
    expect(result.current.open).toBe(false);
  });

  it("leaves to the sidebar beside the feed a command that came after the window widened", () => {
    window.innerWidth = 1200;
    const { result, options } = renderOverlay();
    expect(result.current.narrow).toBe(false);
    expect(commands.reportSidebarOverlay).toHaveBeenLastCalledWith("beside");
    command({ kind: "swipe", open: false });
    expect(options.onBesideIntent).toHaveBeenCalledWith({ kind: "swipe", open: false });
    // Opening does nothing beside the feed.
    act(() => result.current.openOverlay());
    expect(result.current.open).toBe(false);
  });

  it("stands beside the feed, shown, when the window widens while it is open (У7)", () => {
    const { result, options } = renderOverlay();
    act(() => result.current.openOverlay());
    resizeTo(800);
    expect(result.current.narrow).toBe(false);
    expect(result.current.open).toBe(false);
    expect(options.onWidenWhileOpen).toHaveBeenCalledTimes(1);
    expect(commands.reportSidebarOverlay).toHaveBeenLastCalledWith("beside");

    // Narrowing again, it comes over the feed closed.
    resizeTo(739);
    expect(result.current.narrow).toBe(true);
    expect(result.current.open).toBe(false);
  });

  it("does not show the sidebar beside the feed when the window widens with it closed (У7)", () => {
    const { options } = renderOverlay();
    resizeTo(740);
    expect(options.onWidenWhileOpen).not.toHaveBeenCalled();
  });

  it("closes when the tab is hidden and comes back closed (У8)", () => {
    const { result } = renderOverlay();
    act(() => result.current.openOverlay());
    act(() => setTabVisible(false));
    expect(result.current.open).toBe(false);
    act(() => setTabVisible(true));
    expect(result.current.open).toBe(false);
  });

  it("says beside when the page leaves its space", async () => {
    const { result, unmount } = renderOverlay();
    act(() => result.current.openOverlay());
    unmount();
    expect(commands.reportSidebarOverlay).toHaveBeenLastCalledWith("beside");
    // The subscription stops once it has settled.
    await act(async () => {});
    expect(page.handlers.has(SIDEBAR_OVERLAY_COMMAND_EVENT)).toBe(false);
  });

  it("neither reports nor listens on a page that is not a tab", () => {
    renderOverlay({ tab: false });
    expect(commands.reportSidebarOverlay).not.toHaveBeenCalled();
    expect(page.handlers.has(SIDEBAR_OVERLAY_COMMAND_EVENT)).toBe(false);
  });

  it("says beside, closed or open to the backend", () => {
    expect(sidebarOverlayReport(false, false)).toBe("beside");
    expect(sidebarOverlayReport(false, true)).toBe("beside");
    expect(sidebarOverlayReport(true, false)).toBe("closed");
    expect(sidebarOverlayReport(true, true)).toBe("open");
  });
});
