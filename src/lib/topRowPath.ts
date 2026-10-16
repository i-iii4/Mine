// What the path in the top row over the feed shows (DESIGN_SYSTEM.md,
// «Верхние ряды»; SPEC_NARROW_WINDOW.md, У15). The path names the place (a
// collection, Everything or an author) by its switcher, then an open card by
// its name past a line. In a narrow window, where the sidebar lies over the
// feed (У1), an open card's name with its menu and close button takes the
// whole row: the place's switcher leaves the row while the name stands in
// it. With no card, or in a wider window, the row is as it always was.

/** Whether the place's switcher stands in the top row: always, except in a
 *  narrow window (`narrow`, `sidebarOverlaid`) while an open card's name is
 *  in the row (`cardOpen`, through the name's exit). */
export function topRowShowsPlace(narrow: boolean, cardOpen: boolean): boolean {
  return !(narrow && cardOpen);
}
