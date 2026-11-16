// A card dragged to the feed's edge leaves the feed where it is (decision of
// 15.11.2026, SPEC_FRONTEND.md, «Лента не прокручивается под перетаскиванием
// карточки»).
//
// The feed is not scrolled by the drag library: its `autoScroll` scrolls only
// the sidebar's list (`canScroll` in App.tsx). WebKit scrolls it itself: the
// default action of a press makes the box the press began in scroll while the
// held pointer stands near or past its edge, whatever the page does with the
// pointer meanwhile (measured in headless WebKit, 15.11.2026: no script
// scrolled the feed, and a press whose default was prevented left it still).
// So a press on a card prevents that default, and does by hand the one thing
// of it a card needs: the focus goes where the press would have put it.

import type { MouseEvent as ReactMouseEvent } from "react";

/** A control inside a card or a thumbnail keeps its own press: its focus,
 *  caret or menu are its business. */
const OWN_PRESS = "button, a[href], input, textarea, select, [contenteditable='true'], [role='menuitem']";

/** Where a press focuses: the nearest element that takes the focus from a
 *  press, as WebKit finds it. */
const FOCUSED_BY_PRESS = "[tabindex]";

/** A press on a draggable card or a sidebar thumbnail: no scroll of its box
 *  under the held pointer; the focus as the press would give it. Only the
 *  primary button, and not on a control inside the card. */
export function holdScrollUnderCardPress(event: ReactMouseEvent<HTMLElement>): void {
  if (event.button !== 0) return;
  const card = event.currentTarget;
  const target = event.target instanceof Element ? event.target : card;
  const control = target.closest(OWN_PRESS);
  if (control !== null && control !== card && card.contains(control)) return;
  event.preventDefault();
  const focusable = target.closest<HTMLElement>(FOCUSED_BY_PRESS);
  if (focusable !== null) {
    if (document.activeElement !== focusable) focusable.focus({ preventScroll: true });
    return;
  }
  // A press on nothing that takes the focus leaves it nowhere, as it does.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}
