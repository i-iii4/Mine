/// Which bottom-bar entries give way when the window narrows.
///
/// The bar never truncates an entry: an entry is either whole or absent.
/// Entries carry a hide priority — the lowest number leaves first — and the
/// order follows what an entry is worth to the person reading the bar:
///
/// 1. **Reference entries first** (`Navigate`, `Switch collection`). They
///    cannot be pressed, so losing them costs no action at all — only a
///    reminder.
/// 2. **Then the commands already learned** (`Hide Sidebar`, `New Collection`,
///    `Settings`, `Find elements`). They are always available, used constantly,
///    and their shortcuts live in the native menu too; the bar is not where
///    anyone rediscovers them.
/// 3. **Situational commands last** (`Focus`, `Command`). They exist only in
///    the state that offers them, and their combos are specific to this app,
///    so the bar is the only place they are ever seen.
///
/// The esc entries sit with the learned commands: `Escape` is the most
/// universally known key in any interface, so its entry is a courtesy, not a
/// lifeline — it leaves before anything the user could only learn here.
///
/// Hide order: Navigate → Switch collection → Close → Clear selection →
/// Settings → Hide Sidebar → New Collection → Find elements → Commands →
/// Command → Focus.
///
/// Only the order lives here. Whether anything must go at all is measured on
/// the bar itself (`scrollWidth > clientWidth`) rather than computed from
/// widths: an arithmetic model of padding, gaps and fixed children was wrong
/// in exactly the way that leaves entries clipped by the window edge.

export const BAR_HIDE_PRIORITIES: Record<string, number> = {
  // Reference entries — nothing to press, so nothing is lost.
  navigate: 1,
  "switch-collection": 2,
  // Escape — known everywhere, needs no reminder here.
  "close-element": 3,
  "clear-selection": 4,
  // Learned commands — always available, and also in the native menu.
  settings: 5,
  "toggle-sidebar": 6,
  "new-collection": 7,
  "find-elements": 8,
  "commands-overlay": 9,
  // Situational commands — the bar is the only place they are ever shown.
  "element-menu": 10,
  "open-focused": 11,
};
