// Undo, Redo and Select All of the Edit menu in this page (SPEC_EDITING.md,
// Л12). The menu is the backend's, and a tab page is a child webview: its ⌘
// keys reach the menu first, and the system's undo knows nothing of the
// edits the note editor makes. So the page tells the backend whether one of
// its note editors holds the focus and what that editor's history can do
// (`report_focused_editor`), whenever either changes; the backend sends
// `edit-menu-command` here only while it holds the focus, and enables Undo
// and Redo by the history. Anywhere else the backend sends the stock items'
// actions, and nothing of this module takes part.
//
// A command that comes once the editor has lost the focus does what the
// stock item would have done to the field in focus (`document.execCommand`).
// The module listens only while an editor of the page is registered.

import type { EditMenuCommand, FocusedEditor } from "@/types";
import { logFailure } from "./appLog";
import { reportFocusedEditor } from "./commands";
import { listenPage } from "./pageEvents";

/** The event of a command of the Edit menu for this page's editor. */
export const EDIT_MENU_EVENT = "edit-menu-command";

/** The log line of a report the backend did not take. */
export const EDIT_MENU_LOG = "Could not report the note editor's focus";

/** The editing command of the page that the stock item's action runs. */
const PAGE_COMMANDS: Record<EditMenuCommand, string> = {
  undo: "undo",
  redo: "redo",
  select_all: "selectAll",
};

/** A note editor of this page as the Edit menu sees it. */
export interface EditMenuEditor {
  /** Whether the editor, or a part of it such as a cell's editor, holds the
   *  page's focus. */
  hasFocus(): boolean;
  /** What its history can do now. */
  history(): FocusedEditor;
  /** Carry out `command`. */
  run(command: EditMenuCommand): void;
}

const editors = new Set<EditMenuEditor>();
/** What the backend heard last: nothing holds the focus when a page starts
 *  (`get_tab_bootstrap` forgets the page's earlier report). */
let reported: FocusedEditor | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let unlistenCommands: Promise<() => void> | null = null;

function focusedEditor(): EditMenuEditor | null {
  if (!document.hasFocus()) return null;
  for (const editor of editors) {
    if (editor.hasFocus()) return editor;
  }
  return null;
}

function sameReport(a: FocusedEditor | null, b: FocusedEditor | null): boolean {
  if (a === null || b === null) return a === b;
  return a.can_undo === b.can_undo && a.can_redo === b.can_redo;
}

/** Tell the backend what holds the focus now and what its history can do,
 *  when that changed. An editor calls it after each of its updates. */
export function refreshEditMenu(): void {
  const editor = focusedEditor();
  const next = editor ? editor.history() : null;
  if (sameReport(next, reported)) return;
  reported = next;
  void reportFocusedEditor(next).catch((error: unknown) => logFailure(EDIT_MENU_LOG, error));
}

/** The focus moves in two steps (out, then in): the report waits for the
 *  page to settle. */
function scheduleRefresh() {
  if (refreshTimer !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshEditMenu();
  }, 0);
}

function carryOut(command: EditMenuCommand) {
  const editor = focusedEditor();
  if (editor) {
    editor.run(command);
    refreshEditMenu();
    return;
  }
  // The focus left the editor before the command came: the field in focus
  // takes it, as from the stock item. `execCommand` is the page's way to
  // the same editing command; it has no successor.
  document.execCommand(PAGE_COMMANDS[command]);
}

function listen() {
  document.addEventListener("focusin", scheduleRefresh, true);
  document.addEventListener("focusout", scheduleRefresh, true);
  document.addEventListener("visibilitychange", scheduleRefresh);
  window.addEventListener("focus", scheduleRefresh);
  window.addEventListener("blur", scheduleRefresh);
  unlistenCommands = listenPage<EditMenuCommand>(EDIT_MENU_EVENT, (event) => carryOut(event.payload));
}

function stopListening() {
  document.removeEventListener("focusin", scheduleRefresh, true);
  document.removeEventListener("focusout", scheduleRefresh, true);
  document.removeEventListener("visibilitychange", scheduleRefresh);
  window.removeEventListener("focus", scheduleRefresh);
  window.removeEventListener("blur", scheduleRefresh);
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  const unlisten = unlistenCommands;
  unlistenCommands = null;
  void unlisten?.then((stop) => stop(), (error: unknown) => logFailure(EDIT_MENU_LOG, error));
}

/** Let the Edit menu reach `editor` while it holds the focus. Returns the
 *  release: the editor's session is over. */
export function registerEditMenuEditor(editor: EditMenuEditor): () => void {
  if (editors.size === 0) listen();
  editors.add(editor);
  refreshEditMenu();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    editors.delete(editor);
    refreshEditMenu();
    if (editors.size === 0) stopListening();
  };
}
