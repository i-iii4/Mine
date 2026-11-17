// Cards dragged in another window of Mine over this page
// (SPEC_OUTSIDE_WINDOW.md, ПК4, ПК8): the backend says where the pointer is on
// this page, and this page finds what of it is there. The events are the
// backend's (src-tauri/src/tabs/drag.rs).

/** Dragged cards are over this page, or left it (`CardDragOver`). */
export const CARD_DRAG_OVER_EVENT = "card-drag-over";
/** Dragged cards were let go over this page (`CardDragDrop`). */
export const CARD_DRAG_DROP_EVENT = "card-drag-drop";
/** This window's bar takes cards once `Open N tabs?` is answered (`CardTabsConfirm`). */
export const CARD_TABS_CONFIRM_EVENT = "card-tabs-confirm";

/** The open collection whose feed or graph is at (`x`, `y`) on this page,
 *  or `null`: the drop target of its right part (`data-open-collection-drop`,
 *  App.tsx), which stands only while a collection is open and no card covers
 *  it. The target lets the pointer through, so it is found by its box, not by
 *  `elementsFromPoint`. */
export function openCollectionAt(x: number, y: number): string | null {
  const target = document.querySelector<HTMLElement>("[data-open-collection-drop]");
  if (!target) return null;
  const box = target.getBoundingClientRect();
  const inside = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
  return inside ? target.dataset.openCollectionDrop ?? null : null;
}

/** Whether the sidebar's filter is at (`x`, `y`) on this page: cards dropped
 *  on it found an untitled collection (decision of 16.11.2026). */
export function sidebarSearchAt(x: number, y: number): boolean {
  return document.elementsFromPoint(x, y).some((element) => element.closest("[data-sidebar-search-drop]") !== null);
}

/** The collection row of the sidebar at (`x`, `y`) on this page, by its key
 *  (`tag:<name>`), or `null` over anything else: only a collection's row
 *  takes cards from another window (ПК4). The row is found as the drag of
 *  this page finds it, the topmost row under the point (`sidebarPointerWithin`). */
export function collectionRowAt(x: number, y: number): string | null {
  for (const element of document.elementsFromPoint(x, y)) {
    const row = element.closest<HTMLElement>("[data-sidebar-row]");
    if (!row) continue;
    const key = row.dataset.sidebarRowKey ?? null;
    return key?.startsWith("tag:") ? key : null;
  }
  return null;
}
