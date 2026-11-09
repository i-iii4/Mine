// Where the keyboard's focus is: on a row of the sidebar, or with the page
// (SPEC_KEYBOARD.md, «Sidebar»). This hook is the one owner of that answer. While
// a row holds the focus the feed holds none, so the two cannot disagree: the feed
// gave its card up on the way here and takes a card back on the way out.
//
// A hidden sidebar opens for the visit and goes after it (М8). Whether it was
// opened that way is one flag, never stored, and this owner decides when it ends.
//
// The focus comes here from the feed's left edge, from an open card when the keyboard
// is not in text (М9), from the graph, and from the filter's field. Enter is the row's
// main action, the focus staying here (М3). ArrowRight always goes back to the current
// collection, from any row, and never opens one (М4).
//
// A character typed on a row takes the focus to the filter's field, which remembers
// the row: it stands on a row, in the field with a remembered row, or nowhere here. A
// row and the field never hold it together (SPEC_KEYBOARD.md, «Ввод текста в меню»).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { commandById } from "@/lib/commandRegistry";
import {
  isDetailShortcutBlockedTarget,
  isEditableKeyboardTarget,
  isKeyboardInText,
  isPrintableKeyboardKey,
} from "@/lib/keyboardTargets";
import { closeOpenMenu, isMenuOpen } from "@/lib/openMenus";
import {
  focusedRowKey,
  focusOpenCardRoot,
  openFocusedSidebarRow,
  openFocusedSidebarRowMenu,
  restoreSidebarListScroll,
  settleMovedRowMarks,
  showFocusedSidebarRow,
  sidebarListScrollTop,
  toggleFocusedSidebarRowConnection,
  walkedRow,
  type SidebarFocusedRow,
} from "@/lib/sidebarKeyboardFocus";
import { SIDEBAR_ALL_ROW_KEY } from "@/lib/sidebarSearch";

/** What the feed answers when the focus comes back to the page. */
export interface FeedKeyboardFocus {
  /** A card takes the focus: the one it left on, or the first visible in a new
   *  feed. False when the feed has no card to take it. */
  take(): boolean;
  /** The focus ended in the sidebar: nothing is focused, as after Escape on a card. */
  release(): void;
}

export interface SidebarKeyboardFocus {
  /** The row holding the focus, or null while the page holds it. */
  rowKey: string | null;
  /** The focus came from an open card, which is still open. */
  overCard: boolean;
  /** ArrowLeft reached the feed's left edge. True when a row took the focus. */
  enter(): boolean;
  /** The route moved by ⌘⌥↑↓. True when the focus moved with it. */
  moveWithRoute(rowKey: string): boolean;
  /** A collection took a new name: the focus stays on its row. */
  followRename(fromRowKey: string, toRowKey: string): void;
  /** The feed's report of how it takes the focus back; null when it is gone. */
  reportFeed(feed: FeedKeyboardFocus | null): void;
  /** The bar's entries, which do what the keys do: Enter, ⌘K, ArrowRight, Escape. */
  open(): void;
  openMenu(): void;
  go(): void;
  unfocus(): void;
  /** The filter's field took or lost the DOM focus, by whatever path. */
  fieldFocused(): void;
  fieldBlurred(event: { target: EventTarget }): void;
  /** ArrowDown in the field: the focus goes to the top row of the list. */
  fieldDown(): void;
  /** Escape in the field. True when a remembered row took the focus back. */
  fieldEscape(): boolean;
}

export interface SidebarKeyboardFocusOptions {
  /** The rows that open by a click, in order. */
  rows: readonly string[];
  /** The row of the route the page stands on; null on a place with no row. */
  currentRowKey: string | null;
  /** The feed is the view on screen, a card open over it or not. */
  feedOnScreen: boolean;
  /** A card is open, in its window or full page. */
  cardOpen: boolean;
  /** The sidebar is on screen, for whatever reason. */
  sidebarShown: boolean;
  /** The sidebar is on screen only because the keyboard opened it. */
  openedForKeyboard: boolean;
  /** Shows the hidden sidebar for the keyboard, or hides it after, storing nothing. */
  setOpenedForKeyboard: (open: boolean) => void;
  /** A row took the focus. */
  onEnter?: () => void;
  /** The filter's text. */
  filterQuery: string;
  setFilterQuery: (query: string) => void;
  /** The filter's field, on the page whenever the sidebar is. */
  filterFieldRef: RefObject<HTMLInputElement | null>;
  /** ⌘⇧↑↓: moves the row's collection one place. False when it did not move (М11). */
  moveRow: (rowKey: string, direction: 1 | -1) => boolean;
}

/** What the focus goes back to. The graph has no focus of its own, so nothing there
 *  takes it. */
type FocusSurface = "feed" | "card" | "graph";

function surfaceOnScreen(cardOpen: boolean, feedOnScreen: boolean): FocusSurface {
  if (cardOpen) return "card";
  return feedOnScreen ? "feed" : "graph";
}

/** A row holding the focus, and the surface the focus came from. */
type HeldFocus = SidebarFocusedRow & { from: FocusSurface };

/** The row the focus stood on before the first character, and where its list stood.
 *  No place for the list once the route has moved. */
type RememberedRow = SidebarFocusedRow & { scrollTop: number | null };

/** Whether a pointer event's place is the bottom bar. Its entries are this
 *  mode's commands, so a pointer on its way to one does not end the mode. */
function isOnBottomBar(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-bottom-action-bar]") !== null;
}

/** Whether a key belongs to a field, a dialog, a menu or the image preview. An open
 *  card and the sidebar over the feed are dialogs to assistive technology only: here
 *  they are surfaces of the page (SPEC_NARROW_WINDOW.md, У4). */
function keyBelongsElsewhere(target: EventTarget | null): boolean {
  if (isEditableKeyboardTarget(target) || isDetailShortcutBlockedTarget(target)) return true;
  return target instanceof Element && target.closest("[role='alertdialog']") !== null;
}

/** Whether ArrowLeft in an open card or on the graph goes to the rows: the keyboard is
 *  not in text, no layer holds it, and no player in focus seeks with it (М9). */
function arrowGoesToSidebar(target: EventTarget | null): boolean {
  if (isKeyboardInText() || isMenuOpen() || keyBelongsElsewhere(target)) return false;
  if (document.querySelector("[data-image-preview-overlay]") !== null) return false;
  return document.activeElement?.closest("video, audio") == null;
}

/** The keyboard's focus on the sidebar's rows. */
export function useSidebarKeyboardFocus({
  rows,
  currentRowKey,
  feedOnScreen,
  cardOpen,
  sidebarShown,
  openedForKeyboard,
  setOpenedForKeyboard,
  onEnter,
  filterQuery,
  setFilterQuery,
  filterFieldRef,
  moveRow,
}: SidebarKeyboardFocusOptions): SidebarKeyboardFocus {
  const [focus, setFocus] = useState<HeldFocus | null>(null);
  // The caret stands in the filter's field, and a row is remembered to come back to.
  const [inField, setInField] = useState(false);
  const rowKey = focus === null ? null : focusedRowKey(rows, focus);
  const feedRef = useRef<FeedKeyboardFocus | null>(null);

  // The acts read the list as it is at the keypress and keep their identity: the
  // feed subscribes to `enter`, and must not re-subscribe with every list change.
  const from = focus?.from ?? (inField ? surfaceOnScreen(cardOpen, feedOnScreen) : null);
  const fromCard = from === "card";
  const latest = {
    rows,
    currentRowKey,
    feedOnScreen,
    cardOpen,
    sidebarShown,
    openedForKeyboard,
    rowKey,
    from,
    fromCard,
    onEnter,
    filterQuery,
    setFilterQuery,
    filterFieldRef,
    inField,
    moveRow,
  };
  const latestRef = useRef(latest);
  latestRef.current = latest;

  // ⌘⌥↑↓ left an open card for another collection (М9), and its feed has yet to take
  // the focus: it takes it at its first report that has a card.
  const feedOwedFocusRef = useRef(false);
  // That move is on its way: the route hands the focus to the new feed, whatever the
  // sidebar was before.
  const leavingForRouteRef = useRef(false);
  // Lives while the focus walks between the field and the rows.
  const rememberedRowRef = useRef<RememberedRow | null>(null);
  // The focus moved out of the field itself: its blur is not the user leaving it.
  const leavingFieldRef = useRef(false);
  // The list comes back whole in the commit after Escape or ArrowRight, and a moved row
  // stands in its new place in the commit after ⌘⇧↑↓: only then can the list scroll.
  const rowToShowRef = useRef<{ rowKey: string; scrollTop: number | null; moved?: true } | null>(null);
  // ArrowLeft found no row to stand on: the field takes the focus, once it is on the
  // page, as a hidden sidebar opens in that very commit.
  const fieldOwedFocusRef = useRef(false);

  const reportFeed = useCallback((feed: FeedKeyboardFocus | null) => {
    feedRef.current = feed;
    if (feedOwedFocusRef.current && feed?.take()) feedOwedFocusRef.current = false;
  }, []);

  const takeFocus = useCallback((surface: FocusSurface) => {
    const now = latestRef.current;
    const current = now.currentRowKey;
    if (!now.sidebarShown) setOpenedForKeyboard(true);
    const index = current === null ? -1 : now.rows.indexOf(current);
    const top = now.rows[0];
    // The query stays. It may hide the current row (a mouse typed it, or a reload kept
    // it), and an author's feed has no row of its own: the top visible row takes the
    // focus. With no row at all the field does, and Escape there comes to the current
    // row of the whole list, or to its top in an author's feed (М1).
    if (current !== null && index !== -1) {
      setFocus({ rowKey: current, index, from: surface });
    } else if (top !== undefined) {
      setFocus({ rowKey: top, index: 0, from: surface });
    } else {
      rememberedRowRef.current = { rowKey: current ?? SIDEBAR_ALL_ROW_KEY, index: 0, scrollTop: null };
      fieldOwedFocusRef.current = true;
      setInField(true);
    }
    now.onEnter?.();
  }, [setOpenedForKeyboard]);

  const enter = useCallback((): boolean => {
    const { feedOnScreen: canEnter, cardOpen: overCard } = latestRef.current;
    if (!canEnter || overCard) return false;
    takeFocus("feed");
    return true;
  }, [takeFocus]);

  const endVisit = useCallback(() => {
    if (latestRef.current.openedForKeyboard) setOpenedForKeyboard(false);
  }, [setOpenedForKeyboard]);

  const moveWithRoute = useCallback((target: string): boolean => {
    const now = latestRef.current;
    if (now.rowKey === null) return false;
    // From an open card the card goes with the collection it belongs to, and the new
    // feed takes the focus (М9).
    if (now.fromCard) {
      leavingForRouteRef.current = true;
      rememberedRowRef.current = null;
      setFocus(null);
      return true;
    }
    // The route walks the whole list: a row the filter hides leaves the focus where
    // it stands in the list.
    const found = now.rows.indexOf(target);
    const index = found === -1 ? Math.max(0, now.rows.indexOf(now.rowKey)) : found;
    setFocus({ rowKey: target, index, from: now.from ?? "feed" });
    return true;
  }, []);

  // The route the visit last answered. A renamed collection keeps its place: the
  // route that follows its new name goes nowhere (М7).
  const answeredRouteRef = useRef(currentRowKey);

  const followRename = useCallback((fromRowKey: string, toRowKey: string) => {
    if (answeredRouteRef.current === fromRowKey) answeredRouteRef.current = toRowKey;
    if (rememberedRowRef.current?.rowKey === fromRowKey) {
      rememberedRowRef.current = { ...rememberedRowRef.current, rowKey: toRowKey };
    }
    setFocus((current) => (
      current?.rowKey === fromRowKey ? { ...current, rowKey: toRowKey } : current
    ));
  }, []);

  const openMenu = useCallback(() => {
    const current = latestRef.current.rowKey;
    if (current !== null) openFocusedSidebarRowMenu(current);
  }, []);

  // The page takes the focus back: the open card it came from, at its root with no
  // caret, or a card of the feed. False when the feed has no card to take it. The
  // graph has no focus of its own: nothing is focused after it.
  const giveBack = useCallback((): boolean => {
    const { fromCard: came, cardOpen: overCard, from: surface } = latestRef.current;
    if (came && overCard) {
      focusOpenCardRoot();
      return true;
    }
    if (surface === "graph") return true;
    return feedRef.current?.take() ?? false;
  }, []);

  // ArrowRight goes back to the current collection from any row, opening nothing and
  // closing nothing (М4). It is the return to the initial state in one press, as
  // Escape's two steps together: the query goes and the list stands whole, where it
  // stood. A feed with no card leaves the focus here, and the query with it.
  const go = useCallback(() => {
    const {
      rowKey: current,
      currentRowKey: routeRow,
      filterQuery: query,
      setFilterQuery: setQuery,
    } = latestRef.current;
    if (current === null || !giveBack()) return;
    const remembered = rememberedRowRef.current;
    rememberedRowRef.current = null;
    if (query.length > 0 || remembered !== null) {
      setQuery("");
      rowToShowRef.current = {
        rowKey: remembered?.rowKey ?? routeRow ?? current,
        scrollTop: remembered?.scrollTop ?? null,
      };
    }
    setFocus(null);
    endVisit();
  }, [endVisit, giveBack]);

  // Enter, the row's main action, and the focus stays (М3): over an open card the
  // card's connection toggles; in the feed the row opens by the path of a click.
  const open = useCallback(() => {
    const { rowKey: current, fromCard: came, cardOpen: overCard } = latestRef.current;
    if (current === null) return;
    if (came && overCard) toggleFocusedSidebarRowConnection(current);
    else openFocusedSidebarRow(current);
  }, []);

  /** The focus ends with nothing focused; the sidebar stays where it is. The card
   *  it came from keeps the DOM focus it had. */
  const endFocus = useCallback(() => {
    if (latestRef.current.from === "feed") feedRef.current?.release();
    rememberedRowRef.current = null;
    setInField(false);
    setFocus(null);
  }, []);

  // Escape with the filter on: the query goes, the list is whole again and stands where
  // it stood, and the focus is on the remembered row; with none remembered, on the row
  // it is on. It stays in the menu, and the next Escape leaves.
  const clearFilter = useCallback(() => {
    const {
      rows: list,
      rowKey: current,
      cardOpen: overCard,
      feedOnScreen: feedThere,
      setFilterQuery: setQuery,
    } = latestRef.current;
    const remembered = rememberedRowRef.current;
    rememberedRowRef.current = null;
    setQuery("");
    setInField(false);
    if (remembered !== null) {
      setFocus({
        rowKey: remembered.rowKey,
        index: remembered.index,
        from: surfaceOnScreen(overCard, feedThere),
      });
      rowToShowRef.current = { rowKey: remembered.rowKey, scrollTop: remembered.scrollTop };
    } else if (current !== null) {
      // What the filter showed in its place is the row the focus is on now.
      setFocus((held) => (held === null ? null : { ...held, rowKey: current, index: list.indexOf(current) }));
      rowToShowRef.current = { rowKey: current, scrollTop: null };
    }
  }, []);

  // Escape: a query goes first. Then, over the card it came from, the card's root takes
  // the focus, and the next Escape closes the card (М9); elsewhere nothing is focused.
  const unfocus = useCallback(() => {
    const { fromCard: came, cardOpen: overCard, filterQuery: query } = latestRef.current;
    if (query.length > 0) {
      clearFilter();
      return;
    }
    if (came && overCard) focusOpenCardRoot();
    endFocus();
    endVisit();
  }, [clearFilter, endFocus, endVisit]);

  const blurField = useCallback(() => {
    leavingFieldRef.current = true;
    latestRef.current.filterFieldRef.current?.blur();
    leavingFieldRef.current = false;
  }, []);

  // The one way the caret reaches the field while a row holds the focus: a typed
  // character, ArrowUp from the top row, ⇧⌘F. The first of them remembers the row.
  const fieldFocused = useCallback(() => {
    const { rows: list, rowKey: current } = latestRef.current;
    if (current === null) return;
    rememberedRowRef.current ??= {
      rowKey: current,
      index: Math.max(0, list.indexOf(current)),
      scrollTop: sidebarListScrollTop(current),
    };
    setFocus(null);
    setInField(true);
  }, []);

  // The user left the field, by a click or Tab: the query stays, and the row is
  // forgotten. Another window takes the keyboard for a while and leaves the field the
  // active element. A sidebar going away is the state's to answer (below).
  const fieldBlurred = useCallback((event: { target: EventTarget }) => {
    const { inField: there, sidebarShown: shown } = latestRef.current;
    if (leavingFieldRef.current || !there || !shown) return;
    if (document.activeElement === event.target) return;
    endFocus();
  }, [endFocus]);

  const fieldDown = useCallback(() => {
    const { rows: list, cardOpen: overCard, feedOnScreen: feedThere, onEnter: entered } = latestRef.current;
    const top = list[0];
    if (top === undefined) return;
    setInField(false);
    setFocus({ rowKey: top, index: 0, from: surfaceOnScreen(overCard, feedThere) });
    entered?.();
    blurField();
  }, [blurField]);

  const fieldEscape = useCallback((): boolean => {
    if (!latestRef.current.inField) return false;
    clearFilter();
    blurField();
    return true;
  }, [blurField, clearFilter]);

  // The walk stops at the ends of the list (М2). Over a query, the top row's way up
  // is the field, with the caret after the text.
  const walk = useCallback((direction: 1 | -1) => {
    const { rows: list, rowKey: current, filterQuery: query, filterFieldRef: field } = latestRef.current;
    if (current === null) return;
    const next = walkedRow(list, current, direction);
    if (next === null) {
      if (direction === -1 && query.length > 0) {
        field.current?.focus({ preventScroll: true });
        field.current?.setSelectionRange(query.length, query.length);
      }
      return;
    }
    setFocus((held) => (held === null ? null : { ...held, ...next }));
    showFocusedSidebarRow(next.rowKey);
  }, []);

  // ⌘⇧↑↓: the row moves, and the focus stays on it (М11).
  const moveFocusedRow = useCallback((direction: 1 | -1) => {
    const { rowKey: current, moveRow: move } = latestRef.current;
    if (current === null || !move(current, direction)) return;
    setFocus((held) => (held === null ? null : { ...held, index: held.index + direction }));
    rowToShowRef.current = { rowKey: current, scrollTop: null, moved: true };
  }, []);

  // A character or Backspace on a row edits the query from the field, where the
  // focus goes with it: the same way the collection picker takes a typed character.
  const editFilter = useCallback((query: string) => {
    const { setFilterQuery: setQuery, filterFieldRef: field } = latestRef.current;
    setQuery(query);
    field.current?.focus({ preventScroll: true });
  }, []);

  // The list left the screen, by any of its paths (the native menu, a swipe, a
  // narrower window, another tab's panel), or the surface the focus came from did
  // (Tab between the feed and the graph): none of them is an event here, so the focus
  // follows the state. Tab ends it with nothing focused, either way. A focus from the
  // feed or the graph ends as a card opens over it by other means; one from a card, as
  // that card goes. In the field the rows may be none at all: only the field has to
  // stay on the page.
  const held = focus !== null;
  const surfaceHolds = focus?.from === surfaceOnScreen(cardOpen, feedOnScreen);
  const canHold = inField ? sidebarShown : sidebarShown && surfaceHolds && rowKey !== null;
  useEffect(() => {
    if ((!held && !inField) || canHold) return;
    giveBack();
    rememberedRowRef.current = null;
    fieldOwedFocusRef.current = false;
    setInField(false);
    setFocus(null);
    endVisit();
  }, [canHold, endVisit, giveBack, held, inField]);

  // ArrowLeft in an open card, the keyboard not in text (М9), or on the graph, which
  // has no keys of its own: the feed reports its left edge itself. In the capture phase,
  // before the card hears it; a field and the editor keep it as a caret's.
  const pageSurface = surfaceOnScreen(cardOpen, feedOnScreen);
  useEffect(() => {
    if (pageSurface === "feed" || held || inField) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !commandById("element-to-sidebar").matches?.(event)) return;
      if (!arrowGoesToSidebar(event.target)) return;
      takeFocus(pageSurface);
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [held, inField, pageSurface, takeFocus]);

  // Shows the row the focus landed on, once the list that holds it is on the page:
  // the sidebar over the feed mounts in this very commit.
  useLayoutEffect(() => {
    const current = latestRef.current.rowKey;
    if (held && current !== null) showFocusedSidebarRow(current);
  }, [held]);

  // The way back after Escape or ArrowRight: this commit holds the whole list
  // (SPEC_KEYBOARD.md, «Ввод текста в меню»), or after ⌘⇧↑↓ the row in its new place
  // (М11). A sidebar gone with it has nothing to scroll.
  useLayoutEffect(() => {
    const back = rowToShowRef.current;
    if (back === null) return;
    rowToShowRef.current = null;
    const target = latestRef.current.rowKey ?? back.rowKey;
    if (back.moved) settleMovedRowMarks(target);
    if (back.scrollTop !== null) restoreSidebarListScroll(target, back.scrollTop);
    showFocusedSidebarRow(target);
  });

  // The field owed the focus, with the caret after the text (М1).
  useLayoutEffect(() => {
    const field = latestRef.current.filterFieldRef.current;
    if (!fieldOwedFocusRef.current || !field) return;
    fieldOwedFocusRef.current = false;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  });

  // Whatever hid the sidebar, nothing is left to hide after.
  useEffect(() => {
    if (openedForKeyboard && !sidebarShown) setOpenedForKeyboard(false);
  }, [openedForKeyboard, setOpenedForKeyboard, sidebarShown]);

  // A route change with the focus still on a row or in the field leaves it there, the
  // sidebar too: Enter, ⌘⌥↑↓, a history step (М8). With the focus gone it ends the
  // visit: ⌘⌥↑↓ from an open card, whose new feed takes the focus (М9), or a click
  // after the pointer took over. The route is not an event here: they reach it by the
  // router alone. The row to come back to is the route's now (М3).
  useEffect(() => {
    if (answeredRouteRef.current === currentRowKey) return;
    answeredRouteRef.current = currentRowKey;
    feedOwedFocusRef.current = false;
    const {
      openedForKeyboard: visiting,
      rowKey: holding,
      feedOnScreen: feedThere,
      inField: typing,
      rows: list,
    } = latestRef.current;
    const leaving = leavingForRouteRef.current;
    leavingForRouteRef.current = false;
    if (rememberedRowRef.current !== null && currentRowKey !== null) {
      rememberedRowRef.current = {
        rowKey: currentRowKey,
        index: Math.max(0, list.indexOf(currentRowKey)),
        scrollTop: null,
      };
    }
    if (holding !== null || typing) return;
    if (visiting) setOpenedForKeyboard(false);
    if (leaving) feedOwedFocusRef.current = feedThere && !feedRef.current?.take();
  }, [currentRowKey, setOpenedForKeyboard]);

  // The keys, in the capture phase as the feed's: nothing under them hears a key
  // this mode took. A field, a dialog or an open menu keeps its own.
  useEffect(() => {
    if (!held) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const claim = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (commandById("sidebar-menu").matches?.(event)) {
        // ⌘K stays this mode's inside the row's own menu and over an open card; only
        // a field or a dialog keeps the chord.
        if (isEditableKeyboardTarget(event.target) || (!isMenuOpen() && keyBelongsElsewhere(event.target))) return;
        claim();
        // ⌘K inside the row's menu closes it again, as on a card (М7).
        if (!closeOpenMenu()) openMenu();
        return;
      }
      if (isMenuOpen() || keyBelongsElsewhere(event.target)) return;
      const movesUp = commandById("sidebar-move-up").matches?.(event) ?? false;
      if (movesUp || commandById("sidebar-move-down").matches?.(event)) {
        claim();
        moveFocusedRow(movesUp ? -1 : 1);
        return;
      }
      const bare = !event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey;
      const { filterQuery: query } = latestRef.current;
      if (bare && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        claim();
        walk(event.key === "ArrowDown" ? 1 : -1);
      } else if (bare && commandById("sidebar-open").matches?.(event)) {
        claim();
        // One press is one action: a held key must not toggle the connection on and off.
        if (!event.repeat) open();
      } else if (bare && commandById("sidebar-go").matches?.(event)) {
        claim();
        go();
      } else if (bare && commandById("sidebar-unfocus").matches?.(event)) {
        claim();
        unfocus();
      } else if (bare && event.key === "Backspace") {
        claim();
        if (query.length > 0) editFilter(Array.from(query).slice(0, -1).join(""));
      } else if (isPrintableKeyboardKey(event)) {
        claim();
        // The filter drops a leading space, which would open a field that looks empty.
        if (event.key !== " " || query.length > 0) editFilter(`${query}${event.key}`);
      }
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [editFilter, go, held, moveFocusedRow, open, openMenu, unfocus, walk]);

  // The pointer ends the mode as it ends the feed's, and the sidebar stays: the
  // pointer is on its way to it (М8). A report at the same point, or with no
  // movement, is the content moving under a still pointer (WebKit repeats it after
  // a scroll), not the pointer.
  useEffect(() => {
    if (!held) return undefined;
    let still: { x: number; y: number } | null = null;
    const handleMove = (event: PointerEvent) => {
      if (isMenuOpen() || isOnBottomBar(event.target)) return;
      if (still !== null) {
        if (still.x === event.clientX && still.y === event.clientY) return;
      } else if (event.movementX === 0 && event.movementY === 0) {
        still = { x: event.clientX, y: event.clientY };
        return;
      }
      endFocus();
    };
    const handleDown = (event: PointerEvent) => {
      if (!isMenuOpen() && !isOnBottomBar(event.target)) endFocus();
    };
    window.addEventListener("pointermove", handleMove, true);
    window.addEventListener("pointerdown", handleDown, true);
    return () => {
      window.removeEventListener("pointermove", handleMove, true);
      window.removeEventListener("pointerdown", handleDown, true);
    };
  }, [endFocus, held]);

  const overCard = rowKey !== null && fromCard && cardOpen;
  return useMemo(() => ({
    rowKey,
    overCard,
    enter,
    moveWithRoute,
    followRename,
    reportFeed,
    open,
    openMenu,
    go,
    unfocus,
    fieldFocused,
    fieldBlurred,
    fieldDown,
    fieldEscape,
  }), [
    enter,
    fieldBlurred,
    fieldDown,
    fieldEscape,
    fieldFocused,
    followRename,
    go,
    moveWithRoute,
    open,
    openMenu,
    overCard,
    reportFeed,
    rowKey,
    unfocus,
  ]);
}
