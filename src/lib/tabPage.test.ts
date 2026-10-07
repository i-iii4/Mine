import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabView } from "@/types";
import {
  TAB_VIEW_REPORT_DEBOUNCE_MS,
  createTabViewReporter,
  sameTabView,
  tabLocationOf,
  tabLocationPath,
  takeLegacyTabState,
} from "./tabPage";

const view = (overrides: Partial<TabView> = {}): TabView => ({
  location: { kind: "everything" },
  mode: "grid",
  open_card: null,
  scroll_anchor: null,
  collection_filter: "",
  ...overrides,
});

describe("createTabViewReporter (SPEC_TABS.md, В31)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the latest view once per interval, however many changes came in it", () => {
    let current = view();
    const send = vi.fn(async (_view: TabView) => {});
    const reporter = createTabViewReporter({ read: () => current, send, lastReported: view() });

    current = view({ mode: "graph" });
    reporter.schedule();
    current = view({ mode: "graph", collection_filter: "a" });
    reporter.schedule();
    vi.advanceTimersByTime(TAB_VIEW_REPORT_DEBOUNCE_MS - 1);
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(view({ mode: "graph", collection_filter: "a" }));
  });

  it("keeps reporting during a long run of changes, at most once per interval", () => {
    let offset = 0;
    const send = vi.fn(async (_view: TabView) => {});
    const reporter = createTabViewReporter({
      read: () => view({ scroll_anchor: { slug: "card", offset_px: offset } }),
      send,
      lastReported: view(),
    });
    for (let step = 0; step < 10; step += 1) {
      offset = step;
      reporter.schedule();
      vi.advanceTimersByTime(TAB_VIEW_REPORT_DEBOUNCE_MS / 2);
    }
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("does not repeat what the backend already holds", () => {
    const send = vi.fn(async (_view: TabView) => {});
    const saved = view({ location: { kind: "collection", tag: "x" } });
    const reporter = createTabViewReporter({ read: () => saved, send, lastReported: saved });
    reporter.schedule();
    vi.advanceTimersByTime(TAB_VIEW_REPORT_DEBOUNCE_MS);
    reporter.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the first view when the backend's is unknown", () => {
    const send = vi.fn(async (_view: TabView) => {});
    const reporter = createTabViewReporter({ read: () => view(), send, lastReported: null });
    reporter.flush();
    expect(send).toHaveBeenCalledWith(view());
  });

  it("flushes at once and drops the pending report; nothing goes out after dispose", () => {
    let current = view({ mode: "graph" });
    const send = vi.fn(async (_view: TabView) => {});
    const reporter = createTabViewReporter({ read: () => current, send, lastReported: view() });
    reporter.schedule();
    reporter.flush();
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TAB_VIEW_REPORT_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(1);

    current = view();
    reporter.schedule();
    reporter.dispose();
    vi.advanceTimersByTime(TAB_VIEW_REPORT_DEBOUNCE_MS);
    reporter.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("logs a failed report instead of throwing it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reporter = createTabViewReporter({
      read: () => view({ mode: "graph" }),
      send: async () => {
        throw new Error("gone");
      },
      lastReported: view(),
    });
    reporter.flush();
    await vi.runAllTimersAsync();
    expect(error).toHaveBeenCalledWith("Could not report the tab's view:", expect.any(Error));
    error.mockRestore();
  });
});

describe("takeLegacyTabState (В79)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("takes the stored mode and sidebar and deletes them with the recent collections", () => {
    localStorage.setItem("mine.mainViewMode", "graph");
    localStorage.setItem("mine:sidebar", JSON.stringify({ width: 412.6, collapsed: true }));
    localStorage.setItem("mine:recentTags", "[\"a\"]");
    localStorage.setItem("arena:recentTags", "[\"b\"]");
    localStorage.setItem("mine.theme", "dark");

    expect(takeLegacyTabState()).toEqual({ mode: "graph", sidebar: { width_px: 413, collapsed: true } });
    for (const key of ["mine.mainViewMode", "mine:sidebar", "mine:recentTags", "arena:recentTags"]) {
      expect(localStorage.getItem(key)).toBeNull();
    }
    // Settings of the whole app stay where they are.
    expect(localStorage.getItem("mine.theme")).toBe("dark");
    // Taken once: the next page finds nothing.
    expect(takeLegacyTabState()).toEqual({ mode: null, sidebar: null });
  });

  it("reads the oldest sidebar key and ignores values it cannot read", () => {
    localStorage.setItem("arena:sidebar", JSON.stringify({ width: 300, collapsed: false }));
    expect(takeLegacyTabState().sidebar).toEqual({ width_px: 300, collapsed: false });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    localStorage.setItem("mine.mainViewMode", "table");
    localStorage.setItem("mine:sidebar", "{not json");
    expect(takeLegacyTabState()).toEqual({ mode: null, sidebar: null });
    localStorage.setItem("mine:sidebar", JSON.stringify({ width: "wide", collapsed: false }));
    expect(takeLegacyTabState()).toEqual({ mode: null, sidebar: null });
    warn.mockRestore();
  });
});

describe("tab view helpers", () => {
  it("compares two memories of a tab by what they say", () => {
    expect(sameTabView(view(), view())).toBe(true);
    expect(sameTabView(view(), view({ collection_filter: "a" }))).toBe(false);
    expect(sameTabView(
      view({ open_card: { slug: "x", title: "X" } }),
      view({ open_card: { slug: "y", title: "X" } }),
    )).toBe(false);
  });

  it("maps places to routes and back", () => {
    expect(tabLocationPath({ kind: "everything" })).toBe("/");
    expect(tabLocationPath({ kind: "collection", tag: "Красивый веб" }))
      .toBe(`/channel/${encodeURIComponent("Красивый веб")}`);
    expect(tabLocationOf(undefined)).toEqual({ kind: "everything" });
    expect(tabLocationOf("x")).toEqual({ kind: "collection", tag: "x" });
  });
});
