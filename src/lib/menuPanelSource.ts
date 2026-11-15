// TRIAL (DESIGN_SYSTEM.md, «Меню карточки в отдельном окне: проба»): a tab's
// side of the menu panel. The tab opens one card menu there at a time, runs
// each choice made in it with its own handlers, and keeps the rules of an
// open menu on its page meanwhile (src/lib/openMenus.ts).
//
// Every failure leaves the menu on the page as before: the panel not made or
// not ready, the backend refusing, no answer within `OPEN_DEADLINE_MS`, the
// panel not shown within `SHOW_DEADLINE_MS`, a menu closed before it showed.
// The caller then opens its own menu (`onRefused`).

import { emitTo } from "@tauri-apps/api/event";
import type { MenuPanelCloseReason, MenuPanelClosed, MenuPanelShown, MenuPanelStatus, ScreenRect } from "@/types";
import { logFailure } from "./appLog";
import { menuMode, MENU_MODE_STORAGE_KEY, parseMenuMode } from "./menuMode";
import { MENU_PANEL_SIZE } from "./menuPanelGeometry";
import {
  closeMenuPanel,
  openInMenuPanel,
  prepareMenuPanelWindow,
} from "./menuPanelCommands";
import {
  encodeCardMenuPayload,
  MENU_PANEL_ACTION_EVENT,
  MENU_PANEL_ANSWER_EVENT,
  MENU_PANEL_CLOSED_EVENT,
  MENU_PANEL_LABEL,
  MENU_PANEL_SHOWN_EVENT,
  MENU_PANEL_STATUS_EVENT,
  MENU_PANEL_UPDATE_EVENT,
  parseActionMessage,
  type CardMenuPayload,
  type MenuPanelAction,
  type MenuPanelAnswer,
  type MenuPanelAnswerMessage,
  type MenuPanelUpdateMessage,
} from "./menuPanelProtocol";
import { holdContextMenuPresence, holdMenuElsewhere } from "./openMenus";
import { listenPage } from "./pageEvents";
import { SETTINGS_CHANGED_EVENT, type SettingsChangedPayload } from "./settingsChanged";

const LOG = "Card menu panel";

/** The backend answers an opening within this, or the menu opens on the page. */
export const OPEN_DEADLINE_MS = 300;
/** The panel shows the menu within this after the backend took it. */
export const SHOW_DEADLINE_MS = 400;
/** After a press elsewhere closed the menu, a press on this page within this
 *  is the same press: the backend's word may come before the page's own
 *  event or after it. */
export const OUTSIDE_PRESS_GRACE_MS = 300;
/** A focus of the window within this after the menu closed is the window
 *  taking the keyboard back from the panel, not a return to the app. */
export const FOCUS_RETURN_GRACE_MS = 1000;

let panelReady = false;
let following = false;
let lastInputAt: number | null = null;

/** The input that opens a menu, in epoch milliseconds with the page's own
 *  clock: `performance.timeOrigin` is wall time, so the panel's page measures
 *  against the same origin. */
function noteInput(event: Event): void {
  lastInputAt = performance.timeOrigin + event.timeStamp;
}

/** The time of the input that opened the menu now: the last key or press,
 *  else now. */
export function openingInputAt(now: number = performance.timeOrigin + performance.now()): number {
  return lastInputAt !== null && now - lastInputAt < 1000 ? lastInputAt : now;
}

/** Whether a card menu opening now goes to the panel. */
export function menuPanelUsable(): boolean {
  return panelReady && menuMode() === "window";
}

async function prepare(): Promise<void> {
  try {
    const status = await prepareMenuPanelWindow(MENU_PANEL_SIZE);
    panelReady = status.ready;
  } catch (error) {
    panelReady = false;
    logFailure(`${LOG}: the panel was not made`, error);
  }
}

/**
 * A tab page's entry: hears the panel's readiness and the inputs that open
 * menus, and has the panel made when the menu mode is `window`, now or once
 * it is chosen. A second call does nothing.
 */
export function followMenuPanel(): void {
  if (following) return;
  following = true;
  window.addEventListener("pointerdown", noteInput, true);
  window.addEventListener("keydown", noteInput, true);
  window.addEventListener("contextmenu", noteInput, true);
  void listenPage<MenuPanelStatus>(MENU_PANEL_STATUS_EVENT, (event) => {
    panelReady = event.payload.ready;
  }).catch(() => {
    // Outside a Tauri page there is no panel: the menu stays on the page.
  });
  void listenPage<SettingsChangedPayload>(SETTINGS_CHANGED_EVENT, (event) => {
    if (event.payload.key !== MENU_MODE_STORAGE_KEY) return;
    if (parseMenuMode(event.payload.value ?? null) === "window") void prepare();
  }).catch(() => undefined);
  void listenSession();
  if (menuMode() === "window") void prepare();
}

// ── The open session ──────────────────────────────────────────────────────

export interface MenuPanelHandlers {
  /** Carry out a choice made in the panel; its answer goes back. */
  onAction: (action: MenuPanelAction) => MenuPanelAnswer | Promise<MenuPanelAnswer>;
  /** The menu showed and closed now. */
  onClosed: (reason: MenuPanelCloseReason) => void;
  /** The menu did not show in the panel: open it on the page. */
  onRefused: () => void;
}

export interface MenuPanelSession {
  /** Send what changed in the menu while it is open. */
  update: (payload: CardMenuPayload) => void;
  /** Close the menu, if it is still open; `onClosed` is not called. */
  close: (reason: MenuPanelCloseReason) => void;
}

interface Session {
  menu: number | null;
  phase: "opening" | "shown" | "done";
  handlers: MenuPanelHandlers;
  releaseGuard: () => void;
  releasePresence: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** A close asked before the backend named the menu. */
  closeAsked: MenuPanelCloseReason | null;
  /** The backend's word that came before its answer named the menu: the
   *  event and the command's answer travel apart. */
  early: { shown: Set<number>; closed: Map<number, MenuPanelCloseReason> };
}

let current: Session | null = null;
let focusReturnUntil = 0;
/** The menus that showed, by number, kept a moment past their closing: an
 *  item's choice and the closing it causes reach the tab by different ways,
 *  and the choice may come second. */
const answerable = new Map<number, Session>();
const ANSWERABLE_AFTER_CLOSE_MS = 2000;
let listening: Promise<void> | null = null;

/** Whether the window's focus now is the window taking the keyboard back
 *  from the panel: while a menu is open there and for a moment after. The
 *  reactions to coming back to the app skip it (В42; DESIGN_SYSTEM.md,
 *  «Меню карточки в отдельном окне: проба»). */
export function focusReturnsFromMenuPanel(now: number = Date.now()): boolean {
  return current !== null || now < focusReturnUntil;
}

function clearTimer(session: Session): void {
  if (session.timer !== null) clearTimeout(session.timer);
  session.timer = null;
}

function end(session: Session, guardGraceMs: number): void {
  clearTimer(session);
  session.phase = "done";
  const menu = session.menu;
  if (menu !== null && answerable.get(menu) === session) {
    setTimeout(() => {
      if (answerable.get(menu) === session) answerable.delete(menu);
    }, ANSWERABLE_AFTER_CLOSE_MS);
  }
  session.releasePresence?.();
  if (guardGraceMs > 0) setTimeout(session.releaseGuard, guardGraceMs);
  else session.releaseGuard();
  if (current === session) current = null;
  focusReturnUntil = Date.now() + FOCUS_RETURN_GRACE_MS;
}

/** The menu will not show in the panel: the page opens its own. */
function refuse(session: Session, why: string, error?: unknown): void {
  if (session.phase === "done") return;
  if (session.menu !== null) void closeMenuPanel(session.menu, "unresponsive").catch(() => undefined);
  end(session, 0);
  logFailure(`${LOG}: opened on the page, ${why}`, error ?? why);
  session.handlers.onRefused();
}

function sendToPanel(event: string, payload: MenuPanelAnswerMessage | MenuPanelUpdateMessage): void {
  void emitTo(MENU_PANEL_LABEL, event, payload).catch((error: unknown) => logFailure(`${LOG}: message to the panel`, error));
}

async function answer(session: Session, request: number, action: MenuPanelAction): Promise<void> {
  let reply: MenuPanelAnswer;
  try {
    reply = await session.handlers.onAction(action);
  } catch (error) {
    logFailure(`${LOG}: a choice failed`, error);
    reply = action.kind === "toggle" ? { kind: "membership", made: false } : action.kind === "check" ? { kind: "refusal", reason: null } : { kind: "done" };
  }
  if (session.menu === null) return;
  sendToPanel(MENU_PANEL_ANSWER_EVENT, { menu: session.menu, request, answer: reply });
}

function listenSession(): Promise<void> {
  if (listening) return listening;
  listening = (async () => {
    try {
      await Promise.all([
        listenPage<MenuPanelShown>(MENU_PANEL_SHOWN_EVENT, (event) => {
          const session = current;
          if (session === null) return;
          if (session.menu === null) session.early.shown.add(event.payload.menu);
          else if (session.menu === event.payload.menu) shown(session);
        }),
        listenPage<MenuPanelClosed>(MENU_PANEL_CLOSED_EVENT, (event) => {
          const session = current;
          if (session === null) return;
          if (session.menu === null) session.early.closed.set(event.payload.menu, event.payload.reason);
          else if (session.menu === event.payload.menu) closed(session, event.payload.reason);
        }),
        listenPage<unknown>(MENU_PANEL_ACTION_EVENT, (event) => {
          const message = parseActionMessage(event.payload);
          const session = message === null ? undefined : answerable.get(message.menu);
          if (message === null || session === undefined) return;
          void answer(session, message.request, message.action);
        }),
      ]);
    } catch {
      // Outside a Tauri page: nothing opens in a panel.
    }
  })();
  return listening;
}

function shown(session: Session): void {
  if (session.phase !== "opening") return;
  clearTimer(session);
  session.phase = "shown";
  if (session.menu !== null) answerable.set(session.menu, session);
}

function closed(session: Session, reason: MenuPanelCloseReason): void {
  if (session.phase === "done") return;
  if (session.phase === "opening") {
    refuse(session, `closed before it showed (${reason})`);
    return;
  }
  end(session, reason === "outside" ? OUTSIDE_PRESS_GRACE_MS : 0);
  session.handlers.onClosed(reason);
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(JSON.stringify(error)));
      },
    );
  });
}

/**
 * Open the card menu `payload` in the panel, anchored to `anchor` in this
 * page's coordinates (a button's plate, or the point of a right click as a
 * rectangle of no size). A menu already open from this page closes first.
 * Until it closes the page keeps an open menu's rules; a right click's menu
 * also holds the pointer's answers (`contextMenu`).
 */
export function openMenuPanel(
  anchor: ScreenRect,
  payload: CardMenuPayload,
  handlers: MenuPanelHandlers,
  options: { contextMenu: boolean; eventAt: number },
): MenuPanelSession {
  if (current !== null) {
    const previous = current;
    if (previous.menu !== null) void closeMenuPanel(previous.menu, "source").catch(() => undefined);
    end(previous, 0);
    previous.handlers.onClosed("source");
  }
  const session: Session = {
    menu: null,
    phase: "opening",
    handlers,
    releaseGuard: () => undefined,
    releasePresence: options.contextMenu ? holdContextMenuPresence() : null,
    timer: null,
    closeAsked: null,
    early: { shown: new Set(), closed: new Map() },
  };
  session.releaseGuard = holdMenuElsewhere(() => {
    if (session.menu !== null && session.phase !== "done") void closeMenuPanel(session.menu, "outside").catch(() => undefined);
  });
  current = session;

  void (async () => {
    await listenSession();
    let menu: number;
    try {
      const ticket = await withDeadline(
        openInMenuPanel({ anchor, payload: encodeCardMenuPayload(payload), event_at: options.eventAt }),
        OPEN_DEADLINE_MS,
      );
      menu = ticket.menu;
    } catch (error) {
      refuse(session, "the backend did not take it", error);
      return;
    }
    if (session.phase === "done") {
      // Closed or replaced while the backend answered.
      void closeMenuPanel(menu, session.closeAsked ?? "source").catch(() => undefined);
      return;
    }
    session.menu = menu;
    session.timer = setTimeout(() => refuse(session, `the panel did not show it within ${SHOW_DEADLINE_MS} ms`), SHOW_DEADLINE_MS);
    if (session.early.shown.has(menu)) shown(session);
    const closedEarly = session.early.closed.get(menu);
    if (closedEarly !== undefined) closed(session, closedEarly);
  })();

  return {
    update: (next) => {
      if (session.menu === null || session.phase === "done") return;
      sendToPanel(MENU_PANEL_UPDATE_EVENT, { menu: session.menu, payload: next });
    },
    // The owner closes: it knows, so nothing is reported back, and the
    // backend's word of the closing finds no session.
    close: (reason) => {
      if (session.phase === "done") return;
      if (session.menu === null) session.closeAsked = reason;
      else void closeMenuPanel(session.menu, reason).catch((error: unknown) => logFailure(`${LOG}: close`, error));
      end(session, 0);
    },
  };
}

/** Tests: forget every session and the panel's readiness. */
export function resetMenuPanelSourceForTests(ready = false): void {
  if (current !== null) end(current, 0);
  current = null;
  answerable.clear();
  focusReturnUntil = 0;
  panelReady = ready;
  lastInputAt = null;
}
