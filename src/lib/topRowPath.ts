// What the path in the top row over the feed shows (DESIGN_SYSTEM.md,
// «Верхние ряды»; SPEC_NARROW_WINDOW.md, У15). The path names the place (a
// collection, Everything or an author) by its switcher, then an open card by
// its name past a line. While a card is open, its name, menu and close button
// stand in the row without the place's switcher wherever something else
// shows the place: in a narrow window, where the sidebar lies over the feed
// (У1), and while the sidebar stands beside the feed, open (user's decision
// of 23.10.2026). With no card, or with the sidebar collapsed in a wider
// window, the row is as it always was.

/** Whether the place's switcher stands in the top row: always, except while
 *  an open card's name is in the row (`cardOpen`, through the name's exit) in
 *  a narrow window (`narrow`, `sidebarOverlaid`) or beside the open sidebar
 *  (`sidebarBeside`). */
export function topRowShowsPlace({
  narrow,
  sidebarBeside,
  cardOpen,
}: {
  narrow: boolean;
  sidebarBeside: boolean;
  cardOpen: boolean;
}): boolean {
  return !(cardOpen && (narrow || sidebarBeside));
}
