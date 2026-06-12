// Dynamic date buckets for the recent list (Notion/Apple Mail convention):
// Today · Yesterday · Past 7 days · Past 30 days · month names for the
// current year · bare years for earlier. Day boundaries are the user's local
// midnight — "Today" is a calendar day, not a sliding 24h window.

export interface RecencyGroup<T> {
  label: string;
  items: T[];
}

const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", { month: "long" });

function startOfLocalDay(date: Date): number {
  const local = new Date(date);
  local.setHours(0, 0, 0, 0);
  return local.getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function recencyBucketLabel(savedAt: Date, now: Date): string {
  const today = startOfLocalDay(now);
  const saved = savedAt.getTime();

  if (saved >= today) return "Today";
  if (saved >= today - DAY_MS) return "Yesterday";
  if (saved >= today - 7 * DAY_MS) return "Past 7 days";
  if (saved >= today - 30 * DAY_MS) return "Past 30 days";
  if (savedAt.getFullYear() === now.getFullYear()) {
    return MONTH_FORMAT.format(savedAt);
  }
  return String(savedAt.getFullYear());
}

/**
 * Group an already-sorted (newest first) list into labeled sections, keeping
 * the original order. Items with unparsable dates fall into the last open
 * group, so a bad timestamp can never reorder the list.
 */
export function groupByRecency<T>(
  items: T[],
  savedAtOf: (item: T) => string | null | undefined,
  now: Date,
): RecencyGroup<T>[] {
  const groups: RecencyGroup<T>[] = [];
  for (const item of items) {
    const raw = savedAtOf(item);
    const parsed = raw ? new Date(raw) : null;
    const last = groups.length > 0 ? groups[groups.length - 1] : undefined;
    const label =
      parsed && !Number.isNaN(parsed.getTime())
        ? recencyBucketLabel(parsed, now)
        : last?.label ?? "Earlier";
    if (last && last.label === label) {
      last.items.push(item);
    } else {
      groups.push({ label, items: [item] });
    }
  }
  return groups;
}
