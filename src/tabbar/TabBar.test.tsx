import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
  moveTab: vi.fn(async () => undefined),
  moveTabToNewWindow: vi.fn(async () => undefined),
  newTab: vi.fn(async () => undefined),
  openSettingsWindow: vi.fn(async () => undefined),
  reportDropSlot: vi.fn(async () => undefined),
  setWindowSidebar: vi.fn(async () => undefined),
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

/** The zone the tabs and `+` share, and the slot `+` takes from it. */
const NEW_TAB_SLOT_PX = 32;
let zoneWidth = 1000;
const available = () => zoneWidth - NEW_TAB_SLOT_PX;

function tab(
  id: string,
  space_name: string | null = "Mine",
  collection: string | null = null,
  overrides: Partial<TabBarTab> = {},
): TabBarTab {
  return { id, space_name, collection, card: null, live: true, history: { back: false, forward: false }, ...overrides };
}

function barState(tabs: TabBarTab[], overrides: Partial<TabBarState> = {}): TabBarState {
  return {
    window_id: "w1",
    tabs,
    active_tab: tabs[0]?.id ?? "",
    sidebar: { width_px: 240, collapsed: false },
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
    // 80px at the 30px row, growing with the row as the lights' inset (В83).
    expect(reserve?.className).toContain("w-[calc(80px+(var(--chrome-row-content-height)-30px)/2)]");
  });

  it("gives the traffic lights' place back in full screen", () => {
    const { container } = renderBar(barState([tab("a")], { fullscreen: true }));
    expect(container.querySelector("header[data-fullscreen='true'] [data-traffic-light-reserve]")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Hide Sidebar" });
    expect(toggle.closest("div.pl-\\[var\\(--chrome-edge-pad\\)\\]")).not.toBeNull();
  });

  it("toggles the window's sidebar through the backend (В56)", () => {
    const { update } = renderBar(barState([tab("a")]));

    fireEvent.click(screen.getByRole("button", { name: "Hide Sidebar" }));
    expect(commands.setWindowSidebar).toHaveBeenCalledWith({ width_px: 240, collapsed: true });

    update(barState([tab("a")], { sidebar: { width_px: 240, collapsed: true } }));
    fireEvent.click(screen.getByRole("button", { name: "Show Sidebar" }));
    expect(commands.setWindowSidebar).toHaveBeenLastCalledWith({ width_px: 240, collapsed: false });
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
    expect(menu.open).toHaveBeenCalledWith("b", 3);

    menu.actions?.moveToNewWindow("b");
    menu.actions?.close("b");
    menu.actions?.closeOthers("b");
    expect(commands.moveTabToNewWindow).toHaveBeenCalledWith("b");
    expect(commands.closeTab).toHaveBeenCalledWith("b");
    expect(commands.closeOtherTabs).toHaveBeenCalledWith("b");
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
    expect(menu.open).toHaveBeenLastCalledWith("b", 2);
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
    expect(tabById("b").style.transition).toContain("transform 150ms");
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

  it("moves at once under reduced motion", () => {
    const matchMedia = vi.fn((query: string) => ({ matches: query.includes("reduce") }));
    vi.stubGlobal("matchMedia", matchMedia);
    try {
      renderBar(barState([tab("a"), tab("b")]));
      press(tabById("a"), 100).move(300);
      expect(tabById("b").style.transition).toContain("transform 0ms");
    } finally {
      vi.unstubAllGlobals();
    }
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
    update(barState(tabs), { tab_id: "x", x: TAB_MAX_WIDTH_PX + TAB_MAX_WIDTH_PX / 4 });
    expect(commands.reportDropSlot).toHaveBeenLastCalledWith(1);
    expect(marker(container)).toHaveAttribute("data-tab-drop-marker", "1");
    expect(marker(container)?.parentElement).toBe(strip());
    expect(marker(container)?.style.width).toBe("2px");
    expect(marker(container)?.style.left).toBe(`${TAB_MAX_WIDTH_PX - 1}px`);
    expect(marker(container)?.className).toContain("bg-foreground");
    expect(marker(container)?.className).toContain("inset-y-0");
    // The tabs stay where they are; only the marker shows the place.
    for (const node of tabsShown()) expect(transformOf(node)).toBe("");

    update(barState(tabs), { tab_id: "x", x: TAB_MAX_WIDTH_PX + TAB_MAX_WIDTH_PX / 4 + 10 });
    expect(commands.reportDropSlot).toHaveBeenCalledTimes(1);

    update(barState(tabs), { tab_id: "x", x: 3 * TAB_MAX_WIDTH_PX - 10 });
    expect(commands.reportDropSlot).toHaveBeenLastCalledWith(3);
    expect(marker(container)?.style.left).toBe(`${3 * TAB_MAX_WIDTH_PX - 2}px`);

    update(barState(tabs), { tab_id: "x", x: 10 });
    expect(commands.reportDropSlot).toHaveBeenLastCalledWith(0);
    expect(marker(container)?.style.left).toBe("0px");
  });

  it("hides the marker and reports no slot when the pointer leaves the bar", () => {
    const tabs = [tab("a"), tab("b")];
    const { container, update } = renderBar(barState(tabs), { tab_id: "x", x: 400 });
    expect(commands.reportDropSlot).toHaveBeenLastCalledWith(2);

    update(barState(tabs), null);
    expect(marker(container)).toBeNull();
    expect(commands.reportDropSlot).toHaveBeenLastCalledWith(null);
    expect(commands.reportDropSlot).toHaveBeenCalledTimes(2);
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
