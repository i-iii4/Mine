// TRIAL (DESIGN_SYSTEM.md, «Меню карточки в отдельном окне: проба»): the menu
// panel's page draws the card menu a tab opened, with the components the
// tab's own menu draws (`CardMenuEntriesView`, `CollectionPicker`), and sends
// every choice back to the tab (src/lib/menuPanelProtocol.ts).
//
// An opening goes in three steps within one task: the menu is drawn unseen
// and measured, laid out on the screen by Radix's rules
// (src/lib/menuPanelGeometry.ts), and drawn again at its place; the backend
// then moves the panel there and gives it the keyboard, and the page shows.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { emitTo } from "@tauri-apps/api/event";
import { CardMenuEntriesView } from "@/components/CardHoverMenu";
import { CollectionPicker } from "@/components/CollectionPicker";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CollectionNameCheckContext, type CollectionNameCheck } from "@/hooks/useCollectionNameRefusal";
import { logFailure } from "@/lib/appLog";
import type { CardMenuItemId } from "@/lib/cardMenuEntries";
import { commandById } from "@/lib/commandRegistry";
import { MENU_PLATE_GAP_PX } from "@/lib/floatingLayer";
import {
  MENU_ACTION_WIDTH_PX,
  MENU_SHADOW_FIELD_PX,
  fitsPanel,
  layoutPanel,
  type MenuOpener,
  type MenuSide,
  type ScreenPoint,
} from "@/lib/menuPanelGeometry";
import {
  closeMenuPanel,
  reportMenuPanelPainted,
  reportMenuPanelReady,
  showMenuPanel,
} from "@/lib/menuPanelCommands";
import {
  decodeCardMenuPayload,
  MENU_PANEL_ACTION_EVENT,
  MENU_PANEL_ANSWER_EVENT,
  MENU_PANEL_CLOSED_EVENT,
  MENU_PANEL_OPEN_EVENT,
  MENU_PANEL_UPDATE_EVENT,
  parseAnswerMessage,
  parseUpdateMessage,
  type CardMenuPayload,
  type MenuPanelAction,
  type MenuPanelActionMessage,
  type MenuPanelAnswer,
} from "@/lib/menuPanelProtocol";
import { notePointerCommand, noteNativeMenuCommand } from "@/lib/motionInput";
import { listenPage } from "@/lib/pageEvents";
import { SETTINGS_CHANGED_EVENT, adoptSettingsChange, type SettingsChangedPayload } from "@/lib/settingsChanged";
import type { MenuPanelCloseReason, MenuPanelClosed, MenuPanelOpening } from "@/types";
import { applyMenuPanelAppearance, applyMenuPanelButtons } from "./appearance";

const LOG = "Card menu panel";
const HIDDEN_ATTRIBUTE = "data-menu-panel-hidden";
const SURFACE_ATTRIBUTE = "data-menu-panel-surface";
/** A tab answers a choice within this, or the choice counts as not made. */
const ANSWER_DEADLINE_MS = 10_000;

interface Drawn {
  menu: number;
  source: string;
  payload: CardMenuPayload;
  /** Where Radix anchors the menu in this page, the side and edge it keeps. */
  anchor: ScreenPoint;
  side: MenuSide;
  align: "start" | "end";
  maxHeight: number | null;
}

/** Before the layout: a place in the panel where any menu it holds fits,
 *  the shadow's field off its top left corner. */
const MEASURE_ANCHOR: ScreenPoint = {
  x: MENU_SHADOW_FIELD_PX + MENU_ACTION_WIDTH_PX,
  y: MENU_SHADOW_FIELD_PX - MENU_PLATE_GAP_PX,
};

function setHidden(hidden: boolean): void {
  document.documentElement.toggleAttribute(HIDDEN_ATTRIBUTE, hidden);
}

function openerOf(opening: MenuPanelOpening, payload: CardMenuPayload): MenuOpener {
  if (payload.opener.kind === "point") return { kind: "point", point: { x: opening.anchor.x, y: opening.anchor.y } };
  return { kind: "plate", plate: opening.anchor, align: payload.opener.align };
}

export function MenuPanelApp() {
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const [open, setOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const drawnRef = useRef<Drawn | null>(null);
  drawnRef.current = drawn;
  const openRef = useRef(false);
  openRef.current = open;
  // Why the menu is closing, for the backend: an item, Escape, or a press.
  const closeReasonRef = useRef<MenuPanelCloseReason>("outside");
  const requestRef = useRef(0);
  const pendingRef = useRef(new Map<number, (answer: MenuPanelAnswer | null) => void>());
  const connectTriggerRef = useRef<HTMLDivElement>(null);

  const ask = useCallback((action: MenuPanelAction): Promise<MenuPanelAnswer | null> => {
    const current = drawnRef.current;
    if (current === null) return Promise.resolve(null);
    requestRef.current += 1;
    const request = requestRef.current;
    const message: MenuPanelActionMessage = { menu: current.menu, request, action };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingRef.current.delete(request);
        resolve(null);
      }, ANSWER_DEADLINE_MS);
      pendingRef.current.set(request, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      void emitTo(current.source, MENU_PANEL_ACTION_EVENT, message).catch((error: unknown) => {
        logFailure(`${LOG}: a choice did not reach the tab`, error);
        pendingRef.current.delete(request);
        clearTimeout(timer);
        resolve(null);
      });
    });
  }, []);

  /** The menu closed here: Escape, an item, a press in the panel. */
  const closeHere = useCallback((reason: MenuPanelCloseReason) => {
    const current = drawnRef.current;
    setOpen(false);
    setConnectOpen(false);
    if (current !== null) void closeMenuPanel(current.menu, reason).catch((error: unknown) => logFailure(`${LOG}: close`, error));
  }, []);

  const showOpening = useCallback(async (opening: MenuPanelOpening) => {
    const payload = decodeCardMenuPayload(opening.payload);
    if (payload === null) {
      logFailure(`${LOG}: the tab sent no menu`, opening.payload.slice(0, 200));
      void closeMenuPanel(opening.menu, "failed").catch(() => undefined);
      return;
    }
    setHidden(true);
    applyMenuPanelButtons(payload.buttons);
    // A menu a key opened lands at once, the pointer's moves by the level
    // (SPEC_MOTION_LEVELS.md, УД4): the tab's input stands for this page's.
    if (payload.byKey) noteNativeMenuCommand();
    else notePointerCommand();
    closeReasonRef.current = "outside";
    const measuring: Drawn = {
      menu: opening.menu,
      source: opening.source,
      payload,
      anchor: MEASURE_ANCHOR,
      side: "bottom",
      align: "end",
      maxHeight: null,
    };
    flushSync(() => {
      setDrawn(measuring);
      setConnectOpen(false);
      setOpen(true);
    });
    const surface = document.querySelector<HTMLElement>(`[${SURFACE_ATTRIBUTE}]`);
    const size = surface ? { width: surface.offsetWidth, height: surface.offsetHeight } : null;
    if (size === null || !fitsPanel(size)) {
      logFailure(`${LOG}: the menu does not fit the panel`, JSON.stringify(size));
      flushSync(() => setOpen(false));
      void closeMenuPanel(opening.menu, "failed").catch(() => undefined);
      return;
    }
    const layout = layoutPanel(openerOf(opening, payload), size, opening.screen);
    flushSync(() => {
      setDrawn({
        ...measuring,
        anchor: layout.anchor,
        side: layout.placement.side,
        align: layout.placement.align,
        maxHeight: layout.placement.maxHeight,
      });
    });
    // A key opened it: the first row takes the highlight, as Radix gives it
    // on the page when a key opens a menu. Radix has focused the menu by now:
    // the effects of a synchronous render ran with it.
    if (payload.byKey) {
      document.querySelector<HTMLElement>(`[${SURFACE_ATTRIBUTE}] [role="menuitem"]`)?.focus({ preventScroll: true });
    }
    try {
      await showMenuPanel(opening.menu, layout.origin);
    } catch (error) {
      // The backend closed it and told the tab, which opens its own menu.
      logFailure(`${LOG}: not shown`, error);
      if (drawnRef.current?.menu === opening.menu) flushSync(() => setOpen(false));
      return;
    }
    if (drawnRef.current?.menu !== opening.menu || !openRef.current) return;
    setHidden(false);
    requestAnimationFrame((frame) => {
      void reportMenuPanelPainted({
        menu: opening.menu,
        frame_at: performance.timeOrigin + frame,
        opener: payload.opener.kind,
      }).catch(() => undefined);
    });
  }, []);

  useEffect(() => {
    const subscriptions = [
      listenPage<MenuPanelOpening>(MENU_PANEL_OPEN_EVENT, (event) => {
        void showOpening(event.payload).catch((error: unknown) => {
          logFailure(`${LOG}: the menu could not be drawn`, error);
          void closeMenuPanel(event.payload.menu, "failed").catch(() => undefined);
        });
      }),
      listenPage<MenuPanelClosed>(MENU_PANEL_CLOSED_EVENT, (event) => {
        if (drawnRef.current?.menu !== event.payload.menu) return;
        setOpen(false);
        setConnectOpen(false);
      }),
      listenPage<unknown>(MENU_PANEL_UPDATE_EVENT, (event) => {
        const message = parseUpdateMessage(event.payload);
        const current = drawnRef.current;
        if (message === null || current === null || current.menu !== message.menu) return;
        setDrawn({ ...current, payload: message.payload });
      }),
      listenPage<unknown>(MENU_PANEL_ANSWER_EVENT, (event) => {
        const message = parseAnswerMessage(event.payload);
        if (message === null || drawnRef.current?.menu !== message.menu) return;
        const resolve = pendingRef.current.get(message.request);
        pendingRef.current.delete(message.request);
        resolve?.(message.answer);
      }),
      listenPage<SettingsChangedPayload>(SETTINGS_CHANGED_EVENT, (event) => {
        adoptSettingsChange(event.payload);
        applyMenuPanelAppearance();
      }),
    ];
    // Every subscription stands before the backend hears the page is ready.
    void Promise.all(subscriptions).then(
      () => reportMenuPanelReady(),
      (error: unknown) => logFailure(`${LOG}: the page could not listen`, error),
    ).catch((error: unknown) => logFailure(`${LOG}: ready`, error));
    // A failure while a menu is up gives the clicks back at once.
    const fail = (event: ErrorEvent | PromiseRejectionEvent) => {
      const current = drawnRef.current;
      if (current === null || !openRef.current) return;
      logFailure(`${LOG}: the page failed with a menu open`, "reason" in event ? event.reason : event.error);
      closeHere("failed");
    };
    window.addEventListener("error", fail);
    window.addEventListener("unhandledrejection", fail);
    return () => {
      window.removeEventListener("error", fail);
      window.removeEventListener("unhandledrejection", fail);
      for (const subscription of subscriptions) void subscription.then((unlisten) => unlisten(), () => undefined);
    };
  }, [closeHere, showOpening]);

  const checkName = useCallback<CollectionNameCheck>(
    (name) => ask({ kind: "check", name }).then((answer) => (answer?.kind === "refusal" ? answer.reason : null)),
    [ask],
  );

  const handleKeyDownCapture = useCallback((event: ReactKeyboardEvent) => {
    // The chord that opened the menu closes it, as on the page.
    if (!commandById("element-menu").matches?.(event.nativeEvent)) return;
    event.preventDefault();
    event.stopPropagation();
    closeReasonRef.current = "escape";
    closeHere("escape");
  }, [closeHere]);

  const run = useCallback((id: CardMenuItemId) => {
    closeReasonRef.current = "chosen";
    void ask({ kind: "run", id });
  }, [ask]);

  const runTable = useCallback((id: string) => {
    closeReasonRef.current = "chosen";
    void ask({ kind: "table", id });
  }, [ask]);

  const picker = useMemo(() => {
    if (drawn === null) return null;
    const { blockSlug, selectedTags, tags, currentTag } = drawn.payload.picker;
    return (
      <CollectionPicker
        blockSlug={blockSlug}
        selectedTags={selectedTags}
        tags={tags}
        currentTag={currentTag ?? undefined}
        onToggleTag={(_slug, tag, hasTag) =>
          ask({ kind: "toggle", tag, hasTag }).then((answer) =>
            answer?.kind === "membership" && answer.made !== null ? answer.made : answer === null ? false : undefined)}
        onCreateAndAssign={(tag) => ask({ kind: "create", tag })}
        stopKeyPropagation
        onRequestClose={() => {
          setConnectOpen(false);
          requestAnimationFrame(() => connectTriggerRef.current?.focus());
        }}
      />
    );
  }, [ask, drawn]);

  if (drawn === null) return null;
  return (
    <CollectionNameCheckContext.Provider value={checkName}>
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
          style={{ left: drawn.anchor.x, top: drawn.anchor.y }}
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
            (src/lib/menuPanelGeometry.ts). The window has no shadow. */}
        <DropdownMenuContent
          side={drawn.side}
          align={drawn.align}
          collisionPadding={MENU_SHADOW_FIELD_PX}
          style={drawn.maxHeight === null ? undefined : { maxHeight: drawn.maxHeight }}
          data-menu-panel-surface=""
          onEscapeKeyDown={() => {
            closeReasonRef.current = "escape";
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onKeyDownCapture={handleKeyDownCapture}
        >
          <CardMenuEntriesView
            entries={drawn.payload.entries}
            onRun={run}
            onTableCommand={runTable}
            onKeyDownCapture={handleKeyDownCapture}
            collisionPadding={MENU_SHADOW_FIELD_PX}
            connect={{ open: connectOpen, onOpenChange: setConnectOpen, triggerRef: connectTriggerRef, picker }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </CollectionNameCheckContext.Provider>
  );
}
