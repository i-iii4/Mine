import { useEffect, useRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { setCommandOverrides } from "@/lib/commandRegistry";
import { sidebarRowDomId } from "@/lib/sidebarSearch";
import {
  useSidebarKeyboardFocus,
  type FeedKeyboardFocus,
  type SidebarKeyboardFocus,
} from "./useSidebarKeyboardFocus";

/// The rows as the sidebar marks them: a frame that takes the right click and a
/// link that takes the click. Only a collection's row has a menu, as in the app.
function Rows({ rows, onOpen, onRename }: {
  rows: readonly string[];
  onOpen: (rowKey: string) => void;
  onRename: () => void;
}) {
  return (
    <nav data-sidebar-scroll="">
      {rows.map((rowKey) => {
        const body = (
          <a data-sidebar-row-body="" href="#row" onClick={(event) => { event.preventDefault(); onOpen(rowKey); }}>
            <span data-sidebar-name-text="">{rowKey}</span>
          </a>
        );
        return rowKey === "all"
          ? <div key={rowKey} id={sidebarRowDomId(rowKey)}>{body}</div>
          : (
            <ContextMenu key={rowKey}>
              <ContextMenuTrigger asChild>
                <div id={sidebarRowDomId(rowKey)}>{body}</div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={onRename}>{`Rename ${rowKey}`}</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
      })}
    </nav>
  );
}

const handle: { current: SidebarKeyboardFocus | null } = { current: null };
/** The sidebar as the page holds it: what is stored, and the one flag of the visit. */
const sidebar = { shown: false, opened: false, setOpened: (_open: boolean): void => undefined };

function Page({ rows, currentRowKey, sidebarHidden, feedOnScreen, cardOpen, feed, onOpen, onRename, moveRow }: {
  moveRow: (rowKey: string, direction: 1 | -1) => boolean;
  rows: readonly string[];
  currentRowKey: string | null;
  sidebarHidden: boolean;
  feedOnScreen: boolean;
  cardOpen: boolean;
  feed: FeedKeyboardFocus | null;
  onOpen: (rowKey: string) => void;
  onRename: () => void;
}) {
  const [opened, setOpened] = useState(false);
  const sidebarShown = !sidebarHidden || opened;
  sidebar.shown = sidebarShown;
  sidebar.opened = opened;
  sidebar.setOpened = setOpened;
  const [query, setQuery] = useState("");
  const fieldRef = useRef<HTMLInputElement>(null);
  const focus = useSidebarKeyboardFocus({
    rows,
    currentRowKey,
    feedOnScreen,
    cardOpen,
    sidebarShown,
    openedForKeyboard: opened,
    setOpenedForKeyboard: setOpened,
    filterQuery: query,
    setFilterQuery: setQuery,
    filterFieldRef: fieldRef,
    moveRow,
  });
  handle.current = focus;
  const { reportFeed } = focus;
  useEffect(() => reportFeed(feed), [feed, reportFeed]);
  return (
    <>
      <Rows rows={rows} onOpen={onOpen} onRename={onRename} />
      <div data-bottom-action-bar=""><button type="button">An entry of the bar</button></div>
      <input aria-label="A field" />
      {sidebarShown && (
        <input
          ref={fieldRef}
          aria-label="The filter"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={focus.fieldFocused}
          onBlur={focus.fieldBlurred}
        />
      )}
      <div role="alertdialog"><button type="button">A button in a dialog</button></div>
      <div role="dialog" aria-label="Sidebar" data-sidebar-overlay-panel="" tabIndex={-1} />
    </>
  );
}

const ROWS = ["all", "tag:alpha", "tag:beta", "tag:gamma"];

function setup(overrides: Partial<Parameters<typeof Page>[0]> = {}) {
  const onOpen = vi.fn();
  const onRename = vi.fn();
  const feed = { take: vi.fn(() => true), release: vi.fn() };
  const moveRow = vi.fn((_rowKey: string, _direction: 1 | -1) => true);
  const props = {
    rows: ROWS,
    currentRowKey: "tag:beta",
    sidebarHidden: false,
    feedOnScreen: true,
    cardOpen: false,
    feed,
    onOpen,
    onRename,
    moveRow,
    ...overrides,
  };
  const view = render(<Page {...props} />);
  let current = props;
  return {
    ...view,
    onOpen,
    onRename,
    feed,
    moveRow,
    update: (next: Partial<Parameters<typeof Page>[0]>) => {
      current = { ...current, ...next };
      view.rerender(<Page {...current} />);
    },
  };
}

const focusedRow = () => handle.current?.rowKey ?? null;

function enter(): boolean {
  let taken = false;
  act(() => { taken = handle.current!.enter(); });
  return taken;
}

function key(init: KeyboardEventInit, target: Element | Window = window) {
  act(() => { fireEvent.keyDown(target, init); });
}

/** A pointer report; jsdom's events carry no movement of their own. */
function pointer(type: "pointermove" | "pointerdown", point: { x: number; y: number; dx?: number; dy?: number }, target: Element = document.body) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y });
  Object.defineProperty(event, "movementX", { value: point.dx ?? 5 });
  Object.defineProperty(event, "movementY", { value: point.dy ?? 5 });
  act(() => { target.dispatchEvent(event); });
}

describe("the keyboard's focus on the sidebar's rows (SPEC_KEYBOARD.md, «Sidebar»)", () => {
  beforeEach(() => {
    setCommandOverrides({});
  });

  describe("entering (М1)", () => {
    it("lands on the row of the current route", () => {
      setup();
      expect(enter()).toBe(true);
      expect(focusedRow()).toBe("tag:beta");
    });

    it("scrolls the list just enough, at once, to a row outside its visible part", () => {
      setup();
      const nav = document.querySelector<HTMLElement>("[data-sidebar-scroll]")!;
      const row = document.getElementById(sidebarRowDomId("tag:beta"))!;
      const scrollTo = vi.fn();
      nav.scrollTo = scrollTo as unknown as typeof nav.scrollTo;
      nav.getBoundingClientRect = () => ({ top: 0, bottom: 100 }) as DOMRect;
      row.getBoundingClientRect = () => ({ top: 130, bottom: 170 }) as DOMRect;
      enter();
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo).toHaveBeenCalledWith({ top: 70, behavior: "instant" });
    });

    it("leaves a row already in view where it stands", () => {
      setup();
      const nav = document.querySelector<HTMLElement>("[data-sidebar-scroll]")!;
      const row = document.getElementById(sidebarRowDomId("tag:beta"))!;
      const scrollTo = vi.fn();
      nav.scrollTo = scrollTo as unknown as typeof nav.scrollTo;
      nav.getBoundingClientRect = () => ({ top: 0, bottom: 100 }) as DOMRect;
      row.getBoundingClientRect = () => ({ top: 40, bottom: 80 }) as DOMRect;
      enter();
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("does nothing from the feed's edge with the graph on screen or a card open", () => {
      const { update } = setup({ feedOnScreen: false });
      expect(enter()).toBe(false);
      update({ feedOnScreen: true, cardOpen: true });
      expect(enter()).toBe(false);
      expect(focusedRow()).toBeNull();
    });

    it("gives the focus back as a card opens over the feed by other means", () => {
      const { feed, update } = setup();
      enter();
      update({ cardOpen: true });
      expect(focusedRow()).toBeNull();
      expect(feed.take).toHaveBeenCalledTimes(1);
    });

    it("lands on the top row on a place with no row of its own", () => {
      setup({ currentRowKey: null });
      expect(enter()).toBe(true);
      expect(focusedRow()).toBe("all");
    });

    it("from there ArrowRight returns on any row, and Enter opens the row", () => {
      const { onOpen, feed, update } = setup({ currentRowKey: null });
      enter();
      key({ key: "ArrowDown" });
      expect(focusedRow()).toBe("tag:alpha");
      key({ key: "ArrowRight" });
      expect(feed.take).toHaveBeenCalledTimes(1);
      expect(onOpen).not.toHaveBeenCalled();
      expect(focusedRow()).toBeNull();

      enter();
      key({ key: "ArrowDown" });
      key({ key: "Enter" });
      expect(onOpen).toHaveBeenCalledWith("tag:alpha");
      update({ currentRowKey: "tag:alpha" });
      expect(focusedRow()).toBe("tag:alpha");
    });

    it("with no row left it lands in the field, and Escape there comes to the top of the whole list", () => {
      const { update } = setup({ currentRowKey: null, rows: [] });
      expect(enter()).toBe(true);
      expect(focusedRow()).toBeNull();
      expect(screen.getByRole("textbox", { name: "The filter" })).toHaveFocus();
      update({ rows: ROWS });
      act(() => { handle.current!.fieldEscape(); });
      expect(focusedRow()).toBe("all");
    });

    it("lands on the top visible row when the filter left the row out", () => {
      setup({ rows: ["tag:alpha", "tag:gamma"] });
      expect(enter()).toBe(true);
      expect(focusedRow()).toBe("tag:alpha");
    });

    it("lands in the field when no row is left, and its Escape comes to the current row", () => {
      const { update, feed } = setup({ rows: [] });
      expect(enter()).toBe(true);
      expect(focusedRow()).toBeNull();
      const field = screen.getByRole("textbox", { name: "The filter" });
      expect(field).toHaveFocus();
      update({ rows: ROWS });
      act(() => { handle.current!.fieldEscape(); });
      expect(focusedRow()).toBe("tag:beta");
      expect(field).not.toHaveFocus();
      expect(feed.release).not.toHaveBeenCalled();
    });

    it("lands in the field of a sidebar opening for it, once the field is on the page", () => {
      setup({ rows: [], sidebarHidden: true });
      expect(enter()).toBe(true);
      expect(sidebar.opened).toBe(true);
      expect(screen.getByRole("textbox", { name: "The filter" })).toHaveFocus();
    });
  });

  describe("walking (М2)", () => {
    it("moves over the rows without opening any", () => {
      const { onOpen } = setup();
      enter();
      key({ key: "ArrowDown" });
      expect(focusedRow()).toBe("tag:gamma");
      key({ key: "ArrowUp" });
      key({ key: "ArrowUp" });
      expect(focusedRow()).toBe("tag:alpha");
      expect(onOpen).not.toHaveBeenCalled();
    });

    it("stops at both ends of the list, without wrapping", () => {
      setup({ currentRowKey: "tag:gamma" });
      enter();
      key({ key: "ArrowDown" });
      expect(focusedRow()).toBe("tag:gamma");
      key({ key: "ArrowUp" });
      key({ key: "ArrowUp" });
      key({ key: "ArrowUp" });
      expect(focusedRow()).toBe("all");
      key({ key: "ArrowUp" });
      expect(focusedRow()).toBe("all");
    });

    it("scrolls at once to the row it lands on", () => {
      setup();
      enter();
      const nav = document.querySelector<HTMLElement>("[data-sidebar-scroll]")!;
      const row = document.getElementById(sidebarRowDomId("tag:gamma"))!;
      const scrollTo = vi.fn();
      nav.scrollTo = scrollTo as unknown as typeof nav.scrollTo;
      nav.getBoundingClientRect = () => ({ top: 0, bottom: 100 }) as DOMRect;
      row.getBoundingClientRect = () => ({ top: 110, bottom: 150 }) as DOMRect;
      key({ key: "ArrowDown" });
      expect(scrollTo).toHaveBeenCalledWith({ top: 50, behavior: "instant" });
    });

    it("takes the arrow from what lies under it", () => {
      setup();
      enter();
      const heard = vi.fn();
      window.addEventListener("keydown", heard);
      const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
      act(() => { document.body.dispatchEvent(event); });
      window.removeEventListener("keydown", heard);
      expect(event.defaultPrevented).toBe(true);
      expect(heard).not.toHaveBeenCalled();
    });

    it("moves with the route under ⌘⌥↑↓, and only while it holds the focus", () => {
      setup();
      let moved = true;
      act(() => { moved = handle.current!.moveWithRoute("tag:alpha"); });
      expect(moved).toBe(false);
      enter();
      act(() => { moved = handle.current!.moveWithRoute("tag:alpha"); });
      expect(moved).toBe(true);
      expect(focusedRow()).toBe("tag:alpha");
    });
  });

  describe("opening (М3)", () => {
    it("opens the row once by a click on it, and the focus stays on the row", () => {
      const { onOpen } = setup();
      enter();
      key({ key: "ArrowUp" });
      key({ key: "Enter" });
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(onOpen).toHaveBeenCalledWith("tag:alpha");
      expect(focusedRow()).toBe("tag:alpha");
    });

    it("a held key opens it once", () => {
      const { onOpen } = setup();
      enter();
      key({ key: "Enter" });
      key({ key: "Enter", repeat: true });
      key({ key: "Enter", repeat: true });
      expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it("leaves ⇧↵ alone", () => {
      const { onOpen } = setup();
      enter();
      key({ key: "Enter", shiftKey: true });
      expect(onOpen).not.toHaveBeenCalled();
    });
  });

  describe("returning to the page (М4)", () => {
    it("gives the focus to the card the feed offers", () => {
      const { feed } = setup();
      enter();
      key({ key: "ArrowRight" });
      expect(feed.take).toHaveBeenCalledTimes(1);
      expect(focusedRow()).toBeNull();
    });

    it("stays on the row when the feed has no card", () => {
      const feed = { take: vi.fn(() => false), release: vi.fn() };
      setup({ feed });
      enter();
      key({ key: "ArrowRight" });
      expect(feed.take).toHaveBeenCalledTimes(1);
      expect(focusedRow()).toBe("tag:beta");
    });

    it("comes back as the sidebar is hidden", () => {
      const { feed, update } = setup();
      enter();
      update({ sidebarHidden: true });
      expect(feed.take).toHaveBeenCalledTimes(1);
      expect(focusedRow()).toBeNull();
    });

    it("ends with no feed to take it, as on the way to the graph", () => {
      const { update } = setup();
      enter();
      update({ feed: null, feedOnScreen: false });
      expect(focusedRow()).toBeNull();
    });
  });

  describe("ending it", () => {
    it("Escape takes the focus off, with nothing focused after", () => {
      const { feed } = setup();
      enter();
      key({ key: "Escape" });
      expect(focusedRow()).toBeNull();
      expect(feed.release).toHaveBeenCalledTimes(1);
      expect(feed.take).not.toHaveBeenCalled();
    });

    it("a pointer that moved ends it", () => {
      const { feed } = setup();
      enter();
      pointer("pointermove", { x: 10, y: 10 });
      expect(focusedRow()).toBeNull();
      expect(feed.release).toHaveBeenCalledTimes(1);
    });

    it("a pointer that did not move does not end it, even at a repeated report", () => {
      setup();
      enter();
      pointer("pointermove", { x: 10, y: 10, dx: 0, dy: 0 });
      expect(focusedRow()).toBe("tag:beta");
      // WebKit's repeat after a scroll can claim movement at the very same point.
      pointer("pointermove", { x: 10, y: 10, dx: 3, dy: 0 });
      expect(focusedRow()).toBe("tag:beta");
      // A new point is a move, whatever the report says of its movement.
      pointer("pointermove", { x: 11, y: 10, dx: 0, dy: 0 });
      expect(focusedRow()).toBeNull();
    });

    it("a press ends it", () => {
      setup();
      enter();
      pointer("pointerdown", { x: 10, y: 10, dx: 0, dy: 0 });
      expect(focusedRow()).toBeNull();
    });

    it("the bar's entries stay under a pointer on the way to them, and a press on them", () => {
      setup();
      enter();
      const entry = screen.getByRole("button", { name: "An entry of the bar" });
      pointer("pointermove", { x: 10, y: 10 }, entry);
      pointer("pointerdown", { x: 10, y: 10 }, entry);
      expect(focusedRow()).toBe("tag:beta");
    });
  });

  describe("what keeps its own keys", () => {
    it("a field and a dialog, ⌘K included", () => {
      const { onOpen } = setup();
      enter();
      for (const target of [screen.getByRole("textbox", { name: "A field" }), screen.getByRole("button", { name: "A button in a dialog" })]) {
        key({ key: "ArrowDown" }, target);
        key({ key: "Enter" }, target);
        key({ key: "Escape" }, target);
        key({ key: "k", metaKey: true }, target);
      }
      expect(focusedRow()).toBe("tag:beta");
      expect(onOpen).not.toHaveBeenCalled();
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("takes the keys in the sidebar over the feed, which holds the DOM focus (У4)", async () => {
      const { onOpen } = setup();
      enter();
      const panel = screen.getByRole("dialog", { name: "Sidebar" });
      key({ key: "ArrowDown" }, panel);
      expect(focusedRow()).toBe("tag:gamma");
      key({ key: "Enter" }, panel);
      expect(onOpen).toHaveBeenCalledWith("tag:gamma");
      key({ key: "k", metaKey: true }, panel);
      expect(await screen.findByRole("menu")).toBeInTheDocument();
    });

    it("hears no key once the focus left", () => {
      const { onOpen } = setup();
      enter();
      key({ key: "Escape" });
      key({ key: "Enter" });
      key({ key: "ArrowDown" });
      expect(onOpen).not.toHaveBeenCalled();
      expect(focusedRow()).toBeNull();
    });
  });

  describe("ArrowRight, always back to the current collection (М4)", () => {
    it("on the row the focus came from goes back, opening nothing", () => {
      const { onOpen, feed } = setup();
      enter();
      key({ key: "ArrowRight" });
      expect(feed.take).toHaveBeenCalledTimes(1);
      expect(onOpen).not.toHaveBeenCalled();
      expect(focusedRow()).toBeNull();
    });

    it("on another row goes back too: it clicks nothing and changes no route", () => {
      const { onOpen, feed } = setup();
      enter();
      key({ key: "ArrowUp" });
      expect(focusedRow()).toBe("tag:alpha");
      key({ key: "ArrowRight" });
      expect(onOpen).not.toHaveBeenCalled();
      expect(feed.take).toHaveBeenCalledTimes(1);
      expect(focusedRow()).toBeNull();
    });

    it("on any row stays in the menu while the feed has no card", () => {
      const empty = { take: vi.fn(() => false), release: vi.fn() };
      const { onOpen } = setup({ feed: empty });
      enter();
      key({ key: "ArrowUp" });
      key({ key: "ArrowRight" });
      expect(empty.take).toHaveBeenCalledTimes(1);
      expect(onOpen).not.toHaveBeenCalled();
      expect(focusedRow()).toBe("tag:alpha");
    });

    it("from an open card ⌘⌥↑↓ waits for a new feed still on its way, and it takes the focus once", () => {
      const notYet = { take: vi.fn(() => false), release: vi.fn() };
      const { update } = setup({ feed: notYet, cardOpen: true });
      key({ key: "ArrowLeft" });
      act(() => { handle.current!.moveWithRoute("tag:alpha"); });
      update({ currentRowKey: "tag:alpha", cardOpen: false });
      expect(notYet.take).toHaveBeenCalledTimes(1);
      const ready = { take: vi.fn(() => true), release: vi.fn() };
      update({ feed: ready });
      expect(ready.take).toHaveBeenCalledTimes(1);
      const later = { take: vi.fn(() => true), release: vi.fn() };
      update({ feed: later });
      expect(later.take).not.toHaveBeenCalled();
    });

    it("from an open card ⌘⌥↑↓ does not hand the focus to a feed of a later route", () => {
      const empty = { take: vi.fn(() => false), release: vi.fn() };
      const { update } = setup({ feed: empty, cardOpen: true });
      key({ key: "ArrowLeft" });
      act(() => { handle.current!.moveWithRoute("tag:alpha"); });
      update({ currentRowKey: "tag:alpha", cardOpen: false });
      update({ currentRowKey: "tag:gamma" });
      const other = { take: vi.fn(() => true), release: vi.fn() };
      update({ feed: other });
      expect(other.take).not.toHaveBeenCalled();
    });

    it("after Enter in the feed it goes to the feed of the collection that opened, from any row", () => {
      const { onOpen, feed, update } = setup();
      enter();
      key({ key: "ArrowUp" });
      key({ key: "Enter" });
      expect(onOpen).toHaveBeenCalledTimes(1);
      update({ currentRowKey: "tag:alpha" });
      expect(focusedRow()).toBe("tag:alpha");
      expect(feed.take).not.toHaveBeenCalled();
      key({ key: "ArrowDown" });
      expect(focusedRow()).toBe("tag:beta");

      key({ key: "ArrowRight" });
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(feed.take).toHaveBeenCalledTimes(1);
      expect(focusedRow()).toBeNull();
    });

    it("Escape still goes back on any row, opening nothing", () => {
      const { onOpen, feed } = setup();
      enter();
      key({ key: "ArrowUp" });
      key({ key: "Escape" });
      expect(onOpen).not.toHaveBeenCalled();
      expect(feed.release).toHaveBeenCalledTimes(1);
      expect(focusedRow()).toBeNull();
    });
  });

  describe("a hidden sidebar (М8)", () => {
    it("opens for the keyboard, and the focus stands on the current row", () => {
      setup({ sidebarHidden: true });
      expect(sidebar.shown).toBe(false);
      expect(enter()).toBe(true);
      expect(sidebar.opened).toBe(true);
      expect(sidebar.shown).toBe(true);
      expect(focusedRow()).toBe("tag:beta");
    });

    it("opens on a place with no row of its own too", () => {
      setup({ sidebarHidden: true, currentRowKey: null });
      expect(enter()).toBe(true);
      expect(sidebar.shown).toBe(true);
      expect(focusedRow()).toBe("all");
    });

    it("stays through Enter, on another row and on the current one, the focus with it", () => {
      const { onOpen, feed, update } = setup({ sidebarHidden: true });
      enter();
      key({ key: "Enter" });
      expect(onOpen).toHaveBeenCalledWith("tag:beta");
      expect(sidebar.shown).toBe(true);
      expect(focusedRow()).toBe("tag:beta");

      key({ key: "ArrowUp" });
      key({ key: "Enter" });
      update({ currentRowKey: "tag:alpha" });
      expect(sidebar.shown).toBe(true);
      expect(sidebar.opened).toBe(true);
      expect(focusedRow()).toBe("tag:alpha");
      expect(feed.take).not.toHaveBeenCalled();
    });

    it("hides on ArrowRight on the row the focus came from", () => {
      const { feed } = setup({ sidebarHidden: true });
      enter();
      key({ key: "ArrowRight" });
      expect(feed.take).toHaveBeenCalledTimes(1);
      expect(sidebar.shown).toBe(false);
      expect(sidebar.opened).toBe(false);
      expect(focusedRow()).toBeNull();
    });

    it("hides on ArrowRight on another row, the route staying", () => {
      const { feed, onOpen } = setup({ sidebarHidden: true });
      enter();
      key({ key: "ArrowUp" });
      key({ key: "ArrowRight" });
      expect(sidebar.shown).toBe(false);
      expect(onOpen).not.toHaveBeenCalled();
      expect(feed.take).toHaveBeenCalledTimes(1);
    });

    it("ArrowRight with no card on the row it came from leaves the focus there and the sidebar open", () => {
      const feed = { take: vi.fn(() => false), release: vi.fn() };
      setup({ sidebarHidden: true, feed });
      enter();
      key({ key: "ArrowRight" });
      expect(sidebar.shown).toBe(true);
      expect(focusedRow()).toBe("tag:beta");
    });

    it("hides on Escape, with nothing focused after", () => {
      const { feed } = setup({ sidebarHidden: true });
      enter();
      key({ key: "Escape" });
      expect(sidebar.shown).toBe(false);
      expect(feed.release).toHaveBeenCalledTimes(1);
      expect(feed.take).not.toHaveBeenCalled();
      expect(focusedRow()).toBeNull();
    });

    it("the pointer ends the mode and leaves it open; a later route change hides it", () => {
      const { feed, update } = setup({ sidebarHidden: true });
      enter();
      pointer("pointermove", { x: 10, y: 10 });
      expect(focusedRow()).toBeNull();
      expect(sidebar.shown).toBe(true);

      update({ currentRowKey: "tag:alpha" });
      expect(sidebar.shown).toBe(false);
      // The pointer holds the page now: no card takes the focus.
      expect(feed.take).not.toHaveBeenCalled();
    });

    it("the person's own hiding returns the focus and leaves nothing to restore", () => {
      const { feed, update } = setup({ sidebarHidden: true });
      enter();
      act(() => sidebar.setOpened(false));
      expect(focusedRow()).toBeNull();
      expect(feed.take).toHaveBeenCalledTimes(1);

      // Later route changes have nothing to hide and no focus to hand on.
      update({ currentRowKey: "tag:alpha" });
      expect(feed.take).toHaveBeenCalledTimes(1);
    });

    it("a drag of the edge keeps it open after the route changes", () => {
      const { update } = setup({ sidebarHidden: true });
      enter();
      // What is stored says open now, and the page ends the visit's flag.
      update({ sidebarHidden: false });
      act(() => sidebar.setOpened(false));
      update({ currentRowKey: "tag:alpha" });
      expect(sidebar.shown).toBe(true);
      expect(focusedRow()).toBe("tag:beta");
    });

    it("a renamed collection's new route is no route change", () => {
      const { update, feed } = setup({ sidebarHidden: true });
      enter();
      act(() => handle.current!.followRename("tag:beta", "tag:bravo"));
      update({ rows: ["all", "tag:alpha", "tag:bravo", "tag:gamma"], currentRowKey: "tag:bravo" });
      expect(sidebar.shown).toBe(true);
      expect(focusedRow()).toBe("tag:bravo");
      expect(feed.take).not.toHaveBeenCalled();
    });

    it("leaves an open sidebar open through Enter, ArrowRight and Escape", () => {
      const { update } = setup();
      enter();
      expect(sidebar.opened).toBe(false);
      key({ key: "ArrowUp" });
      key({ key: "Enter" });
      update({ currentRowKey: "tag:alpha" });
      expect(sidebar.shown).toBe(true);
      expect(focusedRow()).toBe("tag:alpha");
      key({ key: "ArrowRight" });
      expect(sidebar.shown).toBe(true);
      expect(focusedRow()).toBeNull();
      enter();
      key({ key: "Escape" });
      expect(sidebar.shown).toBe(true);
    });
  });

  describe("the row's menu (М7)", () => {
    it("⌘K opens the row's own menu, and the menu takes the keyboard", async () => {
      const { onOpen } = setup();
      enter();
      key({ key: "k", metaKey: true });
      expect(await screen.findByRole("menuitem", { name: "Rename tag:beta" })).toBeInTheDocument();
      const menu = screen.getByRole("menu");
      key({ key: "ArrowDown" }, menu);
      key({ key: "Enter" }, menu);
      expect(focusedRow()).toBe("tag:beta");
      expect(onOpen).not.toHaveBeenCalled();
    });

    it("comes out of the row: under it, from where its name starts", async () => {
      setup();
      enter();
      const row = document.getElementById(sidebarRowDomId("tag:beta"))!;
      const name = row.querySelector("[data-sidebar-name-text]")!;
      name.getBoundingClientRect = () => ({ left: 24 }) as DOMRect;
      row.getBoundingClientRect = () => ({ bottom: 160 }) as DOMRect;
      const opened = vi.fn();
      row.addEventListener("contextmenu", (event) => opened(event.clientX, event.clientY));
      key({ key: "k", metaKey: true });
      expect(opened).toHaveBeenCalledWith(24, 160);
      expect(await screen.findByRole("menu")).toBeInTheDocument();
    });

    it("⌘K pressed again closes it, and the focus stays on the row", async () => {
      setup();
      enter();
      key({ key: "k", metaKey: true });
      const menu = await screen.findByRole("menu");
      key({ key: "k", metaKey: true }, menu);
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(focusedRow()).toBe("tag:beta");
    });

    it("Escape closes it, and the focus stays on the row", async () => {
      setup();
      enter();
      key({ key: "k", metaKey: true });
      const menu = await screen.findByRole("menu");
      key({ key: "Escape" }, menu);
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(focusedRow()).toBe("tag:beta");
    });

    it("answers a rebound chord", async () => {
      setCommandOverrides({ "sidebar-menu": { key: "j", meta: true } });
      setup();
      enter();
      key({ key: "k", metaKey: true });
      expect(screen.queryByRole("menu")).toBeNull();
      key({ key: "j", metaKey: true });
      expect(await screen.findByRole("menu")).toBeInTheDocument();
    });

    it("Everything's row has no menu, and ⌘K opens nothing", () => {
      setup({ currentRowKey: "all" });
      enter();
      key({ key: "k", metaKey: true });
      expect(screen.queryByRole("menu")).toBeNull();
      expect(focusedRow()).toBe("all");
    });

    it("a pointer on the open menu does not end the mode", async () => {
      setup();
      enter();
      key({ key: "k", metaKey: true });
      const menu = await screen.findByRole("menu");
      pointer("pointermove", { x: 10, y: 10 }, menu);
      expect(focusedRow()).toBe("tag:beta");
    });

    it("an action of the menu works, and the focus stays on the renamed row", async () => {
      const { onRename, update } = setup();
      enter();
      key({ key: "k", metaKey: true });
      fireEvent.click(await screen.findByRole("menuitem", { name: "Rename tag:beta" }));
      expect(onRename).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

      act(() => handle.current!.followRename("tag:beta", "tag:bravo"));
      update({ rows: ["all", "tag:alpha", "tag:bravo", "tag:gamma"] });
      expect(focusedRow()).toBe("tag:bravo");
    });

    it("after a delete the focus is on a neighbour", () => {
      const { update } = setup();
      enter();
      update({ rows: ["all", "tag:alpha", "tag:gamma"] });
      expect(focusedRow()).toBe("tag:gamma");
      key({ key: "ArrowUp" });
      expect(focusedRow()).toBe("tag:alpha");
    });

    it("after the last row is deleted the focus is on the row above", () => {
      const { update } = setup({ currentRowKey: "tag:gamma" });
      enter();
      update({ rows: ["all", "tag:alpha", "tag:beta"] });
      expect(focusedRow()).toBe("tag:beta");
    });
  });
});

describe("typing in the menu: what stands around it (SPEC_KEYBOARD.md, «Ввод текста в меню»)", () => {
  const filter = () => screen.getByRole("textbox", { name: "The filter" }) as HTMLInputElement;
  const list = () => document.querySelector<HTMLElement>("[data-sidebar-scroll]")!;
  const escapeInField = () => {
    let taken = false;
    act(() => { taken = handle.current!.fieldEscape(); });
    return taken;
  };

  it("Escape puts the list back where it stood, whatever the filter did to it", () => {
    setup();
    act(() => { handle.current!.enter(); });
    list().scrollTop = 120;
    key({ key: "b" });
    list().scrollTop = 0;
    expect(escapeInField()).toBe(true);
    expect(handle.current!.rowKey).toBe("tag:beta");
    expect(list().scrollTop).toBe(120);
    expect(document.activeElement).not.toBe(filter());
  });

  it("ArrowRight puts the list back where it stood as well, the query gone", () => {
    const { feed } = setup();
    act(() => { handle.current!.enter(); });
    list().scrollTop = 120;
    key({ key: "b" });
    expect(filter()).toHaveValue("b");
    act(() => { handle.current!.fieldDown(); });
    list().scrollTop = 0;
    key({ key: "ArrowRight" });
    expect(filter()).toHaveValue("");
    expect(list().scrollTop).toBe(120);
    expect(feed.take).toHaveBeenCalledTimes(1);
    expect(handle.current!.rowKey).toBeNull();
  });

  it("ArrowRight with no card for it leaves the focus and the query where they are", () => {
    const empty = { take: vi.fn(() => false), release: vi.fn() };
    setup({ feed: empty });
    act(() => { handle.current!.enter(); });
    key({ key: "b" });
    act(() => { handle.current!.fieldDown(); });
    key({ key: "ArrowRight" });
    expect(filter()).toHaveValue("b");
    expect(handle.current!.rowKey).toBe("all");
  });

  it("after the route moved the old place of the list means nothing, and the route's row is the one to return to", () => {
    const { update } = setup();
    act(() => { handle.current!.enter(); });
    list().scrollTop = 120;
    key({ key: "a" });
    list().scrollTop = 40;
    update({ currentRowKey: "tag:alpha" });
    expect(filter()).toHaveFocus();
    expect(escapeInField()).toBe(true);
    expect(handle.current!.rowKey).toBe("tag:alpha");
    expect(list().scrollTop).toBe(40);
  });

  it("a remembered row gone by Escape hands the focus to the row at its place", () => {
    const { update } = setup();
    act(() => { handle.current!.enter(); });
    key({ key: "a" });
    update({ rows: ["all", "tag:alpha", "tag:gamma"] });
    expect(escapeInField()).toBe(true);
    expect(handle.current!.rowKey).toBe("tag:gamma");
  });

  it("a remembered row renamed is still the one to return to", () => {
    const { update } = setup();
    act(() => { handle.current!.enter(); });
    key({ key: "a" });
    act(() => { handle.current!.followRename("tag:beta", "tag:bravo"); });
    update({ rows: ["all", "tag:alpha", "tag:bravo", "tag:gamma"], currentRowKey: "tag:bravo" });
    expect(escapeInField()).toBe(true);
    expect(handle.current!.rowKey).toBe("tag:bravo");
  });

  it("no rows at all do not end the focus while the caret is in the field", () => {
    const { update, feed } = setup();
    act(() => { handle.current!.enter(); });
    key({ key: "z" });
    update({ rows: [] });
    expect(filter()).toHaveFocus();
    expect(feed.take).not.toHaveBeenCalled();
    act(() => { handle.current!.fieldDown(); });
    expect(filter()).toHaveFocus();
    expect(handle.current!.rowKey).toBeNull();
  });

  it("the sidebar hidden with the caret in the field gives the focus back to the page", () => {
    const { feed } = setup({ sidebarHidden: true });
    act(() => { handle.current!.enter(); });
    expect(sidebar.opened).toBe(true);
    key({ key: "b" });
    act(() => { sidebar.setOpened(false); });
    expect(sidebar.shown).toBe(false);
    expect(feed.take).toHaveBeenCalledTimes(1);
    expect(handle.current!.rowKey).toBeNull();
  });

  it("the route walking onto a row the filter hides leaves the focus where it stands in the list", () => {
    const { update } = setup();
    act(() => { handle.current!.enter(); });
    update({ rows: ["tag:alpha", "tag:beta"] });
    act(() => { handle.current!.moveWithRoute("tag:gamma"); });
    expect(handle.current!.rowKey).toBe("tag:beta");
  });

  it("a character is not the row's while a dialog, another field or the row's menu holds it", async () => {
    setup();
    act(() => { handle.current!.enter(); });
    key({ key: "x" }, screen.getByRole("button", { name: "A button in a dialog" }));
    expect(filter()).toHaveValue("");
    key({ key: "x" }, screen.getByRole("textbox", { name: "A field" }));
    expect(filter()).toHaveValue("");
    key({ key: "k", metaKey: true });
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    key({ key: "x" });
    expect(filter()).toHaveValue("");
    expect(handle.current!.rowKey).toBe("tag:beta");
  });
});

describe("from the graph (SPEC_KEYBOARD.md, «Graph»)", () => {
  const filter = () => screen.getByRole("textbox", { name: "The filter" }) as HTMLInputElement;
  const onGraph = (overrides: Partial<Parameters<typeof Page>[0]> = {}) => setup({ feedOnScreen: false, feed: null, ...overrides });

  it("ArrowLeft goes to the current route's row", () => {
    onGraph();
    key({ key: "ArrowLeft" });
    expect(focusedRow()).toBe("tag:beta");
  });

  it("opens a hidden sidebar for the visit", () => {
    onGraph({ sidebarHidden: true });
    key({ key: "ArrowLeft" });
    expect(focusedRow()).toBe("tag:beta");
    expect(sidebar.opened).toBe(true);
  });

  it("does nothing with a modifier, from a field, from a dialog or with a menu open", async () => {
    onGraph();
    key({ key: "ArrowLeft", metaKey: true });
    key({ key: "ArrowLeft", shiftKey: true });
    expect(focusedRow()).toBeNull();
    const field = screen.getByRole("textbox", { name: "A field" });
    act(() => field.focus());
    key({ key: "ArrowLeft" }, field);
    expect(focusedRow()).toBeNull();
    act(() => field.blur());
    key({ key: "ArrowLeft" }, screen.getByRole("button", { name: "A button in a dialog" }));
    expect(focusedRow()).toBeNull();
    fireEvent.contextMenu(document.getElementById(sidebarRowDomId("tag:beta"))!);
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    key({ key: "ArrowLeft" });
    expect(focusedRow()).toBeNull();
  });

  it("lands on the top row where the route has no row", () => {
    onGraph({ currentRowKey: null });
    key({ key: "ArrowLeft" });
    expect(focusedRow()).toBe("all");
  });

  it("lands on the top visible row when the filter hides the route's, and in the field with no row left", () => {
    const { update } = onGraph({ rows: ["all", "tag:alpha"] });
    key({ key: "ArrowLeft" });
    expect(focusedRow()).toBe("all");
    key({ key: "Escape" });
    update({ rows: [] });
    key({ key: "ArrowLeft" });
    expect(screen.getByRole("textbox", { name: "The filter" })).toHaveFocus();
  });

  it("the walk, ⌘K and typing work as from the feed", async () => {
    onGraph();
    key({ key: "ArrowLeft" });
    key({ key: "ArrowUp" });
    expect(focusedRow()).toBe("tag:alpha");
    key({ key: "k", metaKey: true });
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    key({ key: "k", metaKey: true });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    key({ key: "x" });
    expect(filter()).toHaveFocus();
    expect(filter()).toHaveValue("x");
    expect(focusedRow()).toBeNull();
    act(() => { handle.current!.fieldEscape(); });
    expect(focusedRow()).toBe("tag:alpha");
    expect(filter()).toHaveValue("");
  });

  it("ArrowRight on the row it came from returns to the graph with nothing focused", () => {
    onGraph({ sidebarHidden: true });
    key({ key: "ArrowLeft" });
    key({ key: "ArrowRight" });
    expect(focusedRow()).toBeNull();
    expect(sidebar.shown).toBe(false);
  });

  it("Escape returns to the graph with nothing focused", () => {
    onGraph({ sidebarHidden: true });
    key({ key: "ArrowLeft" });
    key({ key: "Escape" });
    expect(focusedRow()).toBeNull();
    expect(sidebar.shown).toBe(false);
  });

  it("ArrowRight on another row returns to the graph too: it clicks nothing, and a hidden sidebar goes", () => {
    const { onOpen } = onGraph({ sidebarHidden: true });
    key({ key: "ArrowLeft" });
    key({ key: "ArrowUp" });
    key({ key: "ArrowRight" });
    expect(onOpen).not.toHaveBeenCalled();
    expect(focusedRow()).toBeNull();
    expect(sidebar.shown).toBe(false);
  });

  it("Enter opens the row and the focus stays on it, the sidebar too", () => {
    const { update, onOpen } = onGraph({ sidebarHidden: true });
    key({ key: "ArrowLeft" });
    key({ key: "ArrowUp" });
    key({ key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("tag:alpha");
    update({ currentRowKey: "tag:alpha" });
    expect(focusedRow()).toBe("tag:alpha");
    expect(sidebar.shown).toBe(true);
  });

  it("⌘⌥↑↓ moves the focus with the route and stays on the graph", () => {
    const { update } = onGraph();
    key({ key: "ArrowLeft" });
    act(() => { handle.current!.moveWithRoute("tag:gamma"); });
    update({ currentRowKey: "tag:gamma" });
    expect(focusedRow()).toBe("tag:gamma");
  });

  it("Tab to the feed ends it with nothing focused: the feed takes no card, and a hidden sidebar goes", () => {
    const feed = { take: vi.fn(() => true), release: vi.fn() };
    const { update } = onGraph({ sidebarHidden: true });
    key({ key: "ArrowLeft" });
    update({ feedOnScreen: true, feed });
    expect(focusedRow()).toBeNull();
    expect(feed.take).not.toHaveBeenCalled();
    expect(sidebar.shown).toBe(false);
  });

  it("a card opening over it by other means ends it", () => {
    const { update } = onGraph();
    key({ key: "ArrowLeft" });
    update({ cardOpen: true });
    expect(focusedRow()).toBeNull();
  });

  it("the pointer ends it, the sidebar staying", () => {
    onGraph({ sidebarHidden: true });
    key({ key: "ArrowLeft" });
    fireEvent.pointerDown(document.body);
    expect(focusedRow()).toBeNull();
    expect(sidebar.shown).toBe(true);
  });

  it("with a card open over it the card's rules hold: any row goes back, and Enter toggles rather than opens", () => {
    const { onOpen } = onGraph({ cardOpen: true });
    key({ key: "ArrowLeft" });
    expect(focusedRow()).toBe("tag:beta");
    expect(handle.current!.overCard).toBe(true);
    key({ key: "ArrowUp" });
    key({ key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();
    key({ key: "ArrowRight" });
    expect(focusedRow()).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("moving a row (SPEC_KEYBOARD.md, М11)", () => {
  const list = () => document.querySelector<HTMLElement>("[data-sidebar-scroll]")!;

  it("⌘⇧↑ and ⌘⇧↓ move the focused row one place, and the focus stays on it", () => {
    const { moveRow, update } = setup();
    enter();
    key({ key: "ArrowDown", metaKey: true, shiftKey: true });
    expect(moveRow).toHaveBeenLastCalledWith("tag:beta", 1);
    update({ rows: ["all", "tag:alpha", "tag:gamma", "tag:beta"] });
    expect(focusedRow()).toBe("tag:beta");
    key({ key: "ArrowUp", metaKey: true, shiftKey: true });
    expect(moveRow).toHaveBeenLastCalledWith("tag:beta", -1);
    expect(focusedRow()).toBe("tag:beta");
  });

  it("shows the moved row at once, scrolling just enough", () => {
    const { update } = setup();
    enter();
    const nav = list();
    const scrollTo = vi.fn();
    nav.scrollTo = scrollTo as unknown as typeof nav.scrollTo;
    nav.getBoundingClientRect = () => ({ top: 0, bottom: 100 }) as DOMRect;
    document.getElementById(sidebarRowDomId("tag:beta"))!.getBoundingClientRect = () => ({ top: 150, bottom: 170 }) as DOMRect;
    key({ key: "ArrowDown", metaKey: true, shiftKey: true });
    update({ rows: ["all", "tag:alpha", "tag:gamma", "tag:beta"] });
    expect(scrollTo).toHaveBeenCalledWith({ top: 70, behavior: "instant" });
  });

  it("a move that did not happen changes nothing", () => {
    const moveRow = vi.fn(() => false);
    const { update } = setup({ moveRow });
    enter();
    const nav = list();
    const scrollTo = vi.fn();
    nav.scrollTo = scrollTo as unknown as typeof nav.scrollTo;
    key({ key: "ArrowUp", metaKey: true, shiftKey: true });
    update({ rows: [...ROWS] });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(focusedRow()).toBe("tag:beta");
  });

  it("the walk's own arrows and other modifiers are not the move", () => {
    const { moveRow } = setup();
    enter();
    key({ key: "ArrowDown" });
    key({ key: "ArrowDown", metaKey: true });
    key({ key: "ArrowDown", shiftKey: true });
    key({ key: "ArrowDown", metaKey: true, altKey: true });
    expect(moveRow).not.toHaveBeenCalled();
  });

  it("does not start from a field, a dialog, or with the row's menu open", async () => {
    const { moveRow } = setup();
    enter();
    key({ key: "ArrowDown", metaKey: true, shiftKey: true }, screen.getByRole("textbox", { name: "A field" }));
    key({ key: "ArrowDown", metaKey: true, shiftKey: true }, screen.getByRole("button", { name: "A button in a dialog" }));
    key({ key: "k", metaKey: true });
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    key({ key: "ArrowDown", metaKey: true, shiftKey: true });
    expect(moveRow).not.toHaveBeenCalled();
  });

  it("does nothing with no row in focus, in the filter's field either", () => {
    const { moveRow } = setup();
    key({ key: "ArrowDown", metaKey: true, shiftKey: true });
    enter();
    key({ key: "b" });
    key({ key: "ArrowDown", metaKey: true, shiftKey: true }, screen.getByRole("textbox", { name: "The filter" }));
    expect(moveRow).not.toHaveBeenCalled();
  });

  it("works from a card and from the graph", () => {
    const fromCard = setup({ cardOpen: true });
    key({ key: "ArrowLeft" });
    key({ key: "ArrowDown", metaKey: true, shiftKey: true });
    expect(fromCard.moveRow).toHaveBeenCalledWith("tag:beta", 1);
    fromCard.unmount();
    const fromGraph = setup({ feedOnScreen: false, feed: null });
    key({ key: "ArrowLeft" });
    key({ key: "ArrowDown", metaKey: true, shiftKey: true });
    expect(fromGraph.moveRow).toHaveBeenCalledWith("tag:beta", 1);
  });
});
