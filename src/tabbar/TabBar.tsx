// The tab bar of one window (SPEC_TABS.md, В43 по В50, В55, В56, В60 по В64, В81).
//
// A row of its own above the tab's chrome: the traffic-light reserve, the
// window's sidebar button, back and forward through the visible tab's places,
// the tabs, `+` after the last tab, and the rest of the row to drag the window
// by. The backend owns every decision about tabs
// and windows; this page shows the state it sends and hands each gesture back
// as a command. Outside the tabs a press drags the window with the chrome's
// threshold gesture, which asks the backend to start the drag (В23).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { ChevronLeft, ChevronRight, Plus, Search, X } from "lucide-react";
import { ChromeActions, ChromeRow } from "@/components/ChromeRow";
import { MineLogo } from "@/components/MineLogo";
import { SidebarToggleButton } from "@/components/SidebarToggleButton";
import { Button } from "@/components/ui/button";
import { FadeText } from "@/components/ui/fade-text";
import { useChromeDragGesture } from "@/hooks/useChromeDragGesture";
import {
  activateAdjacentTab,
  activateTab,
  beginTabDrag,
  closeOtherTabs,
  closeTab,
  closeTabsBeside,
  moveTab,
  moveTabToNewWindow,
  newTab,
  openSettingsWindow,
  openTabSearch,
  reportDropSlot,
  stepTabHistory,
  toggleWindowSidebar,
} from "@/lib/commands";
import { cn } from "@/lib/utils";
import type { DropHover, TabBarState, TabBarTab, TabId } from "@/types";
import { DROP_MARKER_WIDTH_PX, TRAFFIC_LIGHT_RESERVE_PX } from "./constants";
import {
  draggedOffset,
  dropMarkerLeft,
  dropSlot,
  grabPoint,
  moveItem,
  neighbourShift,
  pastDragThreshold,
  pulledOffBar,
  reorderTarget,
  tabCentres,
} from "./tabDrag";
import { adjacentTabDirection } from "@/lib/adjacentTab";
import { focusAfterClose, tabKeyAction } from "./tabKeyboard";
import { tabLabel, tabTitle } from "./tabLabel";
import {
  effectiveTabWidth,
  hiddenEdges,
  revealScrollLeft,
  stripFadeMaskStyle,
  wheelScrollLeft,
  type FrozenTabWidth,
} from "./tabLayout";
import { createSettingsMenu, type SettingsMenu } from "./settingsMenu";
import {
  adoptWindowButtonStyleSet,
  chooseWindowButtonStyle,
  sendWindowButtonStyle,
  shownButtonStyle,
  WINDOW_BUTTON_STYLE_SET_EVENT,
  type WindowButtonStyleSetPayload,
} from "@/lib/buttonStyle";
import { createTabMenu, type TabMenu } from "./tabMenu";
import { listenHere } from "./useTabBarState";
import { logTabBarFailure, type TabBarAction } from "@/lib/tabBarFailure";
import { roleEasing, roleMs } from "@/lib/motion";

/** How neighbours make room for a dragged tab: Перемещение (SPEC_MOTION_LEVELS.md,
 *  РД1, Т3). They answer a drag in hand, so they move the same in every mode
 *  («Режимы»); the time is asked of motion.ts, which a mode's tokens do not
 *  reach. */
const TAB_SHIFT_TRANSITION = `transform ${roleMs("move", "enter", { answers: true })}ms ${roleEasing("move")}`;

/** How the row opens and closes the gap for cards held over it (В86): the
 *  same Перемещение as a dragged tab's neighbours (В60), an answer to the
 *  drag in hand, so the same in every mode (SPEC_MOTION_LEVELS.md, Р1, Т4).
 *  The neighbours move aside, and the strip, with `+` after it, grows by the
 *  gap; when the tabs share the room, their widths follow on the same curve. */
const CARD_GAP_MS = roleMs("move", "enter", { answers: true });
const CARD_GAP_TAB_TRANSITION = `transform ${CARD_GAP_MS}ms ${roleEasing("move")}, width ${CARD_GAP_MS}ms ${roleEasing("move")}`;
const CARD_GAP_STRIP_TRANSITION = `width ${CARD_GAP_MS}ms ${roleEasing("move")}`;

export const NEW_TAB_LABEL = "New Tab";
export const CLOSE_TAB_BUTTON_LABEL = "Close Tab";
export const TAB_LIST_LABEL = "Tabs";
export const BACK_LABEL = "Back";
export const FORWARD_LABEL = "Forward";
export const SETTINGS_MENU_LABEL = "Mine settings";
export const SEARCH_LABEL = "Find elements";

/** The traffic lights' reserve (В83). */
const TRAFFIC_LIGHT_RESERVE_STYLE = { width: TRAFFIC_LIGHT_RESERVE_PX };

const PRIMARY_BUTTON = 0;
const MIDDLE_BUTTON = 1;

/// `action` of the bar failed: the log has it, the screen does not
/// (SPEC_DEEP_AUDIT.md, «Решения пользователя 14.10.2026»).
function tellFailure(action: TabBarAction, error: unknown): void {
  logTabBarFailure(action, error);
}

/// Run a command for its effect. A failure undoes what the bar showed at once
/// (`undo`) and goes to the log.
function run(command: Promise<unknown>, action: TabBarAction, undo?: () => void): void {
  command.catch((error: unknown) => {
    undo?.();
    tellFailure(action, error);
  });
}

/** A press on a tab that may become a drag. */
interface TabPress {
  pointerId: number;
  startX: number;
  startY: number;
  tabId: TabId;
  fromIndex: number;
  width: number;
  count: number;
  /** Where the backend keeps the pointer in a window that carries the tab. */
  grab: { x: number; y: number };
  started: boolean;
}

/** The tab following the pointer along the row. */
interface Reorder {
  tabId: TabId;
  fromIndex: number;
  offset: number;
}

/** Where a tab or the placeholder stands on screen: from the strip's start. */
interface Placed {
  left: number;
  width: number;
}

/** The row as it stood in the last frame (В87). */
interface RowGeometry {
  ids: Set<TabId>;
  tabs: Map<TabId, Placed>;
  placeholder: Placed | null;
  strip: number;
}

/** A group of cards landing: each tab that stood in the row moves from
 *  `dx` off its new place and its old width; `running` once the end places
 *  are set. */
interface LandingMove {
  from: Map<TabId, { dx: number; width: number }>;
  strip: number;
  running: boolean;
}

/** The order a drop just made, shown until the backend's next state. */
interface LocalOrder {
  source: readonly TabBarTab[];
  ids: TabId[];
}

function orderedTabs(source: TabBarTab[], local: LocalOrder | null): TabBarTab[] {
  if (local === null || local.source !== source) return source;
  const byId = new Map(source.map((tab) => [tab.id, tab]));
  const ordered = local.ids.flatMap((id) => byId.get(id) ?? []);
  return ordered.length === source.length ? ordered : source;
}

interface TabBarProps {
  bar: TabBarState;
  /** A tab from another window held over this bar (В63), or cards dragged in
   *  this window's visible tab (В86). */
  dropHover: DropHover | null;
  /** Cards let go over this bar at their `x`, until the backend says the
   *  drop is over (В86): the bar answers with the slot there once, and the
   *  cards' tabs come with the next state, where the placeholder stood. */
  landing?: DropHover | null;
}

/** The tab bar row with the window's tabs. */
export function TabBar({ bar, dropHover, landing = null }: TabBarProps) {
  const { tabs: sourceTabs, active_tab: activeTab, sidebar_shown: sidebarShown, fullscreen } = bar;
  const [localOrder, setLocalOrder] = useState<LocalOrder | null>(null);
  const tabs = useMemo(() => orderedTabs(sourceTabs, localOrder), [sourceTabs, localOrder]);
  const count = tabs.length;
  const activeIndex = tabs.findIndex((tab) => tab.id === activeTab);
  const history = tabs[activeIndex]?.history ?? { back: false, forward: false };
  // In full screen there are no traffic lights: their place goes back to the
  // row.
  const trafficLightReserve = !fullscreen;

  const zoneRef = useRef<HTMLDivElement>(null);
  const plusSlotRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const tabNodes = useRef(new Map<TabId, HTMLElement>());

  // ── Cards held over the bar (В86) ────────────────────────────────────────
  // The row makes room for one more tab, a placeholder with the held card's
  // title, at the slot under the pointer.
  const cardGap = dropHover !== null && dropHover.item.kind === "cards" && dropHover.x !== null
    ? { x: dropHover.x, title: dropHover.item.title }
    : null;
  const layoutCount = count + (cardGap === null ? 0 : 1);

  // ── Widths (В48) ───────────────────────────────────────────────────────
  const [available, setAvailable] = useState(0);
  const [frozen, setFrozen] = useState<FrozenTabWidth | null>(null);
  const width = effectiveTabWidth(available, layoutCount, frozen);
  const stripWidth = Math.min(layoutCount * width, available);

  useLayoutEffect(() => {
    const zone = zoneRef.current;
    const plusSlot = plusSlotRef.current;
    if (!zone || !plusSlot) return;
    const measure = () => setAvailable(Math.max(0, zone.clientWidth - plusSlot.offsetWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(zone);
    return () => observer.disconnect();
  }, []);

  // ── Scrolling: the visible tab stays in view, hidden edges dissolve ─────
  const [edges, setEdges] = useState({ left: false, right: false });
  const syncEdges = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const next = hiddenEdges(strip.scrollLeft, stripWidth, layoutCount * width);
    setEdges((current) => (current.left === next.left && current.right === next.right ? current : next));
  }, [layoutCount, stripWidth, width]);

  // While cards are held over the bar the strip stays where the pointer has
  // it, scrolled by hand to reach a slot (В86).
  const holdScroll = dropHover !== null && dropHover.item.kind === "cards";
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    if (activeIndex >= 0 && !holdScroll) {
      const next = revealScrollLeft({
        index: activeIndex,
        count,
        width,
        viewport: stripWidth,
        scrollLeft: strip.scrollLeft,
      });
      if (next !== strip.scrollLeft) strip.scrollLeft = next;
    }
    syncEdges();
  }, [activeIndex, count, holdScroll, stripWidth, syncEdges, width]);

  // Over the strip WebKit scrolls it; over the rest of the bar the horizontal
  // turn is passed to it, so the whole bar scrolls the tabs (SPEC_NARROW_WINDOW.md,
  // У9, У11). The backend leaves the sidebar alone for such a gesture.
  const handleBarWheel = useCallback(
    (event: ReactWheelEvent<HTMLElement>) => {
      const strip = stripRef.current;
      if (!strip || (event.target instanceof Node && strip.contains(event.target))) return;
      const next = wheelScrollLeft({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        scrollLeft: strip.scrollLeft,
        viewport: stripWidth,
        content: layoutCount * width,
      });
      if (next === null || next === strip.scrollLeft) return;
      strip.scrollLeft = next;
      syncEdges();
    },
    [layoutCount, stripWidth, syncEdges, width],
  );

  // ── Dev button styles (src/lib/buttonStyle.ts) ───────────────────────────
  // The bar owns its window's button style: each tab page gets it whenever
  // the tabs change (a new tab, a tab dragged in), and a step made in one
  // page (⌃⌥B) is stored here and spread to the others.
  const latestWindow = useRef({ windowId: bar.window_id, tabs: sourceTabs, activeTab });
  useLayoutEffect(() => {
    latestWindow.current = { windowId: bar.window_id, tabs: sourceTabs, activeTab };
  });
  const tabIdsKey = sourceTabs.map((tab) => tab.id).join(" ");
  useEffect(() => {
    // Sent when the window's tabs change, not when the visible one does.
    const { activeTab: active } = latestWindow.current;
    sendWindowButtonStyle(bar.window_id, shownButtonStyle(), tabIdsKey.split(" ").filter(Boolean), active, false);
  }, [bar.window_id, tabIdsKey]);
  useEffect(
    () =>
      listenHere<WindowButtonStyleSetPayload>(WINDOW_BUTTON_STYLE_SET_EVENT, (payload) => {
        const { windowId, tabs: current, activeTab: active } = latestWindow.current;
        if (payload.window !== windowId) return;
        adoptWindowButtonStyleSet(windowId, payload.style, current.map((tab) => tab.id), active);
      }),
    [],
  );

  // ── What the handlers below read at the moment they run ──────────────────
  const latest = useRef({ tabs, sourceTabs, fullscreen, width });
  useLayoutEffect(() => {
    latest.current = { tabs, sourceTabs, fullscreen, width };
  });

  // ── Closing (В48, В53) ─────────────────────────────────────────────────
  /** A close by the pointer holds the widths: the next tab's close button
   *  lands under the pointer. The hold ends when the pointer leaves the bar. */
  const closeByPointer = useCallback((tabId: TabId) => {
    const current = latest.current;
    setFrozen({ width: current.width, count: current.tabs.length });
    run(closeTab(tabId), "close the tab");
  }, []);
  /** The tab the middle button went down on. */
  const middlePress = useRef<TabId | null>(null);

  // ── Keyboard (В49, В55) ────────────────────────────────────────────────
  const [focusedId, setFocusedId] = useState<TabId | null>(null);
  const rovingId = focusedId !== null && tabs.some((tab) => tab.id === focusedId)
    ? focusedId
    : activeIndex >= 0
      ? activeTab
      : tabs[0]?.id ?? null;

  const handleStripKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[role='tab']") : null;
    const ids = latest.current.tabs.map((tab) => tab.id);
    const index = ids.findIndex((id) => id === target?.dataset.tabId);
    const tabId = ids[index];
    if (tabId === undefined) return;
    const action = tabKeyAction(event.key, index, ids.length);
    if (action === null) return;
    event.preventDefault();
    if (action.kind === "focus") {
      const next = ids[action.index] ?? tabId;
      setFocusedId(next);
      tabNodes.current.get(next)?.focus();
    } else if (action.kind === "activate") {
      run(activateTab(tabId), "show the tab");
    } else {
      // Focus moves on before the tab goes, so the bar keeps it.
      const after = focusAfterClose(index, ids.length);
      const nextId = after === null ? null : ids[after] ?? null;
      setFocusedId(nextId);
      if (nextId !== null) tabNodes.current.get(nextId)?.focus();
      run(closeTab(tabId), "close the tab");
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const direction = adjacentTabDirection(event);
      if (direction === null) return;
      event.preventDefault();
      run(activateAdjacentTab(direction === "forward"), "switch tabs");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ── Context menu (В50) ─────────────────────────────────────────────────
  const menu = useRef<Promise<TabMenu> | null>(null);
  const openMenu = useCallback((tabId: TabId) => {
    menu.current ??= createTabMenu({
      moveToNewWindow: (id) => run(moveTabToNewWindow(id), "move the tab to a new window"),
      close: (id) => run(closeTab(id), "close the tab"),
      closeOthers: (id) => run(closeOtherTabs(id), "close the other tabs"),
      closeToTheLeft: (id) => run(closeTabsBeside(id, "left"), "close the tabs to the left"),
      closeToTheRight: (id) => run(closeTabsBeside(id, "right"), "close the tabs to the right"),
    });
    const pending = menu.current;
    const shown = latest.current.tabs;
    const index = shown.findIndex((tab) => tab.id === tabId);
    pending
      .then((built) => built.open(tabId, index, shown.length))
      .catch((error: unknown) => {
        // A menu that failed to build is built again on the next right click.
        if (menu.current === pending) menu.current = null;
        tellFailure("show the tab menu", error);
      });
  }, []);

  // ── The logo's settings menu (В43) ────────────────────────────────────────
  const settingsMenu = useRef<Promise<SettingsMenu> | null>(null);
  const openSettingsMenu = useCallback((button: HTMLElement) => {
    settingsMenu.current ??= createSettingsMenu({
      openSection: (section) => run(openSettingsWindow(section), "open Settings"),
      // Dev button styles: this window only; its visible tab says what
      // is on.
      chooseButtonStyle: (style) => {
        const { windowId, tabs: current, activeTab: active } = latestWindow.current;
        chooseWindowButtonStyle(windowId, style, current.map((tab) => tab.id), active);
      },
    });
    const pending = settingsMenu.current;
    const { left, bottom } = button.getBoundingClientRect();
    pending
      .then((built) => built.open({ x: left, y: bottom }))
      .catch((error: unknown) => {
        if (settingsMenu.current === pending) settingsMenu.current = null;
        tellFailure("show the settings menu", error);
      });
  }, []);

  // ── Dragging: tabs reorder or tear off, the rest drags the window ────────
  const windowDrag = useChromeDragGesture();
  const [reorder, setReorder] = useState<Reorder | null>(null);
  const press = useRef<TabPress | null>(null);
  const releasePress = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);

  const endPress = useCallback(() => {
    releasePress.current?.();
    releasePress.current = null;
    press.current = null;
  }, []);

  useEffect(() => endPress, [endPress]);

  /** Hand the tab to the backend, which carries it from here on (В61, В62). */
  const tearOff = useCallback((pressed: TabPress) => {
    endPress();
    setReorder(null);
    run(beginTabDrag(pressed.tabId, pressed.grab.x, pressed.grab.y), "move the tab to a new window");
  }, [endPress]);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    const pressed = press.current;
    if (!pressed || pressed.pointerId !== event.pointerId) return;
    const dx = event.clientX - pressed.startX;
    const dy = event.clientY - pressed.startY;

    if (!pressed.started) {
      if (!pastDragThreshold(dx, dy)) return;
      pressed.started = true;
      suppressClick.current = true;
      if (pressed.count < 2) {
        // The only tab carries its window along; a full-screen window
        // stays where it is.
        if (latest.current.fullscreen) endPress();
        else tearOff(pressed);
        return;
      }
    }

    if (pulledOffBar({ clientX: event.clientX, clientY: event.clientY, windowWidth: window.innerWidth })) {
      tearOff(pressed);
      return;
    }
    setReorder({
      tabId: pressed.tabId,
      fromIndex: pressed.fromIndex,
      offset: draggedOffset({ fromIndex: pressed.fromIndex, dx, width: pressed.width, count: pressed.count }),
    });
  }, [endPress, tearOff]);

  const handlePointerUp = useCallback((event: PointerEvent) => {
    const pressed = press.current;
    if (!pressed || pressed.pointerId !== event.pointerId) return;
    endPress();
    if (!pressed.started) return;
    setReorder(null);
    const offset = draggedOffset({
      fromIndex: pressed.fromIndex,
      dx: event.clientX - pressed.startX,
      width: pressed.width,
      count: pressed.count,
    });
    const target = reorderTarget({ fromIndex: pressed.fromIndex, offset, width: pressed.width, count: pressed.count });
    if (target === pressed.fromIndex) return;
    const current = latest.current;
    // The new order shows at once; the backend's next state confirms it. A
    // move the backend refused puts the tabs back (Е6.10).
    const shown = {
      source: current.sourceTabs,
      ids: moveItem(current.tabs.map((tab) => tab.id), pressed.fromIndex, target),
    };
    setLocalOrder(shown);
    run(moveTab(pressed.tabId, target), "move the tab", () => {
      setLocalOrder((order) => (order === shown ? null : order));
    });
  }, [endPress]);

  const cancelPress = useCallback(() => {
    endPress();
    setReorder(null);
  }, [endPress]);

  const handlePointerCancel = useCallback((event: PointerEvent) => {
    if (press.current?.pointerId === event.pointerId) cancelPress();
  }, [cancelPress]);

  /** Escape puts the dragged tab back where it was (В60). */
  const handlePressKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key !== "Escape" || !press.current?.started) return;
    event.preventDefault();
    cancelPress();
  }, [cancelPress]);

  const handleStripPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    suppressClick.current = false;
    if (event.button !== PRIMARY_BUTTON || press.current !== null) return;
    const tabNode = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[role='tab']")
      : null;
    const current = latest.current;
    const fromIndex = current.tabs.findIndex((tab) => tab.id === tabNode?.dataset.tabId);
    const pressed = current.tabs[fromIndex];
    if (pressed === undefined) return;
    const strip = stripRef.current;
    press.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      tabId: pressed.id,
      fromIndex,
      width: current.width,
      count: current.tabs.length,
      grab: grabPoint({
        pressX: event.clientX,
        pressY: event.clientY,
        stripLeft: strip?.getBoundingClientRect().left ?? 0,
        scrollLeft: strip?.scrollLeft ?? 0,
        fromIndex,
        width: current.width,
      }),
      started: false,
    };
    // The bar's page keeps receiving the pointer while the button is down,
    // also below the bar and outside the window: that is how a pull past the
    // threshold is seen.
    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("pointercancel", handlePointerCancel, true);
    window.addEventListener("keydown", handlePressKeyDown, true);
    releasePress.current = () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("pointercancel", handlePointerCancel, true);
      window.removeEventListener("keydown", handlePressKeyDown, true);
    };
  }, [handlePressKeyDown, handlePointerCancel, handlePointerMove, handlePointerUp]);

  /** A press that became a drag is not also a click. */
  const handleStripClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  // ── A tab from another window over this bar (В63) ─────────────────────────
  // The backend attaches the tab at the slot reported last, so every change
  // is reported, the pointer leaving the bar too.
  /** The slot of the bar's tabs as they stand, without a gap, for the
   *  pointer at bar position `x`: before a tab over its left half, after it
   *  over its right half, at the end over `+` and past the last tab. */
  const slotAt = useCallback((x: number): number | null => {
    const strip = stripRef.current;
    if (strip === null) return null;
    return dropSlot(
      x,
      tabCentres({
        stripLeft: strip.getBoundingClientRect().left,
        scrollLeft: strip.scrollLeft,
        width,
        count,
      }),
    );
  }, [count, width]);

  const [incomingSlot, setIncomingSlot] = useState<number | null>(null);
  useLayoutEffect(() => {
    const x = dropHover !== null && dropHover.item.kind === "tab" ? dropHover.x : null;
    setIncomingSlot(x === null ? null : slotAt(x));
  }, [dropHover, slotAt]);

  const reportedSlot = useRef<number | null>(null);
  useEffect(() => {
    if (incomingSlot === reportedSlot.current) return;
    reportedSlot.current = incomingSlot;
    run(reportDropSlot(incomingSlot), "move the tab");
  }, [incomingSlot]);

  // ── Cards held over the bar (В86) ────────────────────────────────────────
  // The placeholder follows the pointer over the tabs as they stand; the
  // strip scrolls under a held pointer as it does for a tab from another
  // window (В63), and the slot follows the scroll.
  const cardGapX = cardGap?.x ?? null;
  const [cardSlot, setCardSlot] = useState<number | null>(null);
  const placeCardGap = useCallback(() => {
    setCardSlot(cardGapX === null ? null : slotAt(cardGapX));
  }, [cardGapX, slotAt]);
  useLayoutEffect(placeCardGap, [placeCardGap]);
  const handleStripScroll = useCallback(() => {
    syncEdges();
    if (cardGapX !== null) placeCardGap();
  }, [cardGapX, placeCardGap, syncEdges]);

  // Let go over the bar: the slot at the pointer goes back once, read at
  // that moment with the row as it stands.
  const landingSlot = useRef((x: number) => slotAt(x) ?? count);
  useLayoutEffect(() => {
    landingSlot.current = (x: number) => slotAt(x) ?? count;
  });
  useEffect(() => {
    if (landing === null || landing.x === null) return;
    run(reportDropSlot(landingSlot.current(landing.x)), "open the elements in new tabs");
  }, [landing]);

  // The gap closes on the same curve when the cards leave the bar or the
  // drag ends elsewhere. Tabs that landed in it stand at once: the state
  // that brings them ends the gap in the same frame (useTabBarState.ts).
  const cardGapShown = cardGap !== null;
  const landingNow = landing !== null;
  const [cardGapClosing, setCardGapClosing] = useState(false);
  const hadCardGap = useRef(false);
  useLayoutEffect(() => {
    if (cardGapShown) {
      hadCardGap.current = true;
      setCardGapClosing(false);
      return;
    }
    if (!hadCardGap.current) return;
    hadCardGap.current = false;
    if (landingNow) return;
    setCardGapClosing(true);
    const timer = window.setTimeout(() => setCardGapClosing(false), CARD_GAP_MS);
    return () => window.clearTimeout(timer);
    // Only the gap's coming and going matters here, with the landing as it
    // stood at that moment.
  }, [cardGapShown]);

  // ── Rendering ────────────────────────────────────────────────────────────
  const reorderTargetIndex = reorder === null
    ? null
    : reorderTarget({ fromIndex: reorder.fromIndex, offset: reorder.offset, width, count });
  // Neighbours glide aside only while a tab is dragged: after a drop the
  // new order is laid out in place, with nothing to animate. They make room
  // as Перемещение, the same in every mode (В60; SPEC_MOTION_LEVELS.md, Т3).
  // A gap for cards moves on its own curve until the cards land in it.
  const cardGapMoving = (cardGap !== null && landing === null) || cardGapClosing;
  const shiftTransition = reorder !== null
    ? TAB_SHIFT_TRANSITION
    : cardGapMoving ? CARD_GAP_TAB_TRANSITION : undefined;

  function tabShift(index: number, tabId: TabId): { offset: number; follows: boolean } {
    if (reorder === null && cardGap !== null && cardSlot !== null) {
      return { offset: index >= cardSlot ? width : 0, follows: false };
    }
    if (reorder === null || reorderTargetIndex === null) return { offset: 0, follows: false };
    if (tabId === reorder.tabId) return { offset: reorder.offset, follows: true };
    return {
      offset: neighbourShift({ index, fromIndex: reorder.fromIndex, toIndex: reorderTargetIndex, width }),
      follows: false,
    };
  }

  // Where every tab and the placeholder stand on screen now, for the next
  // state to move from (В87).
  const geometry: RowGeometry = {
    ids: new Set(tabs.map((tab) => tab.id)),
    tabs: new Map(tabs.map((tab, index) => [tab.id, { left: index * width + tabShift(index, tab.id).offset, width }])),
    placeholder: cardGap !== null && cardSlot !== null ? { left: cardSlot * width, width } : null,
    strip: stripWidth,
  };

  // ── A group of cards lands (В87) ─────────────────────────────────────────
  // The gap held one tab; the group brings more. The tabs that stood in the
  // row, and the grabbed card's tab from the placeholder, move from where
  // they stood to their new places, widths too, as Перемещение, the same in
  // every mode: the drag in hand goes on (SPEC_MOTION_LEVELS.md, Р1, Т4). The
  // rest of the group stand in their places from the first frame, uncovered
  // as the neighbours move off them. One card lands without moving.
  const shownGeometry = useRef<RowGeometry | null>(null);
  const [landingMove, setLandingMove] = useState<LandingMove | null>(null);
  useLayoutEffect(() => {
    const before = shownGeometry.current;
    if (before === null || landing === null) return;
    const added = tabs.filter((tab) => !before.ids.has(tab.id)).length;
    if (added < 2) return;
    const from = new Map<TabId, { dx: number; width: number }>();
    tabs.forEach((tab, index) => {
      const stood = before.tabs.get(tab.id) ?? (tab.id === activeTab ? before.placeholder : null);
      if (stood !== null && stood !== undefined) from.set(tab.id, { dx: stood.left - index * width, width: stood.width });
    });
    setLandingMove({ from, strip: before.strip, running: false });
    // The state that brings the group's tabs starts the move, with the row
    // as it stood just before.
  }, [sourceTabs]);
  useLayoutEffect(() => {
    shownGeometry.current = landingMove === null ? geometry : shownGeometry.current;
  });
  useLayoutEffect(() => {
    if (landingMove === null) return;
    if (!landingMove.running) {
      // The start places are laid out before the end ones are set, so the
      // row moves from them.
      void stripRef.current?.offsetWidth;
      setLandingMove({ ...landingMove, running: true });
      return;
    }
    const timer = window.setTimeout(() => setLandingMove(null), CARD_GAP_MS);
    return () => window.clearTimeout(timer);
  }, [landingMove]);

  const stripStyle: CSSProperties = {
    width: landingMove !== null && !landingMove.running ? landingMove.strip : stripWidth,
    transition: cardGapMoving || landingMove?.running ? CARD_GAP_STRIP_TRANSITION : undefined,
    ...stripFadeMaskStyle(edges),
  };

  return (
    <ChromeRow
      as="header"
      separator="bottom"
      data-tab-bar=""
      data-fullscreen={fullscreen ? "true" : undefined}
      className="bg-accent"
      onPointerLeave={() => setFrozen(null)}
      onWheel={handleBarWheel}
    >
      {/* The traffic lights sit over this spot. */}
      {trafficLightReserve && (
        <div
          {...windowDrag}
          data-traffic-light-reserve=""
          className="h-full shrink-0"
          style={TRAFFIC_LIGHT_RESERVE_STYLE}
        />
      )}
      <div
        {...windowDrag}
        className={cn(
          // Icon buttons 4px apart; the first tab's line 8px past the last
          // one (DESIGN_SYSTEM.md, «Иконочные кнопки хрома»).
          "flex h-full shrink-0 items-center gap-1 pr-2",
          // Without the reserve the first button stands on the chrome's edge
          // inset, like the last one at the right edge.
          !trafficLightReserve && "pl-[var(--chrome-edge-pad)]",
        )}
      >
        <SidebarToggleButton
          collapsed={!sidebarShown}
          onToggle={() =>
            // The backend decides: beside the feed it stores the sidebar, over
            // the feed the page opens or closes it (SPEC_NARROW_WINDOW.md, У4).
            run(toggleWindowSidebar(), "show or hide the sidebar")}
        />
        {/* Back and forward through the visible tab's places (В81). */}
        <Button
          type="button"
          variant="chrome"
          size="chrome-icon"
          aria-label={BACK_LABEL}
          // The tab bar's page is one row tall: a tooltip would be cut off.
          tooltip={false}
          data-tab-history="back"
          disabled={!history.back}
          onClick={() => run(stepTabHistory(false), "go back")}
        >
          <ChevronLeft />
        </Button>
        <Button
          type="button"
          variant="chrome"
          size="chrome-icon"
          aria-label={FORWARD_LABEL}
          // The tab bar's page is one row tall: a tooltip would be cut off.
          tooltip={false}
          data-tab-history="forward"
          disabled={!history.forward}
          onClick={() => run(stepTabHistory(true), "go forward")}
        >
          <ChevronRight />
        </Button>
      </div>
      <div ref={zoneRef} data-tab-zone="" className="flex h-full min-w-0 flex-1 items-center">
        <div
          ref={stripRef}
          role="tablist"
          aria-label={TAB_LIST_LABEL}
          aria-orientation="horizontal"
          data-tab-strip=""
          data-fade-left={edges.left ? "true" : undefined}
          data-fade-right={edges.right ? "true" : undefined}
          data-reordering={reorder !== null ? "true" : undefined}
          className={cn(
            "relative flex h-full shrink-0 overflow-x-auto overflow-y-hidden",
            reorder !== null && "[&>[role=tab]]:pointer-events-none",
          )}
          style={stripStyle}
          onScroll={handleStripScroll}
          onKeyDown={handleStripKeyDown}
          onPointerDown={handleStripPointerDown}
          onClickCapture={handleStripClickCapture}
        >
          {tabs.map((tab, index) => {
            const active = tab.id === activeTab;
            const label = tabLabel(tab);
            const { offset, follows } = tabShift(index, tab.id);
            const landsFrom = landingMove?.from.get(tab.id);
            const shiftPx = landsFrom !== undefined && !landingMove?.running ? landsFrom.dx : offset;
            return (
              <div
                key={tab.id}
                ref={(node) => {
                  if (node) tabNodes.current.set(tab.id, node);
                  else tabNodes.current.delete(tab.id);
                }}
                role="tab"
                aria-selected={active}
                tabIndex={tab.id === rovingId ? 0 : -1}
                title={tabTitle(tab)}
                data-tab-id={tab.id}
                data-active={active ? "true" : undefined}
                data-dragging={follows ? "true" : undefined}
                // Square tabs the full height of the row, outlined by the
                // row's lines. The visible tab takes the chrome below it, a
                // line still parting them; the others take the row's surface
                // and light up under the pointer with a state layer, which is
                // the surface of the close button on it (В46).
                className={cn(
                  "relative flex h-full flex-none items-center border-r border-border pr-1 pl-3 outline-none",
                  "focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring",
                  index === 0 && "border-l",
                  active
                    ? "bg-chrome text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:state-active",
                  (follows || landsFrom !== undefined) && "z-10",
                  (follows || landsFrom !== undefined) && !active && "bg-accent",
                )}
                style={{
                  width: landsFrom !== undefined && !landingMove?.running ? landsFrom.width : width,
                  transform: shiftPx === 0 ? undefined : `translateX(${shiftPx}px)`,
                  transition: follows
                    ? undefined
                    : landsFrom !== undefined && landingMove?.running ? CARD_GAP_TAB_TRANSITION : shiftTransition,
                }}
                // A click shows the tab and hands it the focus; the bar
                // keeps focus only for keyboard work (В49).
                onMouseDown={(event) => {
                  event.preventDefault();
                  middlePress.current = event.button === MIDDLE_BUTTON ? tab.id : null;
                }}
                // The middle button closes the tab it was pressed and
                // released on (В53).
                onMouseUp={(event) => {
                  if (event.button !== MIDDLE_BUTTON) return;
                  const pressedTab = middlePress.current;
                  middlePress.current = null;
                  if (pressedTab !== tab.id) return;
                  event.preventDefault();
                  closeByPointer(tab.id);
                }}
                onFocus={() => setFocusedId(tab.id)}
                onClick={() => {
                  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                  run(activateTab(tab.id), "show the tab");
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openMenu(tab.id);
                }}
              >
                {/* One line that dissolves at the right edge when it does
                    not fit (В46), by the chrome's shared rule. */}
                <FadeText
                  text={label}
                  data-tab-label=""
                  className="flex-1 font-mono text-sm leading-none"
                />
                {/* Shown on hover only, over the label's dissolved end; a
                    chrome button like the rest of the row (В46), its plate
                    8px from the tab's line, as from any boundary. */}
                <Button
                  type="button"
                  variant="chrome"
                  size="chrome-icon"
                  tabIndex={-1}
                  aria-label={CLOSE_TAB_BUTTON_LABEL}
          // The tab bar's page is one row tall: a tooltip would be cut off.
          tooltip={false}
                  data-tab-close=""
                  className="absolute inset-y-0 right-2"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeByPointer(tab.id);
                  }}
                >
                  <X />
                </Button>
              </div>
            );
          })}
          {cardGap !== null && cardSlot !== null && (
            // The tab the held card becomes, in the room the row made: the
            // look of a tab that is not visible, its title muted (В47, В86).
            <div
              aria-hidden="true"
              data-tab-card-placeholder={cardSlot}
              className={cn(
                "pointer-events-none absolute inset-y-0 left-0 flex items-center border-r border-border pr-1 pl-3 text-muted-foreground",
                cardSlot === 0 && "border-l",
              )}
              // It moves with the neighbours as the slot changes.
              style={{ width, transform: `translateX(${cardSlot * width}px)`, transition: shiftTransition }}
            >
              <FadeText text={cardGap.title} className="flex-1 font-mono text-sm leading-none" />
            </div>
          )}
          {incomingSlot !== null && (
            <div
              aria-hidden="true"
              data-tab-drop-marker={incomingSlot}
              className="pointer-events-none absolute inset-y-0 z-20 bg-foreground"
              style={{
                width: DROP_MARKER_WIDTH_PX,
                left: dropMarkerLeft({ slot: incomingSlot, width, count, markerWidth: DROP_MARKER_WIDTH_PX }),
              }}
            />
          )}
        </div>
        <div
          {...windowDrag}
          ref={plusSlotRef}
          data-tab-bar-new-tab-slot=""
          // 8px from the last tab's line, 4px to the search button after it.
          className="flex h-full shrink-0 items-center pr-1 pl-2"
        >
          <Button
            type="button"
            variant="chrome"
            size="chrome-icon"
            aria-label={NEW_TAB_LABEL}
          // The tab bar's page is one row tall: a tooltip would be cut off.
          tooltip={false}
            onClick={() => run(newTab(), "open a new tab")}
          >
            <Plus />
          </Button>
        </div>
        <div {...windowDrag} data-tab-bar-drag-area="" className="h-full min-w-0 flex-1" />
      </div>
      {/* The logo's settings menu closes the row at the window's right edge,
          as it did in the tab page's chrome (В43). With the tabs filling the
          row it stands right after +, 4 px apart like neighbouring chrome
          buttons: the + slot's own padding. The search button stands just
          before the logo, 4 px apart (user's decision of 07.10.2026). Like
          every slot of the row, the pair and the edge inset after it move the
          window: the inset is padding of the slot, not a margin outside it. */}
      <ChromeActions
        {...windowDrag}
        windowEdge={false}
        className="h-full pr-[var(--chrome-edge-pad)]"
        data-tab-bar-settings=""
      >
        <Button
          type="button"
          variant="chrome"
          size="chrome-icon"
          aria-label={SEARCH_LABEL}
          aria-keyshortcuts="Meta+F"
          // The tab bar's page is one row tall: a tooltip would be cut off.
          tooltip={false}
          data-tab-bar-search=""
          // The window's visible tab opens the cards' search, over an open
          // card too, as the Find menu item and Cmd+F do.
          onClick={() => run(openTabSearch(), "open Find elements")}
        >
          <Search />
        </Button>
        <Button
          type="button"
          variant="chrome"
          size="chrome-icon"
          aria-label={SETTINGS_MENU_LABEL}
          // The tab bar's page is one row tall: a tooltip would be cut off.
          tooltip={false}
          onClick={(event) => openSettingsMenu(event.currentTarget)}
        >
          <MineLogo />
        </Button>
      </ChromeActions>
    </ChromeRow>
  );
}

/** The row before the window's state arrives: the same chrome, no tabs yet. */
export function TabBarPending() {
  const windowDrag = useChromeDragGesture();
  return (
    <ChromeRow as="header" separator="bottom" data-tab-bar="" data-tab-bar-pending="" className="bg-accent">
      <div {...windowDrag} data-traffic-light-reserve="" className="h-full w-20 shrink-0" />
      <div {...windowDrag} data-tab-bar-drag-area="" className="h-full min-w-0 flex-1" />
    </ChromeRow>
  );
}
