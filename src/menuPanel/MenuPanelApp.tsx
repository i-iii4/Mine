// TRIAL (SPEC_MENU_WINDOW.md; DESIGN_SYSTEM.md, «Меню карточки в отдельном
// окне: проба»): the menu panel's page draws the menu a page of the app
// opened, from the menu's description (`MenuSpec`) with the one component
// that draws it on a page too (`MenuSpecView`), and asks the backend for
// every choice to be carried out by the page the menu came from.
//
// The backend has laid the menu out and moved the panel to it before the page
// hears of it (src-tauri/src/menu_panel/geometry.rs): the page draws the menu
// at the point the layout gives, in one synchronous render, and reports its
// first frame with the time of each step. The backend sets the panel's frame
// for each opening and names its size: the page draws once its own area is
// that size (SPEC_MENU_WINDOW.md, МО29, МО30). At rest the page draws
// nothing at all: the backend checks that, pixel by pixel, before the panel
// may be seen.
//
// A menu is named by the page it came from and its number there. The
// backend's messages of a menu are counted, and the page takes them in that
// order; the page counts its own requests, and the backend carries them out
// in that order: a choice the person made before closing the menu reaches
// the page it came from before the closing does, by number and not by time
// (SPEC_MENU_WINDOW.md, section 5).

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { MenuSpecView, menuSurfaceClass, type MenuDispatch } from "@/components/MenuSpecView";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { logFailure } from "@/lib/appLog";
import { commandById } from "@/lib/commandRegistry";
import { MENU_SHADOW_FIELD_PX, menuActionCloses } from "@/lib/menuSpec";
import { reportMenuPanelPainted, reportMenuPanelProgress, reportMenuPanelReady, requestOfMenuPanel } from "@/lib/menuPanelCommands";
import { MENU_PANEL_TO_PAGE_EVENT, MessageRow } from "@/lib/menuPanelProtocol";
import { notePointerCommand, noteNativeMenuCommand } from "@/lib/motionInput";
import { listenPage } from "@/lib/pageEvents";
import { SETTINGS_CHANGED_EVENT, adoptSettingsChange, type SettingsChangedPayload } from "@/lib/settingsChanged";
import type { MenuAction, MenuAnswer, MenuPanelCloseReason, MenuPanelLayout, MenuPanelPageMessage, MenuPanelSize, MenuPanelStep, MenuPanelToPage, MenuSpec } from "@/types";
import { applyMenuPanelAppearance, applyMenuPanelButtons } from "./appearance";

const LOG = "Menu panel";
const SURFACE_ATTRIBUTE = "data-menu-panel-surface";

/** A menu: the page it came from and its number there. */
interface MenuName {
  source: string;
  menu: number;
}

interface Drawn extends MenuName {
  spec: MenuSpec;
  /** Where Radix anchors the menu in this page, the side and edge it keeps. */
  layout: MenuPanelLayout;
}

type Opening = Extract<MenuPanelToPage, { kind: "open" }>;

function now(): number {
  return performance.timeOrigin + performance.now();
}

/** After two frames the page has drawn its rest: what the backend checks. */
function afterTwoFrames(run: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(run));
}

/** Tell the backend a step of the menu `name` before its first frame, with
 *  the page as it is now: a menu that draws nothing in time is logged with
 *  the last step its page reached (SPEC_MENU_WINDOW.md, МО40а). */
function progress(name: MenuName, step: MenuPanelStep): void {
  void reportMenuPanelProgress({
    source: name.source,
    menu: name.menu,
    step,
    area: { width: window.innerWidth, height: window.innerHeight },
    visible: document.visibilityState === "visible",
  }).catch((error: unknown) => logFailure(`${LOG}: the step ${step} of menu ${name.menu} of ${name.source} did not reach the backend`, error));
}

/** Whether this page's area is the frame the backend set for a menu. */
function areaIs(frame: MenuPanelSize): boolean {
  return Math.abs(window.innerWidth - frame.width) < 1 && Math.abs(window.innerHeight - frame.height) < 1;
}

export function MenuPanelApp() {
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const [open, setOpen] = useState(false);
  const drawnRef = useRef<Drawn | null>(null);
  drawnRef.current = drawn;
  const openRef = useRef(false);
  openRef.current = open;
  // Why the menu is closing, for the backend: an item, Escape, or a press.
  const closeReasonRef = useRef<MenuPanelCloseReason>("outside");
  // The page's count of its requests for the menu it draws: the backend
  // carries them out in this order.
  const requestRef = useRef(0);
  // The menu this page has asked to close, or heard closed: nothing more
  // is asked of it.
  const overRef = useRef(false);
  const pendingRef = useRef(new Map<number, (answer: MenuAnswer | null) => void>());
  // The backend's messages of each menu, in the order of their count.
  const rowsRef = useRef(new Map<string, MessageRow<MenuPanelToPage>>());
  // A menu whose frame this page's area has not taken yet: it is drawn when
  // the area changes to it (МО30).
  const awaitingFrameRef = useRef<{ name: MenuName; frame: MenuPanelSize; draw: () => void } | null>(null);

  /** Ask the backend of `name`: a choice for the page the menu came from,
   *  the menu's closing, or both, the choice first. */
  const request = useCallback((name: MenuName, action: MenuAction | null, close: MenuPanelCloseReason | null): number => {
    requestRef.current += 1;
    const number = requestRef.current;
    if (close !== null) overRef.current = true;
    void requestOfMenuPanel({ source: name.source, menu: name.menu, request: number, action, close }).catch((error: unknown) => {
      logFailure(`${LOG}: a request did not reach the backend`, error);
      const resolve = pendingRef.current.get(number);
      pendingRef.current.delete(number);
      resolve?.(null);
    });
    return number;
  }, []);

  /** Send a choice to the page the menu came from; its answer, or null when
   *  the menu closes first. A choice that closes the menu, a command's
   *  unless its row keeps the menu open, is one request that carries both:
   *  the page hears the choice, then the closing (SPEC_MENU_WINDOW.md,
   *  МО24). */
  const ask = useCallback<MenuDispatch>((action) => {
    const current = drawnRef.current;
    if (current === null || overRef.current) return Promise.resolve(null);
    const closes = menuActionCloses(current.spec, action);
    if (closes) {
      closeReasonRef.current = "chosen";
      // A menu's own row closes its menu as it is chosen; what a widget
      // asks does not, so the menu goes here.
      if (action.kind === "widget") setOpen(false);
    }
    return new Promise((resolve) => {
      const number = request(current, action, closes ? "chosen" : null);
      pendingRef.current.set(number, resolve);
    });
  }, [request]);

  /** Every choice still waiting for its answer has none: the menu is over. */
  const dropPending = useCallback(() => {
    const waiting = [...pendingRef.current.values()];
    pendingRef.current.clear();
    for (const resolve of waiting) resolve(null);
  }, []);

  /** The menu closed here: Escape, an item, a press in the panel. */
  const closeHere = useCallback((reason: MenuPanelCloseReason) => {
    const current = drawnRef.current;
    setOpen(false);
    // A choice that closes the menu has said so already.
    if (current !== null && !overRef.current) request(current, null, reason);
  }, [request]);

  /** Draw the menu `name` now: the page's area is its frame's. */
  const draw = useCallback((name: MenuName, opening: Opening, receivedAt: number) => {
    const sizedAt = now();
    applyMenuPanelButtons(opening.buttons);
    // A menu a key opened lands at once, the pointer's moves by the level
    // (SPEC_MOTION_LEVELS.md, УД4): the other page's input stands for this
    // page's.
    if (opening.by_key) noteNativeMenuCommand();
    else notePointerCommand();
    closeReasonRef.current = "outside";
    flushSync(() => {
      setDrawn({ ...name, spec: opening.spec, layout: opening.layout });
      setOpen(true);
    });
    const drawnAt = now();
    const surface = document.querySelector<HTMLElement>(`[${SURFACE_ATTRIBUTE}]`);
    if (surface === null) {
      logFailure(`${LOG}: the menu was not drawn`, `menu ${name.menu} of ${name.source}`);
      flushSync(() => setOpen(false));
      request(name, null, "failed");
      return;
    }
    // A key opened it: the first row takes the highlight, as Radix gives it
    // on the page when a key opens a menu. Radix has focused the menu by now:
    // the effects of a synchronous render ran with it. A list under a search
    // field keeps the keyboard in its field.
    if (opening.by_key && opening.spec.role !== "search") {
      surface.querySelector<HTMLElement>('[role^="menuitem"]')?.focus({ preventScroll: true });
    }
    // The layout's own measure, against the size the other page counted: the
    // backend logs both.
    const measured = { width: surface.offsetWidth, height: surface.offsetHeight };
    progress(name, "frame_requested");
    requestAnimationFrame((frame) => {
      void reportMenuPanelPainted({
        source: name.source,
        menu: name.menu,
        received_at: receivedAt,
        sized_at: sizedAt,
        drawn_at: drawnAt,
        frame_at: performance.timeOrigin + frame,
        measured,
      }).catch((error: unknown) => logFailure(`${LOG}: the first frame's report did not reach the backend`, error));
    });
  }, [request]);

  /** A menu to draw: at once when the page's area is its frame's, else when
   *  the area changes to it. No time ends that wait: the backend's deadline
   *  for the first frame does (МО40). */
  const showOpening = useCallback((name: MenuName, opening: Opening) => {
    const receivedAt = now();
    progress(name, "received");
    dropPending();
    requestRef.current = 0;
    overRef.current = false;
    awaitingFrameRef.current = null;
    const drawNow = () => {
      try {
        draw(name, opening, receivedAt);
      } catch (error) {
        logFailure(`${LOG}: the menu could not be drawn`, error);
        if (!overRef.current) request(name, null, "failed");
      }
    };
    if (areaIs(opening.layout.frame)) drawNow();
    else awaitingFrameRef.current = { name, frame: opening.layout.frame, draw: drawNow };
  }, [draw, dropPending, request]);

  /** One message of the backend's about the menu `name`, its turn come. */
  const apply = useCallback((name: MenuName, body: MenuPanelToPage) => {
    const current = drawnRef.current;
    const isDrawn = current !== null && current.source === name.source && current.menu === name.menu;
    switch (body.kind) {
      case "open":
        showOpening(name, body);
        return;
      case "update":
        if (isDrawn) setDrawn({ ...current, spec: body.spec });
        return;
      case "answer": {
        if (!isDrawn) return;
        const resolve = pendingRef.current.get(body.request);
        pendingRef.current.delete(body.request);
        resolve?.(body.answer);
        return;
      }
      case "closed":
        // A menu still waiting for its frame is never drawn.
        awaitingFrameRef.current = null;
        if (!isDrawn) return;
        overRef.current = true;
        dropPending();
        setOpen(false);
    }
  }, [dropPending, showOpening]);

  useEffect(() => {
    const rows = rowsRef.current;
    const subscriptions = [
      listenPage<MenuPanelPageMessage>(MENU_PANEL_TO_PAGE_EVENT, (event) => {
        const { source, menu, seq, body } = event.payload;
        const key = `${source}#${menu}`;
        const row = rows.get(key) ?? new MessageRow<MenuPanelToPage>();
        rows.set(key, row);
        for (const due of row.take(seq, body)) {
          // The closing is the last message of a menu: its row goes.
          if (due.kind === "closed") rows.delete(key);
          apply({ source, menu }, due);
        }
      }),
      listenPage<SettingsChangedPayload>(SETTINGS_CHANGED_EVENT, (event) => {
        adoptSettingsChange(event.payload);
        applyMenuPanelAppearance();
      }),
    ];
    // Every subscription stands, and the page has drawn its rest, before the
    // backend hears it is ready and checks the panel for clearness.
    void Promise.all(subscriptions).then(
      () => afterTwoFrames(() => void reportMenuPanelReady().catch((error: unknown) => logFailure(`${LOG}: ready`, error))),
      (error: unknown) => logFailure(`${LOG}: the page could not listen`, error),
    );
    // The page's area changed: a menu waiting for this frame is drawn.
    const resized = () => {
      const awaiting = awaitingFrameRef.current;
      if (awaiting === null) return;
      if (!areaIs(awaiting.frame)) {
        progress(awaiting.name, "resized");
        return;
      }
      awaitingFrameRef.current = null;
      progress(awaiting.name, "sized");
      awaiting.draw();
    };
    // A failure while a menu is up gives the clicks back at once.
    const fail = (event: ErrorEvent | PromiseRejectionEvent) => {
      const current = drawnRef.current;
      if (current === null || !openRef.current) return;
      logFailure(`${LOG}: the page failed with a menu open`, "reason" in event ? event.reason : event.error);
      closeHere("failed");
    };
    window.addEventListener("resize", resized);
    window.addEventListener("error", fail);
    window.addEventListener("unhandledrejection", fail);
    return () => {
      window.removeEventListener("resize", resized);
      window.removeEventListener("error", fail);
      window.removeEventListener("unhandledrejection", fail);
      for (const subscription of subscriptions) void subscription.then((unlisten) => unlisten(), () => undefined);
    };
  }, [apply, closeHere]);

  const handleKeyDownCapture = useCallback((event: ReactKeyboardEvent) => {
    // The chord that opened the menu closes it, as on the page.
    if (!commandById("element-menu").matches?.(event.nativeEvent)) return;
    event.preventDefault();
    event.stopPropagation();
    closeReasonRef.current = "escape";
    closeHere("escape");
  }, [closeHere]);

  if (drawn === null) return null;
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next || !openRef.current) return;
        closeHere(closeReasonRef.current);
      }}
      modal={false}
    >
      <div
        className="pointer-events-none fixed size-0"
        style={{ left: drawn.layout.anchor.x, top: drawn.layout.anchor.y }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="block size-0 min-h-0 min-w-0 border-0 bg-transparent p-0 opacity-0"
          />
        </DropdownMenuTrigger>
      </div>
      {/* The page draws the menu's shadow, the menu's own on a page; Radix
          keeps it inside the panel by the shadow's field
          (src/lib/menuSpec.ts). The window has no shadow. */}
      <DropdownMenuContent
        side={drawn.layout.side}
        align={drawn.layout.align}
        collisionPadding={MENU_SHADOW_FIELD_PX}
        widthRole={drawn.spec.role}
        className={menuSurfaceClass(drawn.spec.role)}
        style={drawn.layout.max_height === null ? undefined : { maxHeight: drawn.layout.max_height }}
        data-menu-panel-surface=""
        onEscapeKeyDown={() => {
          closeReasonRef.current = "escape";
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onKeyDownCapture={handleKeyDownCapture}
      >
        <MenuSpecView
          spec={drawn.spec}
          dispatch={ask}
          open={open}
          collisionPadding={MENU_SHADOW_FIELD_PX}
          onKeyDownCapture={handleKeyDownCapture}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
