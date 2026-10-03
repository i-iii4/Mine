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
} from "react";
import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { ChromeActions, ChromeRow } from "@/components/ChromeRow";
import { MineLogo } from "@/components/MineLogo";
import { SidebarToggleButton } from "@/components/SidebarToggleButton";
import { Button } from "@/components/ui/button";
import { useChromeDragGesture } from "@/hooks/useChromeDragGesture";
import {
  activateAdjacentTab,
  activateTab,
  beginTabDrag,
  closeOtherTabs,
  closeTab,
  moveTab,
  moveTabToNewWindow,
  newTab,
  openSettingsWindow,
  reportDropSlot,
  setChromeRows,
  setWindowSidebar,
  stepTabHistory,
} from "@/lib/commands";
import { motionDuration } from "@/lib/motion";
import { broadcastSettingsChange } from "@/lib/settingsChanged";
import { getUiVersion, storeUiVersion, UI_VERSION_STORAGE_KEY, useUiVersion } from "@/lib/uiVersion";
import { cn } from "@/lib/utils";
import type { DropHover, TabBarState, TabBarTab, TabId } from "@/types";
import { DROP_MARKER_WIDTH_PX, TAB_REORDER_EASING, TAB_REORDER_MOTION_MS } from "./constants";
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
import { tabLabel } from "./tabLabel";
import {
  effectiveTabWidth,
  hiddenEdges,
  revealScrollLeft,
  stripFadeMaskStyle,
  type FrozenTabWidth,
} from "./tabLayout";
import { createSettingsMenu, type SettingsMenu } from "./settingsMenu";
import { createTabMenu, type TabMenu } from "./tabMenu";

export const NEW_TAB_LABEL = "New Tab";
export const CLOSE_TAB_BUTTON_LABEL = "Close Tab";
export const TAB_LIST_LABEL = "Tabs";
export const BACK_LABEL = "Back";
export const FORWARD_LABEL = "Forward";
export const SETTINGS_MENU_LABEL = "Mine settings";

const PRIMARY_BUTTON = 0;
const MIDDLE_BUTTON = 1;

/** Run a command for its effect; a failure is logged with what was tried. */
function run(command: Promise<unknown>, what: string): void {
  command.catch((error: unknown) => {
    console.error(`Tab bar could not ${what}:`, error);
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

/** A tab's label: one line that dissolves at the right edge when it does
 *  not fit (В46). Whether it fits is measured, since the dissolve must not
 *  eat the end of a label that does. */
function TabTitle({ text, width }: { text: string; width: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node) setOverflow(node.scrollWidth > node.clientWidth);
  }, [text, width]);
  return (
    <span
      ref={ref}
      data-tab-label=""
      data-overflow={overflow ? "true" : undefined}
      className="min-w-0 flex-1 overflow-hidden whitespace-nowrap font-mono text-sm leading-none"
    >
      {text}
    </span>
  );
}

interface TabBarProps {
  bar: TabBarState;
  /** A tab from another window held over this bar (В63). */
  dropHover: DropHover | null;
}

/** The tab bar row with the window's tabs. */
export function TabBar({ bar, dropHover }: TabBarProps) {
  const { tabs: sourceTabs, active_tab: activeTab, sidebar, fullscreen } = bar;
  const [localOrder, setLocalOrder] = useState<LocalOrder | null>(null);
  const tabs = useMemo(() => orderedTabs(sourceTabs, localOrder), [sourceTabs, localOrder]);
  const count = tabs.length;
  const activeIndex = tabs.findIndex((tab) => tab.id === activeTab);
  const history = tabs[activeIndex]?.history ?? { back: false, forward: false };
  // In full screen there are no traffic lights. Version 2 gives their place
  // back to the row; version 1 keeps it so nothing shifts.
  const uiVersion = useUiVersion();
  const trafficLightReserve = !(fullscreen && uiVersion === 2);

  const zoneRef = useRef<HTMLDivElement>(null);
  const plusSlotRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const tabNodes = useRef(new Map<TabId, HTMLElement>());

  // ── Widths (В48) ───────────────────────────────────────────────────────
  const [available, setAvailable] = useState(0);
  const [frozen, setFrozen] = useState<FrozenTabWidth | null>(null);
  const width = effectiveTabWidth(available, count, frozen);
  const stripWidth = Math.min(count * width, available);

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
    const next = hiddenEdges(strip.scrollLeft, stripWidth, count * width);
    setEdges((current) => (current.left === next.left && current.right === next.right ? current : next));
  }, [count, stripWidth, width]);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    if (activeIndex >= 0) {
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
  }, [activeIndex, count, stripWidth, syncEdges, width]);

  // ── What the handlers below read at the moment they run ──────────────────
  const chromeRows = bar.chrome_rows;
  const latest = useRef({ tabs, sourceTabs, fullscreen, width, chromeRows });
  useLayoutEffect(() => {
    latest.current = { tabs, sourceTabs, fullscreen, width, chromeRows };
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
      run(activateAdjacentTab(direction === "forward"), "show the adjacent tab");
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
    });
    const pending = menu.current;
    pending
      .then((built) => built.open(tabId, latest.current.tabs.length))
      .catch((error: unknown) => {
        // A menu that failed to build is built again on the next right click.
        if (menu.current === pending) menu.current = null;
        console.error("Tab bar could not show the tab menu:", error);
      });
  }, []);

  // ── The logo's settings menu (В43) ────────────────────────────────────────
  const settingsMenu = useRef<Promise<SettingsMenu> | null>(null);
  const openSettingsMenu = useCallback((button: HTMLElement) => {
    settingsMenu.current ??= createSettingsMenu({
      openSection: (section) => run(openSettingsWindow(section), "open the settings"),
      // Every page follows: this one at once, the others by settings-changed.
      chooseVersion: (version) => {
        storeUiVersion(version);
        broadcastSettingsChange(UI_VERSION_STORAGE_KEY);
      },
      // The backend lays the windows out again and tells every page.
      chooseChromeRows: (rows) => run(setChromeRows(rows), "change the chrome height"),
    });
    const pending = settingsMenu.current;
    const { left, bottom } = button.getBoundingClientRect();
    pending
      .then((built) => built.open({ x: left, y: bottom }, getUiVersion(), latest.current.chromeRows))
      .catch((error: unknown) => {
        if (settingsMenu.current === pending) settingsMenu.current = null;
        console.error("Tab bar could not show the settings menu:", error);
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
    run(beginTabDrag(pressed.tabId, pressed.grab.x, pressed.grab.y), "tear the tab off");
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
    // The new order shows at once; the backend's next state confirms it.
    setLocalOrder({
      source: current.sourceTabs,
      ids: moveItem(current.tabs.map((tab) => tab.id), pressed.fromIndex, target),
    });
    run(moveTab(pressed.tabId, target), "move the tab");
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
  const [incomingSlot, setIncomingSlot] = useState<number | null>(null);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const x = dropHover?.x ?? null;
    setIncomingSlot(
      strip === null || x === null
        ? null
        : dropSlot(
            x,
            tabCentres({
              stripLeft: strip.getBoundingClientRect().left,
              scrollLeft: strip.scrollLeft,
              width,
              count,
            }),
          ),
    );
  }, [count, dropHover, width]);

  const reportedSlot = useRef<number | null>(null);
  useEffect(() => {
    if (incomingSlot === reportedSlot.current) return;
    reportedSlot.current = incomingSlot;
    run(reportDropSlot(incomingSlot), "report the drop slot");
  }, [incomingSlot]);

  // ── Rendering ────────────────────────────────────────────────────────────
  const reorderTargetIndex = reorder === null
    ? null
    : reorderTarget({ fromIndex: reorder.fromIndex, offset: reorder.offset, width, count });
  // Neighbours glide aside only while a tab is dragged: after a drop the
  // new order is laid out in place, with nothing to animate.
  const shiftTransition = reorder !== null
    ? `transform ${motionDuration(TAB_REORDER_MOTION_MS)}ms ${TAB_REORDER_EASING}`
    : undefined;

  function tabShift(index: number, tabId: TabId): { offset: number; follows: boolean } {
    if (reorder === null || reorderTargetIndex === null) return { offset: 0, follows: false };
    if (tabId === reorder.tabId) return { offset: reorder.offset, follows: true };
    return {
      offset: neighbourShift({ index, fromIndex: reorder.fromIndex, toIndex: reorderTargetIndex, width }),
      follows: false,
    };
  }

  const stripStyle: CSSProperties = { width: stripWidth, ...stripFadeMaskStyle(edges) };

  return (
    <ChromeRow
      as="header"
      separator="bottom"
      data-tab-bar=""
      data-fullscreen={fullscreen ? "true" : undefined}
      className="bg-accent"
      onPointerLeave={() => setFrozen(null)}
    >
      {/* The traffic lights sit over this spot. */}
      {trafficLightReserve && (
        // 80 px at the standard row; the lights move right by half of what
        // the row grows, and the reserve with them (SPEC_TABS.md, В83).
        <div
          {...windowDrag}
          data-traffic-light-reserve=""
          className="h-full w-[calc(80px+(var(--chrome-row-content-height)-30px)/2)] shrink-0"
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
          !trafficLightReserve && "pl-[var(--chrome-icon-edge-pad)]",
        )}
      >
        <SidebarToggleButton
          collapsed={sidebar.collapsed}
          onToggle={() =>
            run(setWindowSidebar({ ...sidebar, collapsed: !sidebar.collapsed }), "toggle the sidebar")}
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
          onScroll={syncEdges}
          onKeyDown={handleStripKeyDown}
          onPointerDown={handleStripPointerDown}
          onClickCapture={handleStripClickCapture}
        >
          {tabs.map((tab, index) => {
            const active = tab.id === activeTab;
            const label = tabLabel(tab);
            const { offset, follows } = tabShift(index, tab.id);
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
                title={label}
                data-tab-id={tab.id}
                data-active={active ? "true" : undefined}
                data-dragging={follows ? "true" : undefined}
                // Square tabs the full height of the row, outlined by the
                // row's lines. The visible tab takes the chrome below it, a
                // line still parting them; the others take the row's surface
                // and light up under the pointer (В46).
                className={cn(
                  "relative flex h-full flex-none items-center border-r border-border pr-1 pl-3 outline-none",
                  "focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring",
                  index === 0 && "border-l",
                  active
                    ? "bg-chrome text-foreground"
                    : "text-muted-foreground hover:bg-active hover:text-foreground",
                  follows && "z-10",
                  follows && !active && "bg-accent",
                )}
                style={{
                  width,
                  transform: offset === 0 ? undefined : `translateX(${offset}px)`,
                  transition: follows ? undefined : shiftTransition,
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
                <TabTitle text={label} width={width} />
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
          // 8px from the last tab's line, 4px to the logo after it.
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
          buttons: the + slot's own padding. */}
      <ChromeActions data-tab-bar-settings="">
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
