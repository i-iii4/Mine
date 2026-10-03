import { act, render, screen, waitFor } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DropHover, SidebarLayout, TabBarState } from "@/types";
import { TabBarApp } from "./TabBarApp";

const webview = vi.hoisted(() => {
  const handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();
  return {
    handlers,
    listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    }),
  };
});

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ listen: webview.listen }),
}));

const commands = vi.hoisted(() => ({
  getTabbarBootstrap: vi.fn<() => Promise<TabBarState | null>>(),
  reportDropSlot: vi.fn(async () => undefined),
  setWindowSidebar: vi.fn(async () => undefined),
  startWindowDrag: vi.fn(async () => undefined),
  activateAdjacentTab: vi.fn(async () => undefined),
  activateTab: vi.fn(async () => undefined),
  beginTabDrag: vi.fn(async () => undefined),
  closeOtherTabs: vi.fn(async () => undefined),
  closeTab: vi.fn(async () => undefined),
  moveTab: vi.fn(async () => undefined),
  moveTabToNewWindow: vi.fn(async () => undefined),
  newTab: vi.fn(async () => undefined),
}));

vi.mock("@/lib/commands", () => commands);

/** Deliver `payload` as the backend would to this page's own listeners. */
function emitToPage(event: string, payload: unknown) {
  act(() => {
    for (const handler of webview.handlers.get(event) ?? []) handler({ payload });
  });
}

function barState(overrides: Partial<TabBarState> = {}): TabBarState {
  return {
    window_id: "w1",
    tabs: [{ id: "a", space_name: "Mine", collection: null, live: true }],
    active_tab: "a",
    sidebar: { width_px: 240, collapsed: false },
    fullscreen: false,
    chrome_rows: { tab_bar: 30, page: 30 },
    ...overrides,
  };
}

/** A start answer the test releases when it wants. */
function deferredBootstrap() {
  let resolve: (value: TabBarState | null) => void = () => undefined;
  commands.getTabbarBootstrap.mockImplementation(
    () => new Promise<TabBarState | null>((settle) => {
      resolve = settle;
    }),
  );
  return (value: TabBarState | null) => act(async () => resolve(value));
}

beforeEach(() => {
  webview.handlers.clear();
  webview.listen.mockClear();
  for (const command of Object.values(commands)) command.mockClear();
  commands.getTabbarBootstrap.mockResolvedValue(barState());
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear();
});

describe("tab bar page", () => {
  it("shows the chrome row before the window's state and the tabs after it", async () => {
    const answer = deferredBootstrap();
    const { container } = render(<TabBarApp />);

    expect(container.querySelector("[data-tab-bar-pending] [data-traffic-light-reserve]")).not.toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();

    await answer(barState());
    expect(screen.getByRole("tab", { name: /Mine/ })).toHaveAttribute("aria-selected", "true");
  });

  it("subscribes through its own page only (В22)", async () => {
    render(<TabBarApp />);
    await screen.findByRole("tab");

    const events = webview.listen.mock.calls.map(([event]) => event);
    expect(events).toEqual(
      expect.arrayContaining(["tabbar-state", "window-sidebar-changed", "tabbar-drop-hover", "settings-changed"]),
    );
    expect(listen).not.toHaveBeenCalled();
  });

  it("follows the state the backend sends", async () => {
    render(<TabBarApp />);
    await screen.findByRole("tab");

    emitToPage("tabbar-state", barState({
      tabs: [
        { id: "a", space_name: "Mine", collection: null, live: true },
        { id: "b", space_name: "Archive", collection: "Posters", live: false },
      ],
      active_tab: "b",
    }));

    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: /Posters/ })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps a state the backend sent over an older start answer", async () => {
    const answer = deferredBootstrap();
    render(<TabBarApp />);

    emitToPage("tabbar-state", barState({ tabs: [{ id: "n", space_name: "Newer", collection: null, live: true }], active_tab: "n" }));
    await answer(barState());

    expect(screen.getByRole("tab", { name: /Newer/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Mine/ })).toBeNull();
  });

  it("follows the window's sidebar (В56)", async () => {
    render(<TabBarApp />);
    await screen.findByRole("button", { name: "Hide Sidebar" });

    const collapsed: SidebarLayout = { width_px: 240, collapsed: true };
    emitToPage("window-sidebar-changed", collapsed);

    expect(screen.getByRole("button", { name: "Show Sidebar" })).toHaveAttribute("aria-pressed", "false");
  });

  it("applies a sidebar change that came before the start answer", async () => {
    const answer = deferredBootstrap();
    render(<TabBarApp />);

    emitToPage("window-sidebar-changed", { width_px: 300, collapsed: true });
    await answer(barState());

    expect(screen.getByRole("button", { name: "Show Sidebar" })).toBeInTheDocument();
  });

  it("reports where a tab from another window would land (В63)", async () => {
    render(<TabBarApp />);
    await screen.findByRole("tab");

    const hover: DropHover = { tab_id: "x", x: 5 };
    emitToPage("tabbar-drop-hover", hover);
    expect(commands.reportDropSlot).toHaveBeenCalledWith(0);
  });

  it("takes the theme the settings window chooses", async () => {
    render(<TabBarApp />);
    await screen.findByRole("tab");

    emitToPage("settings-changed", { key: "theme", value: "dark" });
    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "dark"));

    emitToPage("settings-changed", { key: "theme", value: "system" });
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });

  it("stops listening when it goes", async () => {
    const { unmount } = render(<TabBarApp />);
    await screen.findByRole("tab");
    unmount();
    for (const handlers of webview.handlers.values()) expect(handlers.size).toBe(0);
  });
});
