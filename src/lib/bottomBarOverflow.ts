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
/// 3. **Situational commands last** (`Focus`, `Command`, and the esc entries).
///    They exist only in the state that offers them, so the bar is the only
///    place they are ever seen — dropping them would hide the one thing the
///    user could not have learned elsewhere.
///
/// Hide order: Navigate → Switch collection → Settings → Hide Sidebar →
/// New Collection → Find elements → Command → Focus. The esc entries never
/// leave: they are the exits, and a state with no visible way out is worse
/// than a crowded bar.

export interface BarEntryMeasurement {
  id: string;
  /// Lower leaves first.
  priority: number;
  /// Last known rendered width, including the entry's own trailing gap.
  width: number;
}

export const BAR_HIDE_PRIORITIES: Record<string, number> = {
  // Reference entries — nothing to press, so nothing is lost.
  navigate: 1,
  "switch-collection": 2,
  // Learned commands — always available, and also in the native menu.
  settings: 3,
  "toggle-sidebar": 4,
  "new-collection": 5,
  "find-elements": 6,
  "commands-overlay": 7,
  // Situational commands — the bar is the only place they are ever shown.
  "element-menu": 8,
  "open-focused": 9,
};

/// Returns the ids to hide so that what remains fits `availableWidth`.
/// `availableWidth` is the room left for the hideable entries after the fixed
/// entries (esc, Find, Settings, Syncing) have taken theirs.
export function computeHiddenBarEntries(
  availableWidth: number,
  entries: readonly BarEntryMeasurement[],
): Set<string> {
  const hidden = new Set<string>();
  let total = entries.reduce((sum, entry) => sum + entry.width, 0);
  const byPriority = [...entries].sort((a, b) => a.priority - b.priority);
  for (const entry of byPriority) {
    if (total <= availableWidth) break;
    hidden.add(entry.id);
    total -= entry.width;
  }
  return hidden;
}
