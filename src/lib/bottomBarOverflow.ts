/// Which bottom-bar entries give way when the window narrows.
///
/// The bar never truncates an entry: an entry is either whole or absent.
/// Entries carry a hide priority — the lowest number leaves first — and the
/// order is fixed by decision, not by measurement: reference entries teach and
/// go first, commands that act stay longest, and the esc entries, Find and
/// Settings never leave at all (they carry state feedback and the bar's exits).
///
/// Hide order: Navigate → Switch collection → Command → Focus →
/// New Collection → Hide Sidebar.

export interface BarEntryMeasurement {
  id: string;
  /// Lower leaves first.
  priority: number;
  /// Last known rendered width, including the entry's own trailing gap.
  width: number;
}

export const BAR_HIDE_PRIORITIES: Record<string, number> = {
  navigate: 1,
  "switch-collection": 2,
  "element-menu": 3,
  "open-focused": 4,
  "new-collection": 5,
  "toggle-sidebar": 6,
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
