// TRIAL (SPEC_MENU_WINDOW.md; DESIGN_SYSTEM.md, «Меню карточки в отдельном
// окне: проба»): a page's side of the menu panel. The page opens one menu
// there at a time, described as data (`MenuSpec`), runs each choice made in
// it with its own handlers, and keeps the rules of an open menu on its page
// meanwhile (src/lib/openMenus.ts).
//
// An opening is asked for in the input's own handler, before React draws
// anything: the backend shows the panel in that one step. Every failure
// leaves the menu on the page as before: the panel not made, not found
// clear or not ready, the backend refusing, a panel that drew nothing in
// time (`unresponsive`) or could not draw it (`failed`). The caller then
// opens its own menu (`onRefused`), the same description drawn on the page.
//
// Nothing here is told by time (SPEC_MENU_WINDOW.md, section 5). The page
// numbers its menus itself, so it knows a menu's number before the backend
// has said a word of it, and whatever comes about a menu names that number:
// the answer to the opening, the choices made in the panel and the closing
// may come in any order between them. The backend's messages of one menu
// are counted, and the page takes them in that order (`MessageRow`): a
// choice made before the menu closed is carried out before the menu is
// forgotten, however the two arrive.
//
// Who closes a menu (МО41, МО42): the one that opened it, with the handle
// `openMenuPanel` gives, where it takes the menu away itself and when it
// unmounts. A component that is there because the menu is open never closes
// it in an effect's cleanup: React runs that cleanup once on mount in
// StrictMode, and the menu would close the moment it opened.

import type {
  MenuAction,
  MenuAnswer,
  MenuOpener,
  MenuPanelCloseReason,
  MenuPanelSourceMessage,
  MenuPanelStatus,
  MenuPanelToSource,
  MenuSpec,
  ScreenRect,
} from "@/types";
import { logFailure } from "./appLog";
import { menuMode, MENU_MODE_STORAGE_KEY, parseMenuMode } from "./menuMode";
import { menuSpecSize } from "./menuSpec";
import {
  answerMenuPanel,
  closeMenuPanel,
  disposeMenuPanelWindow,
  openInMenuPanel,
  prepareMenuPanelWindow,
  updateMenuInPanel,
} from "./menuPanelCommands";
import { MENU_PANEL_STATUS_EVENT, MENU_PANEL_TO_SOURCE_EVENT, MessageRow } from "./menuPanelProtocol";
import { holdContextMenuPresence, holdMenuElsewhere } from "./openMenus";
import { listenPage } from "./pageEvents";
import { SETTINGS_CHANGED_EVENT, type SettingsChangedPayload } from "./settingsChanged";

const LOG = "Menu panel";

/** This page's load. A page loaded anew counts its menus from one again,
 *  and the backend tells the two counts apart by this (МО39). */
const PAGE = crypto.randomUUID();

let panelReady = false;
let following = false;
let watching = false;

function now(): number {
  return performance.timeOrigin + performance.now();
}

/**
 * When the input being handled right now came, in epoch milliseconds, or
 * null outside an input's handler: the opening is then measured from its
 * request, and the log says so. `performance.timeOrigin` is wall time, as
 * the backend's and the panel's clocks are.
 */
export function currentInputAt(): number | null {
  // The event whose listeners run now; the one browser API that names it.
  const event = window.event;
  return event === undefined ? null : performance.timeOrigin + event.timeStamp;
}

/** Whether a menu opening now goes to the panel. */
export function menuPanelUsable(): boolean {
  return panelReady && menuMode() === "window";
}

async function prepare(): Promise<void> {
  try {
    const status = await prepareMenuPanelWindow(PAGE);
    panelReady = status.ready;
  } catch (error) {
    panelReady = false;
    logFailure(`${LOG}: the panel was not made`, error);
  }
}

async function dispose(): Promise<void> {
  panelReady = false;
  try {
    await disposeMenuPanelWindow();
  } catch (error) {
    logFailure(`${LOG}: the panel was not taken away`, error);
  }
}

/**
 * A page's entry: hears the panel's readiness, has the panel made when
 * the menu mode is `window`, now or once it is chosen, and taken away once
 * `web` is. A second call does nothing.
 */
export function followMenuPanel(): void {
  if (following) return;
  following = true;
  watchSessions();
  void listenPage<MenuPanelStatus>(MENU_PANEL_STATUS_EVENT, (event) => {
    panelReady = event.payload.ready;
  }).catch(() => {
    // Outside a Tauri page there is no panel: the menu stays on the page.
  });
  void listenPage<SettingsChangedPayload>(SETTINGS_CHANGED_EVENT, (event) => {
    if (event.payload.key !== MENU_MODE_STORAGE_KEY) return;
    if (parseMenuMode(event.payload.value ?? null) === "window") void prepare();
    else void dispose();
  }).catch(() => undefined);
  if (menuMode() === "window") void prepare();
}

// ── The open session ──────────────────────────────────────────────────────

/** A menu for the panel: what it holds, and how it was opened. */
export interface MenuPanelMenu {
  spec: MenuSpec;
  /** The menu at its largest while open, when it may grow past `spec`: a
   *  line of text that may come. The panel's frame is set once for an
   *  opening, by this (SPEC_MENU_WINDOW.md, МО28, МО29). */
  largest?: MenuSpec;
  /** A key opened the menu: it lands at once and lights its first row
   *  (SPEC_MOTION_LEVELS.md, УД4). */
  byKey: boolean;
}

export interface MenuPanelHandlers {
  /** Carry out a choice made in the panel; its answer goes back. */
  onAction: (action: MenuAction) => MenuAnswer | Promise<MenuAnswer>;
  /** The menu showed and closed now, not by its owner's `close`. */
  onClosed: (reason: MenuPanelCloseReason) => void;
  /** The menu did not show in the panel: open it on the page. */
  onRefused: () => void;
}

/** The handle of an open menu: its owner's alone (МО41). */
export interface MenuPanelSession {
  /** Send what changed in the menu while it is open: the whole menu again. */
  update: (spec: MenuSpec) => void;
  /** Close the menu, if it is still open; `onClosed` is not called. */
  close: (reason: MenuPanelCloseReason) => void;
}

interface Session {
  /** The menu's number, this page's own count (МО34). */
  menu: number;
  /**
   * `opening`: asked, no word of it yet. `shown`: the backend said it shows,
   * or sent a message of it. `closing`: its owner closed it, and the
   * backend's word of what the closing came to is on its way. `done`: over.
   */
  phase: "opening" | "shown" | "closing" | "done";
  handlers: MenuPanelHandlers;
  /** The backend's messages of this menu, in the order of their count. */
  row: MessageRow<MenuPanelToSource>;
  releaseGuard: () => void;
  releasePresence: (() => void) | null;
  /** The last change sent while the backend had said nothing of the menu:
   *  it goes once the menu shows. */
  pendingUpdate: MenuSpec | null;
  /** The count of the changes sent, the number of the last. */
  changes: number;
  /** The window's focus came while the menu was up or closing: the panel
   *  giving the keyboard back, already counted. */
  focusSeen: boolean;
}

/** The page's count of its openings. */
let lastMenu = 0;
/** The menus not yet over, by number. */
const sessions = new Map<number, Session>();
/** The page's open menu: one at a time. */
let current: Session | null = null;
/** The backend said it gave the keyboard back to this page's window, and
 *  the focus that brings has not come yet. */
let keyReturnPending = false;
/** The window's last focus was the panel giving the keyboard back. */
let focusFromPanel = false;
let listening: Promise<void> | null = null;

/**
 * Whether the focus this page's window got last is it taking the keyboard
 * back from the panel, not a return to the app: asked in a `focus` handler.
 * The reactions to coming back to the app skip it (SPEC_TABS.md, В42;
 * SPEC_MENU_WINDOW.md, МО48).
 */
export function focusReturnsFromMenuPanel(): boolean {
  return focusFromPanel;
}

/** The window got the keyboard. While a menu of this page is up or closing,
 *  or the backend said it gave the keyboard back, the panel gave it. */
function onWindowFocus(): void {
  if (sessions.size === 0 && !keyReturnPending) {
    focusFromPanel = false;
    return;
  }
  focusFromPanel = true;
  keyReturnPending = false;
  for (const session of sessions.values()) session.focusSeen = true;
}

/** The window lost the keyboard: a return of it promised before is void.
 *  The next focus then counts as a return to the app, which costs a reading
 *  of the disk at most, never a missed one. */
function onWindowBlur(): void {
  focusFromPanel = false;
  keyReturnPending = false;
}

/** Take the menu off the page: its rules of an open menu end, and the page
 *  may open another. The backend's last word of it may still come. */
function release(session: Session): void {
  session.releasePresence?.();
  session.releasePresence = null;
  session.releaseGuard();
  session.releaseGuard = () => undefined;
  if (current === session) current = null;
}

/** The menu is over: nothing more is heard of it. */
function forget(session: Session): void {
  release(session);
  session.phase = "done";
  if (sessions.get(session.menu) === session) sessions.delete(session.menu);
}

/** The menu will not show in the panel: the page opens its own, unless its
 *  owner has closed it meanwhile. */
function refuse(session: Session, why: string, error?: unknown): void {
  if (session.phase === "done") return;
  const ownerWaits = session.phase !== "closing";
  forget(session);
  logFailure(`${LOG}: opened on the page, ${why}`, error ?? why);
  if (ownerWaits) session.handlers.onRefused();
}

/** The backend has said a word of the menu: it shows. */
function shown(session: Session): void {
  if (session.phase !== "opening") return;
  session.phase = "shown";
  if (session.pendingUpdate !== null) {
    const spec = session.pendingUpdate;
    session.pendingUpdate = null;
    sendUpdate(session, spec);
  }
}

function sendUpdate(session: Session, spec: MenuSpec): void {
  session.changes += 1;
  void updateMenuInPanel(session.menu, session.changes, spec)
    .catch((error: unknown) => logFailure(`${LOG}: a change did not reach the panel`, error));
}

/** The keyboard the backend gave back brings a focus of the window: unless
 *  it came already, the next one is the panel's. */
function expectKeyReturn(session: Session, keyReturned: boolean): void {
  if (keyReturned && !session.focusSeen) keyReturnPending = true;
}

/** The answer to a choice whose handler failed: the choice was not made. */
function failedAnswer(action: MenuAction): MenuAnswer {
  if (action.kind !== "widget") return { kind: "done" };
  switch (action.action.kind) {
    case "toggle_collection":
    case "connect_cards":
      return { kind: "membership", made: false };
    case "check_collection_name":
      return { kind: "name_refusal", reason: null };
    case "create_card":
      return { kind: "failed", message: "Could not complete this action. Please try again." };
    // An asking with nothing to answer but that it is over.
    default:
      return { kind: "done" };
  }
}

async function answer(session: Session, request: number, action: MenuAction): Promise<void> {
  let reply: MenuAnswer;
  try {
    reply = await session.handlers.onAction(action);
  } catch (error) {
    logFailure(`${LOG}: a choice failed`, error);
    reply = failedAnswer(action);
  }
  // A menu that closed meanwhile hears no answer: the backend would drop it.
  if (session.phase !== "shown") return;
  void answerMenuPanel(session.menu, request, reply)
    .catch((error: unknown) => logFailure(`${LOG}: an answer did not reach the panel`, error));
}

/** One message of the backend's, its turn come. */
function apply(session: Session, body: MenuPanelToSource): void {
  if (body.kind === "action") {
    // Its owner closed the menu: a choice made in it since is dropped.
    if (session.phase !== "shown") return;
    void answer(session, body.request, body.action);
    return;
  }
  expectKeyReturn(session, body.key_returned);
  // Its owner closed it: it knows, and hears nothing.
  if (session.phase === "closing") {
    forget(session);
    return;
  }
  // The panel drew nothing in time or could not draw it: the page opens it.
  if (body.reason === "unresponsive" || body.reason === "failed") {
    refuse(session, `the panel's page answered ${body.reason}`);
    return;
  }
  forget(session);
  session.handlers.onClosed(body.reason);
}

function hear(message: MenuPanelSourceMessage): void {
  const session = sessions.get(message.menu);
  if (session === undefined) return;
  // A message of the menu is the backend's word that it shows.
  shown(session);
  for (const body of session.row.take(message.seq, message.body)) {
    if (session.phase === "done") return;
    apply(session, body);
  }
}

/** Hear the backend's messages of this page's menus and the window's focus. */
function watchSessions(): Promise<void> {
  if (!watching) {
    watching = true;
    // Before any other listener of the window's focus hears it.
    window.addEventListener("focus", onWindowFocus, true);
    window.addEventListener("blur", onWindowBlur, true);
  }
  if (listening) return listening;
  listening = listenPage<MenuPanelSourceMessage>(MENU_PANEL_TO_SOURCE_EVENT, (event) => hear(event.payload)).then(
    () => undefined,
    // Outside a Tauri page: nothing opens in a panel.
    () => undefined,
  );
  return listening;
}

/** The owner closes its menu: off the page at once, and over when the
 *  backend says what the closing came to. */
function closeByOwner(session: Session, reason: MenuPanelCloseReason): void {
  if (session.phase === "done" || session.phase === "closing") return;
  session.phase = "closing";
  release(session);
  closeMenuPanel(PAGE, session.menu, reason).then(
    (outcome) => {
      // The backend's message of the closing may have come first.
      if (session.phase === "done") return;
      expectKeyReturn(session, outcome.key_returned);
      forget(session);
    },
    (error: unknown) => {
      logFailure(`${LOG}: close`, error);
      forget(session);
    },
  );
}

/**
 * Open `menu` in the panel, anchored to `anchor` in this page's coordinates
 * (a button's plate, or the point of a right click as a rectangle of no
 * size). The request leaves before this returns: call it in
 * the input's handler. A menu already open from this page closes first, and
 * its owner hears. Until the menu closes the page keeps an open menu's
 * rules; a right click's menu also holds the pointer's answers
 * (`contextMenu`). `eventAt` is when the input came (`currentInputAt`), or
 * null when no input's event is at hand.
 */
export function openMenuPanel(
  anchor: ScreenRect,
  opener: MenuOpener,
  menu: MenuPanelMenu,
  handlers: MenuPanelHandlers,
  options: { contextMenu: boolean; eventAt: number | null },
): MenuPanelSession {
  void watchSessions();
  if (current !== null) {
    const previous = current;
    closeByOwner(previous, "source");
    previous.handlers.onClosed("source");
  }
  lastMenu += 1;
  const session: Session = {
    menu: lastMenu,
    phase: "opening",
    handlers,
    row: new MessageRow(),
    releaseGuard: () => undefined,
    releasePresence: options.contextMenu ? holdContextMenuPresence() : null,
    pendingUpdate: null,
    changes: 0,
    focusSeen: false,
  };
  // A press that reaches this page while the menu is up only closes it. The
  // backend holds such presses back itself (МО43); this is the page's own
  // rule of an open menu, kept for a press the backend did not see.
  session.releaseGuard = holdMenuElsewhere(() => {
    if (session.phase !== "shown") return;
    void closeMenuPanel(PAGE, session.menu, "outside").catch(() => undefined);
  });
  sessions.set(session.menu, session);
  current = session;

  const { size, submenus } = menuSpecSize(menu.largest ?? menu.spec);
  openInMenuPanel({
    page: PAGE,
    menu: session.menu,
    anchor,
    opener,
    spec: menu.spec,
    by_key: menu.byKey,
    // The dev button style of this window (src/lib/buttonStyle.ts).
    buttons: document.documentElement.getAttribute("data-buttons"),
    size,
    submenus,
    event_at: options.eventAt,
    sent_at: now(),
  }).then(
    () => shown(session),
    (error: unknown) => refuse(session, "the backend did not take it", error),
  );

  return {
    update: (next) => {
      if (session.phase === "opening") session.pendingUpdate = next;
      else if (session.phase === "shown") sendUpdate(session, next);
    },
    // The owner closes: it knows, so nothing is reported back.
    close: (reason) => closeByOwner(session, reason),
  };
}

/** Tests: forget every session and the panel's readiness. */
export function resetMenuPanelSourceForTests(ready = false): void {
  for (const session of [...sessions.values()]) forget(session);
  sessions.clear();
  current = null;
  lastMenu = 0;
  keyReturnPending = false;
  focusFromPanel = false;
  panelReady = ready;
}
