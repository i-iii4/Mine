import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import {
  FOCUS_RETURN_GRACE_MS,
  OPEN_DEADLINE_MS,
  OUTSIDE_PRESS_GRACE_MS,
  SHOW_DEADLINE_MS,
  focusReturnsFromMenuPanel,
  openMenuPanel,
  resetMenuPanelSourceForTests,
  type MenuPanelHandlers,
} from "./menuPanelSource";
import {
  MENU_PANEL_ACTION_EVENT,
  MENU_PANEL_ANSWER_EVENT,
  MENU_PANEL_CLOSED_EVENT,
  MENU_PANEL_LABEL,
  MENU_PANEL_SHOWN_EVENT,
  type CardMenuPayload,
} from "./menuPanelProtocol";
import { cardMenuEntries } from "./cardMenuEntries";

const PAYLOAD: CardMenuPayload = {
  opener: { kind: "plate", align: "end" },
  byKey: false,
  buttons: null,
  entries: cardMenuEntries({ hasUrl: true, disconnectFrom: null, tableCommands: [] }),
  picker: { blockSlug: "card", selectedTags: [], tags: [{ tag: "Web", count: 2 }], currentTag: null },
};
const ANCHOR = { x: 100, y: 100, width: 24, height: 24 };

function backend(event: string, payload: unknown) {
  window.dispatchEvent(new CustomEvent(event, { detail: { event, payload } }));
}

function handlers() {
  return {
    onAction: vi.fn<MenuPanelHandlers["onAction"]>(() => ({ kind: "done" })),
    onClosed: vi.fn<MenuPanelHandlers["onClosed"]>(),
    onRefused: vi.fn<MenuPanelHandlers["onRefused"]>(),
  };
}

function invokes(name: string) {
  return vi.mocked(invoke).mock.calls.filter(([command]) => command === name);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetMenuPanelSourceForTests(true);
  vi.mocked(invoke).mockReset();
  vi.mocked(emitTo).mockClear();
});

afterEach(() => {
  resetMenuPanelSourceForTests();
  vi.useRealTimers();
});

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("openMenuPanel", () => {
  it("asks the backend to open with the anchor, the payload and the input's time", async () => {
    vi.mocked(invoke).mockResolvedValue({ menu: 7 });
    const on = handlers();
    openMenuPanel(ANCHOR, PAYLOAD, on, { contextMenu: false, eventAt: 1234 });
    await settle();
    expect(invokes("menu_panel_open")[0]?.[1]).toEqual({ request: { anchor: ANCHOR, payload: JSON.stringify(PAYLOAD), event_at: 1234 } });
    expect(on.onRefused).not.toHaveBeenCalled();
  });

  it("opens on the page when the backend refuses", async () => {
    vi.mocked(invoke).mockRejectedValue({ kind: "not_ready" });
    const on = handlers();
    openMenuPanel(ANCHOR, PAYLOAD, on, { contextMenu: false, eventAt: 1 });
    await settle();
    expect(on.onRefused).toHaveBeenCalledTimes(1);
    expect(focusReturnsFromMenuPanel()).toBe(true);
    vi.advanceTimersByTime(FOCUS_RETURN_GRACE_MS);
    expect(focusReturnsFromMenuPanel()).toBe(false);
  });

  it("opens on the page when the backend does not answer in time", async () => {
    vi.mocked(invoke).mockImplementation(() => new Promise(() => undefined));
    const on = handlers();
    openMenuPanel(ANCHOR, PAYLOAD, on, { contextMenu: false, eventAt: 1 });
    await vi.advanceTimersByTimeAsync(OPEN_DEADLINE_MS);
    expect(on.onRefused).toHaveBeenCalledTimes(1);
  });

  it("opens on the page and closes the panel's menu when the panel does not show it", async () => {
    vi.mocked(invoke).mockResolvedValue({ menu: 3 });
    const on = handlers();
    openMenuPanel(ANCHOR, PAYLOAD, on, { contextMenu: false, eventAt: 1 });
    await settle();
    await vi.advanceTimersByTimeAsync(SHOW_DEADLINE_MS);
    expect(on.onRefused).toHaveBeenCalledTimes(1);
    expect(invokes("menu_panel_close").map(([, args]) => args)).toEqual([{ menu: 3, reason: "unresponsive" }]);
  });

  it("keeps the menu once shown and reports the reason it closed", async () => {
    vi.mocked(invoke).mockResolvedValue({ menu: 4 });
    const on = handlers();
    openMenuPanel(ANCHOR, PAYLOAD, on, { contextMenu: false, eventAt: 1 });
    await settle();
    backend(MENU_PANEL_SHOWN_EVENT, { menu: 4 });
    await vi.advanceTimersByTimeAsync(SHOW_DEADLINE_MS * 2);
    expect(on.onRefused).not.toHaveBeenCalled();
    // A late word for another menu is dropped.
    backend(MENU_PANEL_CLOSED_EVENT, { menu: 99, reason: "chosen" });
    expect(on.onClosed).not.toHaveBeenCalled();
    backend(MENU_PANEL_CLOSED_EVENT, { menu: 4, reason: "escape" });
    expect(on.onClosed).toHaveBeenCalledWith("escape");
  });

  it("takes the backend's word that came before its answer", async () => {
    let answer: (ticket: { menu: number }) => void = () => undefined;
    vi.mocked(invoke).mockImplementation(() => new Promise((resolve) => {
      answer = resolve;
    }));
    const on = handlers();
    openMenuPanel(ANCHOR, PAYLOAD, on, { contextMenu: false, eventAt: 1 });
    await settle();
    backend(MENU_PANEL_SHOWN_EVENT, { menu: 5 });
    answer({ menu: 5 });
    await settle();
    await vi.advanceTimersByTimeAsync(SHOW_DEADLINE_MS * 2);
    expect(on.onRefused).not.toHaveBeenCalled();
  });

  it("opens on the page when the menu closed before it showed", async () => {
    vi.mocked(invoke).mockResolvedValue({ menu: 6 });
    const on = handlers();
    openMenuPanel(ANCHOR, PAYLOAD, on, { contextMenu: false, eventAt: 1 });
    await settle();
    backend(MENU_PANEL_CLOSED_EVENT, { menu: 6, reason: "failed" });
    expect(on.onRefused).toHaveBeenCalledTimes(1);
    expect(on.onClosed).not.toHaveBeenCalled();
  });

  it("runs each choice of the panel with the tab's handlers and answers it", async () => {
    vi.mocked(invoke).mockResolvedValue({ menu: 8 });
    const on = handlers();
    on.onAction.mockImplementation(async () => ({ kind: "membership" as const, made: true }));
    openMenuPanel(ANCHOR, PAYLOAD, on, { contextMenu: false, eventAt: 1 });
    await settle();
    backend(MENU_PANEL_SHOWN_EVENT, { menu: 8 });
    backend(MENU_PANEL_ACTION_EVENT, { menu: 8, request: 2, action: { kind: "toggle", tag: "Web", hasTag: false } });
    // Not a choice: dropped.
    backend(MENU_PANEL_ACTION_EVENT, { menu: 8, request: 3, action: { kind: "format-disk" } });
    await settle();
    expect(on.onAction).toHaveBeenCalledTimes(1);
    expect(on.onAction).toHaveBeenCalledWith({ kind: "toggle", tag: "Web", hasTag: false });
    expect(emitTo).toHaveBeenCalledWith(MENU_PANEL_LABEL, MENU_PANEL_ANSWER_EVENT, {
      menu: 8,
      request: 2,
      answer: { kind: "membership", made: true },
    });
  });

  it("answers a failed choice as not made", async () => {
    vi.mocked(invoke).mockResolvedValue({ menu: 9 });
    const on = handlers();
    on.onAction.mockImplementation(async () => {
      throw new Error("disk");
    });
    openMenuPanel(ANCHOR, PAYLOAD, on, { contextMenu: false, eventAt: 1 });
    await settle();
    backend(MENU_PANEL_SHOWN_EVENT, { menu: 9 });
    backend(MENU_PANEL_ACTION_EVENT, { menu: 9, request: 1, action: { kind: "toggle", tag: "Web", hasTag: true } });
    await settle();
    expect(emitTo).toHaveBeenCalledWith(MENU_PANEL_LABEL, MENU_PANEL_ANSWER_EVENT, {
      menu: 9,
      request: 1,
      answer: { kind: "membership", made: false },
    });
  });

  it("closes from the tab without reporting back, and closes a menu the backend names later", async () => {
    let answer: (ticket: { menu: number }) => void = () => undefined;
    vi.mocked(invoke).mockImplementation((command) => command === "menu_panel_open"
      ? new Promise((resolve) => {
        answer = resolve;
      })
      : Promise.resolve(null));
    const on = handlers();
    const session = openMenuPanel(ANCHOR, PAYLOAD, on, { contextMenu: false, eventAt: 1 });
    await settle();
    session.close("source");
    answer({ menu: 10 });
    await settle();
    expect(invokes("menu_panel_close").map(([, args]) => args)).toEqual([{ menu: 10, reason: "source" }]);
    expect(on.onClosed).not.toHaveBeenCalled();
    expect(on.onRefused).not.toHaveBeenCalled();
  });

  it("replaces an open menu of the page, telling its owner", async () => {
    vi.mocked(invoke).mockResolvedValue({ menu: 11 });
    const first = handlers();
    openMenuPanel(ANCHOR, PAYLOAD, first, { contextMenu: false, eventAt: 1 });
    await settle();
    const second = handlers();
    openMenuPanel(ANCHOR, PAYLOAD, second, { contextMenu: false, eventAt: 2 });
    expect(first.onClosed).toHaveBeenCalledWith("source");
    expect(second.onClosed).not.toHaveBeenCalled();
  });
});

describe("the page while the menu is in the panel", () => {
  it("only closes the menu on a press, and holds the press and its click", async () => {
    vi.mocked(invoke).mockResolvedValue({ menu: 12 });
    openMenuPanel(ANCHOR, PAYLOAD, handlers(), { contextMenu: false, eventAt: 1 });
    await settle();
    backend(MENU_PANEL_SHOWN_EVENT, { menu: 12 });
    const button = document.createElement("button");
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    document.body.append(button);
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(clicked).not.toHaveBeenCalled();
    expect(invokes("menu_panel_close").map(([, args]) => args)).toEqual([{ menu: 12, reason: "outside" }]);
    expect(document.documentElement.hasAttribute("data-menu-open")).toBe(true);
    button.remove();
  });

  it("holds the press that closed it elsewhere for a moment, then lets presses through", async () => {
    vi.mocked(invoke).mockResolvedValue({ menu: 13 });
    openMenuPanel(ANCHOR, PAYLOAD, handlers(), { contextMenu: false, eventAt: 1 });
    await settle();
    backend(MENU_PANEL_SHOWN_EVENT, { menu: 13 });
    backend(MENU_PANEL_CLOSED_EVENT, { menu: 13, reason: "outside" });
    const button = document.createElement("button");
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    document.body.append(button);
    // The page's own event of the press that closed the menu, after the
    // backend's word: held.
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(clicked).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(OUTSIDE_PRESS_GRACE_MS);
    expect(document.documentElement.hasAttribute("data-menu-open")).toBe(false);
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(clicked).toHaveBeenCalledTimes(1);
    button.remove();
  });

  it("counts the window's focus as the panel giving the keyboard back while open and just after", async () => {
    vi.mocked(invoke).mockResolvedValue({ menu: 14 });
    expect(focusReturnsFromMenuPanel()).toBe(false);
    openMenuPanel(ANCHOR, PAYLOAD, handlers(), { contextMenu: false, eventAt: 1 });
    await settle();
    expect(focusReturnsFromMenuPanel()).toBe(true);
    backend(MENU_PANEL_SHOWN_EVENT, { menu: 14 });
    backend(MENU_PANEL_CLOSED_EVENT, { menu: 14, reason: "chosen" });
    expect(focusReturnsFromMenuPanel()).toBe(true);
    vi.advanceTimersByTime(FOCUS_RETURN_GRACE_MS);
    expect(focusReturnsFromMenuPanel()).toBe(false);
  });
});

describe("the backend's commands of the panel", () => {
  it("name the commands and their arguments as the backend declares them", async () => {
    const { closeMenuPanel, prepareMenuPanelWindow, reportMenuPanelPainted, reportMenuPanelReady, showMenuPanel } =
      await import("./menuPanelCommands");
    vi.mocked(invoke).mockResolvedValue({ ready: true });
    await prepareMenuPanelWindow({ width: 556, height: 421 });
    await reportMenuPanelReady();
    await showMenuPanel(3, { x: 1, y: 2 });
    await closeMenuPanel(3, "escape");
    await reportMenuPanelPainted({ menu: 3, frame_at: 10, opener: "point" });
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["menu_panel_prepare", { size: { width: 556, height: 421 } }],
      ["menu_panel_ready"],
      ["menu_panel_show", { menu: 3, origin: { x: 1, y: 2 } }],
      ["menu_panel_close", { menu: 3, reason: "escape" }],
      ["menu_panel_painted", { paint: { menu: 3, frame_at: 10, opener: "point" } }],
    ]);
  });
});

describe("a choice that comes after the closing it caused", () => {
  it("still runs with the tab's handlers", async () => {
    vi.mocked(invoke).mockResolvedValue({ menu: 15 });
    const on = handlers();
    openMenuPanel(ANCHOR, PAYLOAD, on, { contextMenu: false, eventAt: 1 });
    await settle();
    backend(MENU_PANEL_SHOWN_EVENT, { menu: 15 });
    backend(MENU_PANEL_CLOSED_EVENT, { menu: 15, reason: "chosen" });
    backend(MENU_PANEL_ACTION_EVENT, { menu: 15, request: 1, action: { kind: "run", id: "rename" } });
    await settle();
    expect(on.onAction).toHaveBeenCalledWith({ kind: "run", id: "rename" });
  });

  it("is dropped for a menu that never showed", async () => {
    vi.mocked(invoke).mockResolvedValue({ menu: 16 });
    const on = handlers();
    openMenuPanel(ANCHOR, PAYLOAD, on, { contextMenu: false, eventAt: 1 });
    await settle();
    backend(MENU_PANEL_ACTION_EVENT, { menu: 16, request: 1, action: { kind: "run", id: "delete" } });
    await settle();
    expect(on.onAction).not.toHaveBeenCalled();
  });
});
