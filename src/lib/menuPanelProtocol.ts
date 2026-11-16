// TRIAL (SPEC_MENU_WINDOW.md; DESIGN_SYSTEM.md, «Меню карточки в отдельном
// окне: проба»): what a page a menu opened on and the menu panel say to each
// other.
//
// Every message passes through the backend, the one place that sets their
// order (SPEC_MENU_WINDOW.md, section 5). The page numbers the menu itself
// and asks the backend to open it (`menu_panel_open`) with the anchor, the
// menu as data and the size it counts from that; the backend lays the menu
// out, moves the panel there, gives it the keyboard and tells the panel's
// page to draw it. The panel's page asks the backend for each choice to be
// carried out and for the menu to close (`menu_panel_request`), in the order
// of its own count; the backend passes the choice to the page, which runs it
// with its own handlers and answers (`menu_panel_answer`), and sends what
// changed in the menu (`menu_panel_update`). What the backend says to either
// page carries the menu's number and a count of its own, and the page takes
// the messages in that order (`MessageRow`); the closing is the last of them.
//
// The shapes of the messages, of a menu, of a choice and of its answer are
// the backend's (src-tauri/src/menu_panel, src/types/generated.ts): the
// backend reads a menu when it takes it, so the panel's page draws only what
// is one.

export const MENU_PANEL_LABEL = "menu-panel";

/** What the backend says to the page a menu came from (`MenuPanelSourceMessage`). */
export const MENU_PANEL_TO_SOURCE_EVENT = "menu-panel-to-source";
/** What the backend says to the panel's page (`MenuPanelPageMessage`). */
export const MENU_PANEL_TO_PAGE_EVENT = "menu-panel-to-page";
export const MENU_PANEL_STATUS_EVENT = "menu-panel-status";

/**
 * The messages of one row taken in the order of their numbers, from one
 * (SPEC_MENU_WINDOW.md, МО36): a number already taken is dropped, a number
 * ahead waits for the ones before it. No time ends the wait: the missing
 * message does, or the menu's closing, which drops the row.
 */
export class MessageRow<T> {
  private next = 1;
  private readonly held = new Map<number, T>();

  /** Take the message `number`: every message now due, in order. */
  take(number: number, message: T): T[] {
    if (number < this.next || this.held.has(number)) return [];
    this.held.set(number, message);
    const due: T[] = [];
    for (let held = this.held.get(this.next); held !== undefined; held = this.held.get(this.next)) {
      this.held.delete(this.next);
      this.next += 1;
      due.push(held);
    }
    return due;
  }
}
