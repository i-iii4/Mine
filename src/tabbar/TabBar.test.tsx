import { MOTION_MOVE_EASE, MOTION_MOVE_MS } from "@/lib/motion";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { setMotionLevel } from "@/test/motionLevel";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { DropHover, TabBarState, TabBarTab } from "@/types";
import { TAB_BAR_HEIGHT_PX, TAB_DETACH_THRESHOLD_PX, TAB_MAX_WIDTH_PX, TAB_MIN_WIDTH_PX } from "./constants";
import {
  BACK_LABEL,
  CLOSE_TAB_BUTTON_LABEL,
  FORWARD_LABEL,
  NEW_TAB_LABEL,
  SEARCH_LABEL,
  SETTINGS_MENU_LABEL,
  TAB_LIST_LABEL,
  TabBar,
} from "./TabBar";
import type { TabMenuActions } from "./tabMenu";

const commands = vi.hoisted(() => ({
  activateAdjacentTab: vi.fn(async () => undefined),
  activateTab: vi.fn(async () => undefined),
  beginTabDrag: vi.fn(async () => undefined),
  closeOtherTabs: vi.fn(async () => undefined),
  closeTab: vi.fn(async () => undefined),
  closeTabsBeside: vi.fn(async () => undefined),
  moveTab: vi.fn(async () => undefined),
  moveTabToNewWindow: vi.fn(async () => undefined),
  newTab: vi.fn(async () => undefined),
  openSettingsWindow: vi.fn(async () => undefined),
  reportDropSlot: vi.fn(async () => undefined),
  toggleWindowSidebar: vi.fn(async () => undefined),
  startWindowDrag: vi.fn(async () => undefined),
  stepTabHistory: vi.fn(async () => undefined),
  openTabSearch: vi.fn(async () => undefined),
}));

vi.mock("@/lib/commands", () => commands);

const menu = vi.hoisted(() => {
  const state = {
    actions: null as TabMenuActions | null,
    open: vi.fn(async () => undefined),
    create: vi.fn(async (actions: TabMenuActions) => {
      state.actions = actions;
      return { open: state.open };
    }),
  };
  return state;
});

vi.mock("./tabMenu", () => ({ createTabMenu: menu.create }));

const settingsMenu = vi.hoisted(() => {
  const state = {
    actions: null as { openSection: (section: string) => void } | null,
    open: vi.fn(async (_at: { x: number; y: number }) => undefined),
    create: vi.fn(async (actions: { openSection: (section: string) => void }) => {
      state.actions = actions;
      return { open: state.open };
    }),
  };
  return state;
});

vi.mock("./settingsMenu", () => ({ createSettingsMenu: settingsMenu.create }));

const settingsChanged = vi.hoisted(() => ({ broadcastSettingsChange: vi.fn() }));
vi.mock("@/lib/settingsChanged", () => settingsChanged);

// A failed command of the bar goes to the log only (decision of 14.10.2026).
const tabBarFailure = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock("@/lib/tabBarFailure", async (original) => ({
  ...(await original<typeof import("@/lib/tabBarFailure")>()),
  logTabBarFailure: tabBarFailure.log,
}));

/** The zone the tabs and `+` share, and the slot `+` takes from it. */
const NEW_TAB_SLOT_PX = 32;
let zoneWidth = 1000;
const available = () => zoneWidth - NEW_TAB_SLOT_PX;

function tab(
  id: string,
  space_name: string | null = "Mine",
  place: string | null = null,
  overrides: Partial<TabBarTab> = {},
): TabBarTab {
  return {
    id,
    space_name,
    place,
    card: null,
    live: true,
    history: { back: false, forward: false },
    ...overrides,
  };
}

function barState(tabs: TabBarTab[], overrides: Partial<TabBarState> = {}): TabBarState {
  return {
    window_id: "w1",
    tabs,
    active_tab: tabs[0]?.id ?? "",
    sidebar_shown: true,
    fullscreen: false,
    ...overrides,
  };
}

function letters(count: number): TabBarTab[] {
  return Array.from({ length: count }, (_, index) => tab(`t${index}`, `Space ${index}`));
}

function renderBar(bar: TabBarState, dropHover: DropHover | null = null) {
  const view = render(<TabBar bar={bar} dropHover={dropHover} />);
  return {
    ...view,
    update: (next: TabBarState, nextHover: DropHover | null = dropHover) =>
      view.rerender(<TabBar bar={next} dropHover={nextHover} />),
  };
}

const tabsShown = () => screen.getAllByRole("tab");
const tabById = (id: string) => {
  const found = tabsShown().find((node) => node.dataset.tabId === id);
  if (!found) throw new Error(`no tab ${id}`);
  return found;
};
const widthOf = (node: HTMLElement) => Number.parseFloat(node.style.width);
const strip = () => screen.getByRole("tablist", { name: TAB_LIST_LABEL });

let spies: MockInstance[] = [];

beforeEach(() => {
  zoneWidth = 1000;
  for (const command of Object.values(commands)) command.mockClear();
  menu.open.mockClear();
  menu.actions = null;
  menu.create.mockClear();
  settingsMenu.open.mockClear();
  settingsMenu.actions = null;
  settingsMenu.create.mockClear();
  spies = [
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
      return this.hasAttribute("data-tab-zone") ? zoneWidth : 0;
    }),
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-tab-bar-new-tab-slot") ? NEW_TAB_SLOT_PX : 0;
    }),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});


/** How neighbours make room for a dragged tab: Перемещение, 200 ms on the
 *  move curve. */
const TAB_SHIFT = `transform ${MOTION_MOVE_MS}ms ${MOTION_MOVE_EASE}`;

describe("a tab that could not open (Е2.9)", () => {
  // Decision of 14.10.2026: no text and no mark; selecting the tab makes its
  // page again, and why it failed is in the log.
  it("shows no mark and no reason, and opens on selection", () => {
    renderBar(barState([tab("ok"), tab("failed", "Mine", "Posters")]));
    const failed = tabById("failed");
    expect(failed.querySelector(".text-destructive")).toBeNull();
    expect(failed.title).toBe("Posters");
    expect(failed.textContent).not.toMatch(/could not/i);
    fireEvent.click(failed);
    expect(commands.activateTab).toHaveBeenCalledWith("failed");
  });
});

describe("tab bar row (В43)", () => {
  it("lays out the reserve, the sidebar button, back and forward, the tabs and + after them", () => {
    const { container } = renderBar(barState([tab("a"), tab("b")]));

    const header = container.querySelector("header[data-tab-bar]");
    expect(header).not.toBeNull();
    expect(header?.className).toContain("bg-accent");
    const reserve = header?.querySelector("[data-traffic-light-reserve]");
    const toggle = screen.getByRole("button", { name: "Hide Sidebar" });
    const back = screen.getByRole("button", { name: BACK_LABEL });
    const forward = screen.getByRole("button", { name: FORWARD_LABEL });
    const newTabButton = screen.getByRole("button", { name: NEW_TAB_LABEL });
    const search = screen.getByRole("button", { name: SEARCH_LABEL });
    const settings = screen.getByRole("button", { name: SETTINGS_MENU_LABEL });
    const order = [
      reserve,
      toggle,
      back,
      forward,
      strip(),
      newTabButton,
      header?.querySelector("[data-tab-bar-drag-area]"),
      search,
      settings,
    ];
    for (let index = 1; index < order.length; index += 1) {
      const before = order[index - 1];
      const after = order[index];
      expect(before && after && before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // The lights' room at the compact title bar (В83).
    expect((reserve as HTMLElement | null)?.style.width).toBe("84.5px");
  });

  it("gives the traffic lights' place back in full screen", () => {
    const { container } = renderBar(barState([tab("a")], { fullscreen: true }));
    expect(container.querySelector("header[data-fullscreen='true'] [data-traffic-light-reserve]")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Hide Sidebar" });
    expect(toggle.closest("div.pl-\\[var\\(--chrome-edge-pad\\)\\]")).not.toBeNull();
  });

  it("toggles the window's sidebar through the backend, which decides where it goes (В56, 47.3b)", () => {
    const { update } = renderBar(barState([tab("a")]));

    fireEvent.click(screen.getByRole("button", { name: "Hide Sidebar" }));
    expect(commands.toggleWindowSidebar).toHaveBeenCalledTimes(1);

    // Hidden beside the feed or closed over it: the bar knows only that it
    // is not on screen (SPEC_NARROW_WINDOW.md, У4).
    update(barState([tab("a")], { sidebar_shown: false }));
    const show = screen.getByRole("button", { name: "Show Sidebar" });
    expect(show).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(show);
    expect(commands.toggleWindowSidebar).toHaveBeenCalledTimes(2);
  });

  it("ends with the logo, whose native menu opens the settings at a section", async () => {
    renderBar(barState([tab("a")]));
    const settings = screen.getByRole("button", { name: SETTINGS_MENU_LABEL });
    expect(settings.querySelector("[data-mine-logo]")).not.toBeNull();
    // At the window's right edge, inset like every chrome row's last button;
    // the inset is the slot's padding, so it moves the window too.
    expect(settings.closest("[data-chrome-actions]")?.className).toContain("pr-[var(--chrome-edge-pad)]");

    fireEvent.click(settings);
    await act(async () => {});
    expect(settingsMenu.create).toHaveBeenCalledTimes(1);
    expect(settingsMenu.open).toHaveBeenCalledTimes(1);
    settingsMenu.actions?.openSection("spaces");
    expect(commands.openSettingsWindow).toHaveBeenCalledWith("spaces");
  });

  it("opens the search of the window's visible tab from the button before the logo (07.10.2026)", () => {
    renderBar(barState([tab("a", "Mine"), tab("b", "Mine")]));
    const search = screen.getByRole("button", { name: SEARCH_LABEL });
    const settings = screen.getByRole("button", { name: SETTINGS_MENU_LABEL });
    expect(search.parentElement).toBe(settings.parentElement);
    expect(search.nextElementSibling).toBe(settings);
    expect(search.parentElement).toHaveClass("gap-1");
    expect(search).toHaveAttribute("aria-keyshortcuts", "Meta+F");

    fireEvent.click(search);
    expect(commands.openTabSearch).toHaveBeenCalledTimes(1);
  });

  it("opens a new tab with +", () => {
    renderBar(barState([tab("a")]));
    fireEvent.click(screen.getByRole("button", { name: NEW_TAB_LABEL }));
    expect(commands.newTab).toHaveBeenCalledWith();
  });

  it("does nothing with files dropped on it", () => {
    const { container } = renderBar(barState([tab("a")]));
    const header = container.querySelector("header[data-tab-bar]");
    if (!header) throw new Error("no bar");
    fireEvent.drop(header);
    for (const command of Object.values(commands)) expect(command).not.toHaveBeenCalled();
  });
});

describe("tab labels (В46, В47)", () => {
  it("names the space on Everything, the collection inside one and the open card deepest of all", () => {
    renderBar(barState([
      tab("a", "Mine"),
      tab("b", "Mine", "Beautiful web"),
      tab("c", "Mine", "Beautiful web", { card: "Stripe homepage" }),
    ]));

    expect(tabById("a")).toHaveTextContent("Mine");
    expect(tabById("a")).toHaveAttribute("title", "Mine");
    expect(tabById("b")).toHaveTextContent("Beautiful web");
    expect(tabById("b")).not.toHaveTextContent("Mine");
    expect(tabById("b")).toHaveAttribute("title", "Beautiful web");
    expect(tabById("c")).toHaveTextContent("Stripe homepage");
    expect(tabById("c")).toHaveAttribute("title", "Stripe homepage");
  });

  it("asks for a space on a tab without one", () => {
    renderBar(barState([tab("a", null)]));
    expect(tabById("a")).toHaveTextContent("Choose Space");
  });

  it("dissolves a label that does not fit, and only such a label", () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.textContent === "A label far too long for its tab" ? 500 : 0;
    });
    try {
      renderBar(barState([tab("a", "Mine"), tab("b", "Mine", "A label far too long for its tab")]));
      expect(tabById("a").querySelector("[data-tab-label]")).not.toHaveAttribute("data-overflow");
      expect(tabById("b").querySelector("[data-tab-label]")).toHaveAttribute("data-overflow", "true");
    } finally {
      scroll.mockRestore();
    }
  });
});

describe("tab look (В46)", () => {
  it("draws square tabs the height of the row, outlined by its lines", () => {
    renderBar(barState([tab("a"), tab("b"), tab("c")]));
    for (const node of tabsShown()) {
      expect(node.className).toContain("h-full");
      expect(node.className).toContain("border-r");
      expect(node.className).not.toMatch(/rounded/);
    }
    expect(tabById("a").className).toContain("border-l");
    expect(tabById("b").className).not.toContain("border-l");
  });

  it("gives the visible tab the chrome below it and no hover, the others the row's surface and a hover", () => {
    renderBar(barState([tab("a"), tab("b")], { active_tab: "b" }));
    expect(tabById("a")).toHaveAttribute("aria-selected", "false");
    expect(tabById("b")).toHaveAttribute("aria-selected", "true");
    expect(tabById("b").className).toContain("bg-chrome");
    expect(tabById("b").className).not.toContain("hover:");
    expect(tabById("a").className).not.toContain("bg-chrome");
    // The hover is a state layer: it is the surface of the close button on
    // the tab, so the plate lifts from it.
    expect(tabById("a").className).toContain("hover:state-active");
    expect(tabById("a")).not.toHaveAttribute("data-surface-zone");
    expect(tabById("a").className).toContain("hover:text-foreground");
  });

  it("gives every tab a close button that its hover shows", () => {
    renderBar(barState([tab("a"), tab("b")]));
    for (const id of ["a", "b"]) {
      const close = within(tabById(id)).getByRole("button", { name: CLOSE_TAB_BUTTON_LABEL });
      expect(close).toHaveAttribute("data-tab-close");
      expect(close).not.toHaveAttribute("data-visible");
      expect(close.className).toContain("absolute");
    }
  });
});

describe("back and forward (В81)", () => {
  it("follows the visible tab's places and asks it to step", () => {
    const { update } = renderBar(barState([
      tab("a", "Mine", null, { history: { back: true, forward: false } }),
      tab("b", "Mine", null, { history: { back: false, forward: true } }),
    ]));

    const back = screen.getByRole("button", { name: BACK_LABEL });
    const forward = screen.getByRole("button", { name: FORWARD_LABEL });
    expect(back).toBeEnabled();
    expect(forward).toBeDisabled();
    fireEvent.click(back);
    expect(commands.stepTabHistory).toHaveBeenCalledWith(false);

    update(barState([
      tab("a", "Mine", null, { history: { back: true, forward: false } }),
      tab("b", "Mine", null, { history: { back: false, forward: true } }),
    ], { active_tab: "b" }));
    expect(screen.getByRole("button", { name: BACK_LABEL })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: FORWARD_LABEL }));
    expect(commands.stepTabHistory).toHaveBeenLastCalledWith(true);
  });

  it("has nowhere to go on a tab without history", () => {
    renderBar(barState([tab("a")]));
    expect(screen.getByRole("button", { name: BACK_LABEL })).toBeDisabled();
    expect(screen.getByRole("button", { name: FORWARD_LABEL })).toBeDisabled();
  });
});

describe("tab widths (В48)", () => {
  it("gives every tab the same width up to the maximum", () => {
    renderBar(barState(letters(3)));
    for (const node of tabsShown()) expect(widthOf(node)).toBe(TAB_MAX_WIDTH_PX);
    expect(widthOf(strip())).toBe(3 * TAB_MAX_WIDTH_PX);
  });

  it("shares the room equally when the maximum does not fit", () => {
    renderBar(barState(letters(6)));
    const width = Math.floor(available() / 6);
    for (const node of tabsShown()) expect(widthOf(node)).toBe(width);
  });

  it("scrolls at the minimum width, keeps the visible tab in view and fades the hidden edges", () => {
    const tabs = letters(16);
    const { update } = renderBar(barState(tabs, { active_tab: "t15" }));

    for (const node of tabsShown()) expect(widthOf(node)).toBe(TAB_MIN_WIDTH_PX);
    expect(widthOf(strip())).toBe(available());
    expect(strip().scrollLeft).toBe(16 * TAB_MIN_WIDTH_PX - available());
    expect(strip()).toHaveAttribute("data-fade-left", "true");
    expect(strip()).not.toHaveAttribute("data-fade-right");

    update(barState(tabs, { active_tab: "t0" }));
    expect(strip().scrollLeft).toBe(0);
    expect(strip()).not.toHaveAttribute("data-fade-left");
    expect(strip()).toHaveAttribute("data-fade-right", "true");
  });

  it("updates the faded edges as the strip is scrolled", () => {
    renderBar(barState(letters(16)));
    strip().scrollLeft = 100;
    fireEvent.scroll(strip());
    expect(strip()).toHaveAttribute("data-fade-left", "true");
    expect(strip()).toHaveAttribute("data-fade-right", "true");
  });

  it("scrolls the strip by a horizontal turn over a button when the tabs overflow (SPEC_NARROW_WINDOW.md, У9)", () => {
    renderBar(barState(letters(16)));
    expect(strip().scrollLeft).toBe(0);
    fireEvent.wheel(screen.getByRole("button", { name: NEW_TAB_LABEL }), { deltaX: 60, deltaY: 2 });
    expect(strip().scrollLeft).toBe(60);
    expect(strip()).toHaveAttribute("data-fade-left", "true");
    fireEvent.wheel(screen.getByRole("button", { name: BACK_LABEL }), { deltaX: -1000, deltaY: 0 });
    expect(strip().scrollLeft).toBe(0);
    // A vertical turn is not the strip's.
    fireEvent.wheel(screen.getByRole("button", { name: NEW_TAB_LABEL }), { deltaX: 5, deltaY: 40 });
    expect(strip().scrollLeft).toBe(0);
  });

  it("moves nothing by a turn over a button when the tabs fit", () => {
    renderBar(barState(letters(3)));
    fireEvent.wheel(screen.getByRole("button", { name: NEW_TAB_LABEL }), { deltaX: 60, deltaY: 0 });
    expect(strip().scrollLeft).toBe(0);
  });

  it("leaves a turn over the strip to WebKit's own scrolling", () => {
    renderBar(barState(letters(16)));
    fireEvent.wheel(tabById("t3"), { deltaX: 60, deltaY: 0 });
    expect(strip().scrollLeft).toBe(0);
  });

  it("holds the widths after a close by its button while the pointer stays over the bar", () => {
    const tabs = letters(6);
    const { container, update } = renderBar(barState(tabs));
    const held = Math.floor(available() / 6);

    fireEvent.click(within(tabById("t2")).getByRole("button", { name: CLOSE_TAB_BUTTON_LABEL }));
    expect(commands.closeTab).toHaveBeenCalledWith("t2");
    expect(commands.activateTab).not.toHaveBeenCalled();

    update(barState(tabs.filter((candidate) => candidate.id !== "t2")));
    for (const node of tabsShown()) expect(widthOf(node)).toBe(held);

    const header = container.querySelector("header[data-tab-bar]");
    if (!header) throw new Error("no bar");
    fireEvent.pointerLeave(header);
    for (const node of tabsShown()) expect(widthOf(node)).toBe(Math.floor(available() / 5));
  });

  it("holds the widths after a middle click closes a tab", () => {
    const tabs = letters(6);
    const { update } = renderBar(barState(tabs));
    const held = Math.floor(available() / 6);

    fireEvent.mouseDown(tabById("t3"), { button: 1 });
    fireEvent.mouseUp(tabById("t3"), { button: 1 });
    expect(commands.closeTab).toHaveBeenCalledWith("t3");
    expect(commands.activateTab).not.toHaveBeenCalled();

    update(barState(tabs.filter((candidate) => candidate.id !== "t3")));
    for (const node of tabsShown()) expect(widthOf(node)).toBe(held);
  });

  it("closes with the middle button only the tab it went down on", () => {
    renderBar(barState(letters(3)));
    fireEvent.mouseDown(tabById("t0"), { button: 1 });
    fireEvent.mouseUp(tabById("t1"), { button: 1 });
    fireEvent.mouseDown(tabById("t2"), { button: 0 });
    fireEvent.mouseUp(tabById("t2"), { button: 1 });
    expect(commands.closeTab).not.toHaveBeenCalled();
  });

  it("releases the hold when a tab is added", () => {
    const tabs = letters(6);
    const { update } = renderBar(barState(tabs));
    fireEvent.click(within(tabById("t2")).getByRole("button", { name: CLOSE_TAB_BUTTON_LABEL }));
    update(barState([...tabs, tab("t6")]));
    for (const node of tabsShown()) expect(widthOf(node)).toBe(Math.floor(available() / 7));
  });
});

describe("pointer on tabs (В49, В53)", () => {
  it("shows a clicked tab without keeping focus in the bar", () => {
    renderBar(barState([tab("a"), tab("b")]));
    const target = tabById("b");

    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    target.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
    fireEvent.click(target);

    expect(commands.activateTab).toHaveBeenCalledWith("b");
    expect(document.activeElement).not.toBe(target);
  });
});

describe("keyboard (В49, В55)", () => {
  it("is a tab list with one tab in the tab order", () => {
    renderBar(barState([tab("a"), tab("b"), tab("c")], { active_tab: "b" }));
    expect(tabsShown().map((node) => node.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("moves focus with the arrows and shows the tab with Enter or Space", () => {
    renderBar(barState([tab("a"), tab("b"), tab("c")]));
    act(() => tabById("a").focus());

    fireEvent.keyDown(tabById("a"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabById("b"));
    expect(tabsShown().map((node) => node.tabIndex)).toEqual([-1, 0, -1]);

    fireEvent.keyDown(tabById("b"), { key: "ArrowLeft" });
    fireEvent.keyDown(tabById("a"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabById("c"));

    fireEvent.keyDown(tabById("c"), { key: "Enter" });
    expect(commands.activateTab).toHaveBeenLastCalledWith("c");
    fireEvent.keyDown(tabById("c"), { key: " " });
    expect(commands.activateTab).toHaveBeenCalledTimes(2);
  });

  it("closes the focused tab with Delete and keeps focus on its neighbour", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    const { update } = renderBar(barState(tabs));
    act(() => tabById("b").focus());

    fireEvent.keyDown(tabById("b"), { key: "Delete" });
    expect(commands.closeTab).toHaveBeenCalledWith("b");
    expect(document.activeElement).toBe(tabById("c"));

    update(barState([tab("a"), tab("c")]));
    expect(document.activeElement).toBe(tabById("c"));
    expect(tabById("c").tabIndex).toBe(0);
  });

  it("closes with Backspace too, without holding widths", () => {
    renderBar(barState([tab("a"), tab("b")]));
    act(() => tabById("a").focus());
    fireEvent.keyDown(tabById("a"), { key: "Backspace" });
    expect(commands.closeTab).toHaveBeenCalledWith("a");
  });

  it("switches tabs round the window with ⌃Tab and ⌃⇧Tab anywhere in the bar", () => {
    renderBar(barState([tab("a"), tab("b")]));

    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    expect(commands.activateAdjacentTab).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
    expect(commands.activateAdjacentTab).toHaveBeenLastCalledWith(false);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(commands.activateAdjacentTab).toHaveBeenCalledTimes(2);
  });

  it("leaves ⇧⌘] to the native menu (В57)", () => {
    renderBar(barState([tab("a"), tab("b")]));
    const keyDown = new KeyboardEvent("keydown", { key: "]", code: "BracketRight", metaKey: true, shiftKey: true, cancelable: true });
    window.dispatchEvent(keyDown);
    expect(keyDown.defaultPrevented).toBe(false);
    expect(commands.activateAdjacentTab).not.toHaveBeenCalled();
  });
});

describe("tab menu (В50)", () => {
  it("opens the native menu for the right-clicked tab and acts on it", async () => {
    renderBar(barState([tab("a"), tab("b"), tab("c")]));

    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => {
      tabById("b").dispatchEvent(contextMenu);
    });
    expect(contextMenu.defaultPrevented).toBe(true);
    expect(menu.open).toHaveBeenCalledWith("b", 1, 3);

    menu.actions?.moveToNewWindow("b");
    menu.actions?.close("b");
    menu.actions?.closeOthers("b");
    menu.actions?.closeToTheLeft("b");
    menu.actions?.closeToTheRight("b");
    expect(commands.moveTabToNewWindow).toHaveBeenCalledWith("b");
    expect(commands.closeTab).toHaveBeenCalledWith("b");
    expect(commands.closeOtherTabs).toHaveBeenCalledWith("b");
    expect(commands.closeTabsBeside).toHaveBeenNthCalledWith(1, "b", "left");
    expect(commands.closeTabsBeside).toHaveBeenNthCalledWith(2, "b", "right");
  });

  it("tells the menu where the tab stands, so a side without tabs is off", async () => {
    renderBar(barState([tab("a"), tab("b"), tab("c")]));
    await act(async () => {
      fireEvent.contextMenu(tabById("a"));
    });
    expect(menu.open).toHaveBeenLastCalledWith("a", 0, 3);
    await act(async () => {
      fireEvent.contextMenu(tabById("c"));
    });
    expect(menu.open).toHaveBeenLastCalledWith("c", 2, 3);
  });

  it("builds the menu once for the bar", async () => {
    renderBar(barState([tab("a"), tab("b")]));
    await act(async () => {
      fireEvent.contextMenu(tabById("a"));
    });
    await act(async () => {
      fireEvent.contextMenu(tabById("b"));
    });
    expect(menu.create).toHaveBeenCalledTimes(1);
    expect(menu.open).toHaveBeenLastCalledWith("b", 1, 2);
  });
});

/** Press on `node` at (x, y) and return helpers that move and release the same pointer. */
function press(node: HTMLElement, x: number, y = 12) {
  fireEvent.pointerDown(node, { button: 0, pointerId: 1, clientX: x, clientY: y });
  return {
    move: (toX: number, toY = y) => fireEvent.pointerMove(window, { pointerId: 1, clientX: toX, clientY: toY }),
    release: (toX: number, toY = y) => fireEvent.pointerUp(window, { pointerId: 1, clientX: toX, clientY: toY }),
  };
}

const transformOf = (node: HTMLElement) => node.style.transform;

describe("reorder (В60)", () => {
  it("keeps a press below the threshold a click", () => {
    renderBar(barState([tab("a"), tab("b")]));
    const gesture = press(tabById("b"), 300);
    gesture.move(303);
    gesture.release(303);
    fireEvent.click(tabById("b"));

    expect(commands.moveTab).not.toHaveBeenCalled();
    expect(commands.activateTab).toHaveBeenCalledWith("b");
  });

  it("follows the pointer, parts the neighbours and drops into the new place", () => {
    const { container } = renderBar(barState([tab("a"), tab("b"), tab("c")]));
    const gesture = press(tabById("a"), 100);

    gesture.move(230);
    expect(tabById("a")).toHaveAttribute("data-dragging", "true");
    expect(transformOf(tabById("a"))).toBe("translateX(130px)");
    expect(tabById("a").style.transition).toBe("");
    expect(transformOf(tabById("b"))).toBe(`translateX(-${TAB_MAX_WIDTH_PX}px)`);
    expect(tabById("b").style.transition).toBe(TAB_SHIFT);
    expect(transformOf(tabById("c"))).toBe("");

    gesture.release(230);
    fireEvent.click(tabById("a"));

    expect(commands.moveTab).toHaveBeenCalledWith("a", 1);
    expect(commands.activateTab).not.toHaveBeenCalled();
    expect(tabsShown().map((node) => node.dataset.tabId)).toEqual(["b", "a", "c"]);
    for (const node of tabsShown()) {
      expect(transformOf(node)).toBe("");
      expect(node.style.transition).toBe("");
    }
    expect(container.querySelector("[data-reordering]")).toBeNull();
  });

  /// SPEC_DEEP_AUDIT.md, Е6.10: a reorder the backend refused puts the tabs
  /// back in their order; why goes to the log (decision of 14.10.2026).
  it("puts the tabs back and logs why when the move was refused", async () => {
    commands.moveTab.mockRejectedValueOnce(new Error("the saved windows could not be written"));
    renderBar(barState([tab("a"), tab("b"), tab("c")], { active_tab: "b" }));
    const gesture = press(tabById("a"), 100);
    gesture.move(230);
    gesture.release(230);
    expect(tabsShown().map((node) => node.dataset.tabId)).toEqual(["b", "a", "c"]);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(tabsShown().map((node) => node.dataset.tabId)).toEqual(["a", "b", "c"]);
    expect(tabBarFailure.log).toHaveBeenCalledWith(
      "move the tab",
      new Error("the saved windows could not be written"),
    );
  });

  it("logs a command of the bar that failed", async () => {
    commands.newTab.mockRejectedValueOnce(new Error("no window"));
    renderBar(barState([tab("a"), tab("b")], { active_tab: "a" }));

    fireEvent.click(screen.getByRole("button", { name: NEW_TAB_LABEL }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(tabBarFailure.log).toHaveBeenCalledWith("open a new tab", new Error("no window"));
  });

  it("returns the tab to its place on Escape", () => {
    renderBar(barState([tab("a"), tab("b"), tab("c")]));
    const gesture = press(tabById("a"), 100);
    gesture.move(400);

    fireEvent.keyDown(window, { key: "Escape" });
    for (const node of tabsShown()) expect(transformOf(node)).toBe("");
    gesture.release(400);

    expect(commands.moveTab).not.toHaveBeenCalled();
    expect(tabsShown().map((node) => node.dataset.tabId)).toEqual(["a", "b", "c"]);
  });

  it("does not move a tab dropped back on its own slot", () => {
    renderBar(barState([tab("a"), tab("b")]));
    const gesture = press(tabById("a"), 100);
    gesture.move(150);
    gesture.release(150);
    expect(commands.moveTab).not.toHaveBeenCalled();
  });

  // Перемещение (SPEC_MOTION_LEVELS.md, Т3, РД1). The neighbours answer a
  // drag in hand, so they move the same in every mode («Режимы»).
  it.each(["full", "minimal", "off"] as const)("moves the neighbours at %s as Перемещение, the same in every mode", (level) => {
    setMotionLevel(level);
    renderBar(barState([tab("a"), tab("b")]));
    press(tabById("a"), 100).move(300);
    expect(tabById("b").style.transition).toBe(TAB_SHIFT);
  });
});

describe("tear off (В61, В62)", () => {
  it("hands the tab to the backend once the pointer is pulled below the bar", () => {
    renderBar(barState([tab("a"), tab("b"), tab("c")]));
    const gesture = press(tabById("b"), 300, 10);
    gesture.move(310, 10);
    gesture.move(310, TAB_BAR_HEIGHT_PX + TAB_DETACH_THRESHOLD_PX);
    expect(commands.beginTabDrag).not.toHaveBeenCalled();

    gesture.move(310, TAB_BAR_HEIGHT_PX + TAB_DETACH_THRESHOLD_PX + 1);
    // Tab b starts one maximum width in: it was grabbed 300 px from the
    // strip's start, so the new window keeps the pointer as far into its
    // first tab.
    expect(commands.beginTabDrag).toHaveBeenCalledWith("b", 300 - TAB_MAX_WIDTH_PX, 10);
    for (const node of tabsShown()) expect(transformOf(node)).toBe("");

    gesture.move(320, 200);
    gesture.release(320, 200);
    expect(commands.beginTabDrag).toHaveBeenCalledTimes(1);
    expect(commands.moveTab).not.toHaveBeenCalled();
  });

  it("tears off when the pointer leaves the window across", () => {
    renderBar(barState([tab("a"), tab("b")]));
    const gesture = press(tabById("a"), 100);
    gesture.move(90);
    gesture.move(-1);
    expect(commands.beginTabDrag).toHaveBeenCalledTimes(1);
  });

  it("moves the window of a single tab as soon as the drag starts", () => {
    renderBar(barState([tab("a")]));
    const gesture = press(tabById("a"), 150, 9);
    gesture.move(152, 9);
    expect(commands.beginTabDrag).not.toHaveBeenCalled();
    gesture.move(155, 9);
    expect(commands.beginTabDrag).toHaveBeenCalledWith("a", 150, 9);
    gesture.release(155, 9);
    fireEvent.click(tabById("a"));
    expect(commands.activateTab).not.toHaveBeenCalled();
  });

  it("leaves a full-screen window with one tab where it is", () => {
    renderBar(barState([tab("a")], { fullscreen: true }));
    const gesture = press(tabById("a"), 150);
    gesture.move(200, 100);
    gesture.release(200, 100);
    expect(commands.beginTabDrag).not.toHaveBeenCalled();
    expect(commands.moveTab).not.toHaveBeenCalled();
  });
});

describe("window drag (В23)", () => {
  it("drags the window from the empty part of the bar through the backend", () => {
    const { container } = renderBar(barState([tab("a")]));
    const area = container.querySelector<HTMLElement>("[data-tab-bar-drag-area]");
    if (!area) throw new Error("no drag area");
    const gesture = press(area, 900);
    gesture.move(920);
    expect(commands.startWindowDrag).toHaveBeenCalledTimes(1);
    gesture.release(920);
  });

  it("drags the window from + without opening a tab", () => {
    renderBar(barState([tab("a")]));
    const button = screen.getByRole("button", { name: NEW_TAB_LABEL });
    const gesture = press(button, 400);
    gesture.move(420);
    gesture.release(420);
    fireEvent.click(button);
    expect(commands.startWindowDrag).toHaveBeenCalledTimes(1);
    expect(commands.newTab).not.toHaveBeenCalled();
  });

  it("drags the window from search and the logo without opening them", () => {
    renderBar(barState([tab("a")]));
    for (const name of [SEARCH_LABEL, SETTINGS_MENU_LABEL]) {
      const button = screen.getByRole("button", { name });
      const gesture = press(button, 1200);
      gesture.move(1220);
      gesture.release(1220);
      fireEvent.click(button);
    }
    expect(commands.startWindowDrag).toHaveBeenCalledTimes(2);
    expect(commands.openTabSearch).not.toHaveBeenCalled();
    expect(settingsMenu.open).not.toHaveBeenCalled();
  });

  it("drags the window from the edge inset after the logo", () => {
    const { container } = renderBar(barState([tab("a")]));
    const slot = container.querySelector<HTMLElement>("[data-tab-bar-settings]");
    if (!slot) throw new Error("no settings slot");
    expect(slot.className).toContain("pr-[var(--chrome-edge-pad)]");
    expect(slot.className).not.toContain("mr-[var(--chrome-edge-pad)]");
    const gesture = press(slot, 1270);
    gesture.move(1290);
    gesture.release(1290);
    expect(commands.startWindowDrag).toHaveBeenCalledTimes(1);
  });

  it("does not drag the window from a tab", () => {
    renderBar(barState([tab("a"), tab("b")]));
    const gesture = press(tabById("a"), 100);
    gesture.move(140);
    gesture.release(140);
    expect(commands.startWindowDrag).not.toHaveBeenCalled();
  });
});

describe("a tab from another window (В63)", () => {
  const marker = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-tab-drop-marker]");

  it("marks the slot after every tab whose centre is left of the pointer and reports it", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    const { container, update } = renderBar(barState(tabs));
    expect(marker(container)).toBeNull();
    expect(commands.reportDropSlot).not.toHaveBeenCalled();

    // Centres stand at half, one and a half and two and a half widths.
    update(barState(tabs), { x: TAB_MAX_WIDTH_PX + TAB_MAX_WIDTH_PX / 4, item: { kind: "tab", tab_id: "x" } });
    expect(commands.reportDropSlot).toHaveBeenLastCalledWith(1);
    expect(marker(container)).toHaveAttribute("data-tab-drop-marker", "1");
    expect(marker(container)?.parentElement).toBe(strip());
    expect(marker(container)?.style.width).toBe("2px");
    expect(marker(container)?.style.left).toBe(`${TAB_MAX_WIDTH_PX - 1}px`);
    expect(marker(container)?.className).toContain("bg-foreground");
    expect(marker(container)?.className).toContain("inset-y-0");
    // The tabs stay where they are; only the marker shows the place.
    for (const node of tabsShown()) expect(transformOf(node)).toBe("");

    update(barState(tabs), { x: TAB_MAX_WIDTH_PX + TAB_MAX_WIDTH_PX / 4 + 10, item: { kind: "tab", tab_id: "x" } });
    expect(commands.reportDropSlot).toHaveBeenCalledTimes(1);

    update(barState(tabs), { x: 3 * TAB_MAX_WIDTH_PX - 10, item: { kind: "tab", tab_id: "x" } });
    expect(commands.reportDropSlot).toHaveBeenLastCalledWith(3);
    expect(marker(container)?.style.left).toBe(`${3 * TAB_MAX_WIDTH_PX - 2}px`);

    update(barState(tabs), { x: 10, item: { kind: "tab", tab_id: "x" } });
    expect(commands.reportDropSlot).toHaveBeenLastCalledWith(0);
    expect(marker(container)?.style.left).toBe("0px");
  });

  it("hides the marker and reports no slot when the pointer leaves the bar", () => {
    const tabs = [tab("a"), tab("b")];
    const { container, update } = renderBar(barState(tabs), { x: 400, item: { kind: "tab", tab_id: "x" } });
    expect(commands.reportDropSlot).toHaveBeenLastCalledWith(2);

    update(barState(tabs), null);
    expect(marker(container)).toBeNull();
    expect(commands.reportDropSlot).toHaveBeenLastCalledWith(null);
    expect(commands.reportDropSlot).toHaveBeenCalledTimes(2);
  });
});

/** Cards of this window's visible tab held over the bar at `x` (В86). */
function cards(x: number | null, dropped = false): DropHover {
  return { x, item: { kind: "cards", title: "Jacket", dropped } };
}

/** How the row opens and closes the gap for cards: Перемещение, the same
 *  200 ms on the move curve as a dragged tab's neighbours. */
const CARD_GAP_TABS = `transform ${MOTION_MOVE_MS}ms ${MOTION_MOVE_EASE}, width ${MOTION_MOVE_MS}ms ${MOTION_MOVE_EASE}`;
const CARD_GAP_STRIP = `width ${MOTION_MOVE_MS}ms ${MOTION_MOVE_EASE}`;

describe("cards held over the bar (В86)", () => {
  const placeholder = (container: HTMLElement) =>
    container.querySelector<HTMLElement>("[data-tab-card-placeholder]");
  const shifts = () => tabsShown().map(transformOf);

  it("parts the tabs at the slot under the pointer and stands a muted placeholder there", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    const { container, update } = renderBar(barState(tabs));
    expect(placeholder(container)).toBeNull();

    // Over the left half of b: before it.
    update(barState(tabs), cards(TAB_MAX_WIDTH_PX + TAB_MAX_WIDTH_PX / 4));
    const shown = placeholder(container);
    expect(shown).toHaveAttribute("data-tab-card-placeholder", "1");
    expect(shown).toHaveAttribute("aria-hidden", "true");
    expect(shown).toHaveTextContent("Jacket");
    expect(shown?.className).toContain("text-muted-foreground");
    expect(shown?.parentElement).toBe(strip());
    expect(shown?.style.width).toBe(`${TAB_MAX_WIDTH_PX}px`);
    expect(shown?.style.transform).toBe(`translateX(${TAB_MAX_WIDTH_PX}px)`);
    expect(shifts()).toEqual(["", `translateX(${TAB_MAX_WIDTH_PX}px)`, `translateX(${TAB_MAX_WIDTH_PX}px)`]);
    // The row grows by one tab: three tabs and the gap.
    expect(strip().style.width).toBe(`${4 * TAB_MAX_WIDTH_PX}px`);
    // Neighbours, the strip with + after it, and the placeholder move on the
    // same curve as tabs parting for a dragged tab.
    for (const node of tabsShown()) expect(node.style.transition).toBe(CARD_GAP_TABS);
    expect(strip().style.transition).toBe(CARD_GAP_STRIP);
    expect(shown?.style.transition).toBe(CARD_GAP_TABS);

    // Over the right half of b: after it.
    update(barState(tabs), cards(TAB_MAX_WIDTH_PX + (3 * TAB_MAX_WIDTH_PX) / 4));
    expect(placeholder(container)).toHaveAttribute("data-tab-card-placeholder", "2");
    expect(shifts()).toEqual(["", "", `translateX(${TAB_MAX_WIDTH_PX}px)`]);

    // Over + and past the last tab: at the end, nothing parts.
    update(barState(tabs), cards(4 * TAB_MAX_WIDTH_PX + 10));
    expect(placeholder(container)).toHaveAttribute("data-tab-card-placeholder", "3");
    expect(placeholder(container)?.style.transform).toBe(`translateX(${3 * TAB_MAX_WIDTH_PX}px)`);
    expect(shifts()).toEqual(["", "", ""]);

    // Over the first tab's left half: first, with the row's left line.
    update(barState(tabs), cards(10));
    expect(placeholder(container)).toHaveAttribute("data-tab-card-placeholder", "0");
    expect(placeholder(container)?.className).toContain("border-l");

    // Tabs under the pointer are not shown, and no slot goes back before the
    // drop.
    expect(commands.activateTab).not.toHaveBeenCalled();
    expect(commands.reportDropSlot).not.toHaveBeenCalled();
    // A tab from another window draws its marker, not this room.
    expect(container.querySelector("[data-tab-drop-marker]")).toBeNull();
  });

  it("shares the room with the gap when the tabs fill the row", () => {
    zoneWidth = 3 * TAB_MAX_WIDTH_PX + NEW_TAB_SLOT_PX;
    const tabs = [tab("a"), tab("b"), tab("c")];
    const { update } = renderBar(barState(tabs));
    expect(widthOf(tabById("a"))).toBe(TAB_MAX_WIDTH_PX);

    update(barState(tabs), cards(10));
    const shared = Math.floor(available() / 4);
    for (const node of tabsShown()) expect(widthOf(node)).toBe(shared);
    expect(strip().style.width).toBe(`${4 * shared}px`);
  });

  it("follows the strip when it is scrolled under the held pointer", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    const { container, update } = renderBar(barState(tabs));
    update(barState(tabs), cards(TAB_MAX_WIDTH_PX + TAB_MAX_WIDTH_PX / 4));
    expect(placeholder(container)).toHaveAttribute("data-tab-card-placeholder", "1");

    Object.defineProperty(strip(), "scrollLeft", { configurable: true, writable: true, value: TAB_MAX_WIDTH_PX });
    fireEvent.scroll(strip());
    // b's centre now stands a width further left, under the pointer's left.
    expect(placeholder(container)).toHaveAttribute("data-tab-card-placeholder", "2");
  });

  it("closes the gap on the same curve when the cards leave or the drag is cancelled", () => {
    vi.useFakeTimers();
    try {
      const tabs = [tab("a"), tab("b")];
      const { container, update } = renderBar(barState(tabs), cards(10));
      expect(shifts()).toEqual([`translateX(${TAB_MAX_WIDTH_PX}px)`, `translateX(${TAB_MAX_WIDTH_PX}px)`]);

      update(barState(tabs), null);
      expect(placeholder(container)).toBeNull();
      expect(shifts()).toEqual(["", ""]);
      expect(strip().style.width).toBe(`${2 * TAB_MAX_WIDTH_PX}px`);
      for (const node of tabsShown()) expect(node.style.transition).toBe(CARD_GAP_TABS);
      expect(strip().style.transition).toBe(CARD_GAP_STRIP);

      act(() => {
        vi.advanceTimersByTime(MOTION_MOVE_MS);
      });
      for (const node of tabsShown()) expect(node.style.transition).toBe("");
      expect(strip().style.transition).toBe("");
      expect(commands.reportDropSlot).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a drop with the slot under it, and the tabs stand where the placeholder stood", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    const x = TAB_MAX_WIDTH_PX + TAB_MAX_WIDTH_PX / 4;
    const view = render(<TabBar bar={barState(tabs)} dropHover={cards(x)} />);
    const dropped = cards(x, true);

    view.rerender(<TabBar bar={barState(tabs)} dropHover={cards(x)} landing={dropped} />);
    expect(commands.reportDropSlot).toHaveBeenCalledTimes(1);
    expect(commands.reportDropSlot).toHaveBeenCalledWith(1);
    // The room holds still until the tabs come.
    expect(placeholder(view.container)).toHaveAttribute("data-tab-card-placeholder", "1");
    for (const node of tabsShown()) expect(node.style.transition).toBe("");

    // The state with the card's tab ends the gap in the same frame: nothing
    // left to move.
    const landed = barState([tab("a"), tab("n", "Mine", null, { card: "Jacket" }), tab("b"), tab("c")], { active_tab: "n" });
    view.rerender(<TabBar bar={landed} dropHover={null} landing={dropped} />);
    expect(placeholder(view.container)).toBeNull();
    expect(tabsShown().map((node) => node.dataset.tabId)).toEqual(["a", "n", "b", "c"]);
    expect(tabById("n")).toHaveAttribute("aria-selected", "true");
    for (const node of tabsShown()) {
      expect(transformOf(node)).toBe("");
      expect(node.style.transition).toBe("");
    }
    expect(strip().style.transition).toBe("");
    view.rerender(<TabBar bar={landed} dropHover={null} landing={null} />);
    expect(commands.reportDropSlot).toHaveBeenCalledTimes(1);
  });

  // An answer to the drag in hand: the same in every mode (SPEC_MOTION_LEVELS.md,
  // Р1, Т4).
  it.each(["full", "minimal", "off"] as const)("opens the gap at %s as Перемещение, the same in every mode", (level) => {
    setMotionLevel(level);
    renderBar(barState([tab("a"), tab("b")]), cards(10));
    expect(tabById("b").style.transition).toBe(CARD_GAP_TABS);
    expect(strip().style.transition).toBe(CARD_GAP_STRIP);
  });

  it("moves the neighbours of a landing group to their places, widths too, and stands the rest of it", () => {
    vi.useFakeTimers();
    // What the row shows the moment the start places are laid out.
    const atStart: Array<{ id: string | undefined; transform: string; width: string; transition: string }> = [];
    let stripAtStart = "";
    const startSpy = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-tab-strip")) {
        stripAtStart = this.style.width;
        for (const node of Array.from(this.querySelectorAll<HTMLElement>("[role='tab']"))) {
          atStart.push({ id: node.dataset.tabId, transform: node.style.transform, width: node.style.width, transition: node.style.transition });
        }
      }
      return this.hasAttribute("data-tab-bar-new-tab-slot") ? NEW_TAB_SLOT_PX : 0;
    });
    try {
      const tabs = [tab("a"), tab("b"), tab("c")];
      const x = TAB_MAX_WIDTH_PX + TAB_MAX_WIDTH_PX / 4;
      const dropped = cards(x, true);
      const view = render(<TabBar bar={barState(tabs)} dropHover={cards(x)} />);
      view.rerender(<TabBar bar={barState(tabs)} dropHover={cards(x)} landing={dropped} />);

      // В, А, Б: the grabbed card's tab first, on the placeholder's slot.
      const landed = barState(
        [tab("a"), tab("v"), tab("a1"), tab("b1"), tab("b"), tab("c")],
        { active_tab: "v" },
      );
      view.rerender(<TabBar bar={landed} dropHover={null} landing={dropped} />);

      // Six tabs share the room now; before, four did (three and the gap).
      const before = TAB_MAX_WIDTH_PX;
      const after = Math.floor(available() / 6);
      const start = new Map(atStart.map((entry) => [entry.id, entry]));
      // b and c start where they stood, beside the gap, and keep their width.
      expect(start.get("b")?.transform).toBe(`translateX(${2 * before - 4 * after}px)`);
      expect(start.get("c")?.transform).toBe(`translateX(${3 * before - 5 * after}px)`);
      expect(start.get("b")?.width).toBe(`${before}px`);
      // The grabbed card's tab starts on the placeholder.
      expect(start.get("v")?.transform).toBe(`translateX(${before - after}px)`);
      // The rest of the group stand in their places from the start.
      expect(start.get("a1")).toEqual({ id: "a1", transform: "", width: `${after}px`, transition: "" });
      expect(stripAtStart).toBe(`${4 * before}px`);

      // Then everything moves on to its place as Перемещение.
      for (const id of ["a", "v", "b", "c"]) {
        expect(tabById(id).style.transform).toBe("");
        expect(tabById(id).style.width).toBe(`${after}px`);
        expect(tabById(id).style.transition).toBe(CARD_GAP_TABS);
      }
      expect(tabById("b").className).toContain("z-10");
      for (const id of ["a1", "b1"]) expect(tabById(id).style.transition).toBe("");
      expect(strip().style.width).toBe(`${6 * after}px`);
      expect(strip().style.transition).toBe(CARD_GAP_STRIP);

      act(() => {
        vi.advanceTimersByTime(MOTION_MOVE_MS);
      });
      for (const node of tabsShown()) expect(node.style.transition).toBe("");
      expect(strip().style.transition).toBe("");
    } finally {
      startSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("moves the neighbours aside for a group asked about first, with no placeholder to start from", () => {
    // Open N tabs? closed the room before the tabs came (В86, п. 6).
    const tabs = [tab("a"), tab("b")];
    const dropped = cards(10, true);
    const view = render(<TabBar bar={barState(tabs)} dropHover={null} />);
    view.rerender(<TabBar bar={barState(tabs)} dropHover={null} landing={dropped} />);
    const group = Array.from({ length: 15 }, (_, index) => tab(`n${index}`));
    view.rerender(<TabBar bar={barState([...group, ...tabs], { active_tab: "n0" })} dropHover={null} landing={dropped} />);
    expect(tabById("a").style.transition).toBe(CARD_GAP_TABS);
    expect(tabById("b").style.transition).toBe(CARD_GAP_TABS);
    // The group's tabs, the grabbed card's too, stand in their places.
    for (const node of group) expect(tabById(node.id).style.transition).toBe("");
  });

  it.each(["full", "minimal", "off"] as const)("moves a landing group at %s the same as at Full", (level) => {
    setMotionLevel(level);
    const tabs = [tab("a"), tab("b")];
    const dropped = cards(10, true);
    const view = render(<TabBar bar={barState(tabs)} dropHover={cards(10)} />);
    view.rerender(<TabBar bar={barState(tabs)} dropHover={cards(10)} landing={dropped} />);
    view.rerender(<TabBar bar={barState([tab("v"), tab("w"), ...tabs], { active_tab: "v" })} dropHover={null} landing={dropped} />);
    expect(tabById("a").style.transition).toBe(CARD_GAP_TABS);
  });

  it("answers a drop after the question with the slot of the row as it stands", () => {
    // Open N tabs? closed the room first (В86, п. 6).
    const tabs = [tab("a"), tab("b")];
    const view = render(<TabBar bar={barState(tabs)} dropHover={null} />);
    view.rerender(<TabBar bar={barState(tabs)} dropHover={null} landing={cards(3 * TAB_MAX_WIDTH_PX, true)} />);
    expect(placeholder(view.container)).toBeNull();
    expect(commands.reportDropSlot).toHaveBeenCalledWith(2);
  });
});

describe("button style of the window (dev tool, src/lib/buttonStyle.ts)", () => {
  it("sends the window's style to its own tabs, again when a tab joins, and to no other page", async () => {
    const { emitTo } = await import("@tauri-apps/api/event");
    vi.mocked(emitTo).mockClear();
    document.documentElement.setAttribute("data-buttons", "retro");
    const view = renderBar(barState([tab("a"), tab("b")]));
    const sent = () => vi.mocked(emitTo).mock.calls.map(([label, event, payload]) => ({ label, event, payload }));
    expect(sent()).toEqual([
      { label: "tab-a", event: "dev-buttons-window", payload: { window: "w1", style: "retro", notice: false } },
      { label: "tab-b", event: "dev-buttons-window", payload: { window: "w1", style: "retro", notice: false } },
    ]);
    vi.mocked(emitTo).mockClear();
    view.update(barState([tab("a"), tab("b")], { active_tab: "b" }));
    expect(sent()).toEqual([]);
    view.update(barState([tab("a"), tab("b"), tab("c")]));
    expect(sent().map(({ label }) => label)).toEqual(["tab-a", "tab-b", "tab-c"]);
    document.documentElement.removeAttribute("data-buttons");
  });
});
