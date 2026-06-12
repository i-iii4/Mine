import { describe, expect, it } from "vitest";
import { groupByRecency, recencyBucketLabel } from "./recencyBuckets";

// Fixed local reference: Friday 12.06.2026, 15:00 local time.
const NOW = new Date(2026, 5, 12, 15, 0, 0);

function label(date: Date): string {
  return recencyBucketLabel(date, NOW);
}

describe("recencyBucketLabel", () => {
  it("uses local calendar days, not sliding 24h windows", () => {
    expect(label(new Date(2026, 5, 12, 0, 0, 1))).toBe("Today");
    expect(label(new Date(2026, 5, 12, 14, 59))).toBe("Today");
    // 23:59 yesterday is Yesterday even though it is less than 24h ago.
    expect(label(new Date(2026, 5, 11, 23, 59))).toBe("Yesterday");
    expect(label(new Date(2026, 5, 11, 0, 0))).toBe("Yesterday");
  });

  it("buckets the past week and month", () => {
    expect(label(new Date(2026, 5, 10, 12, 0))).toBe("Past 7 days");
    expect(label(new Date(2026, 5, 5, 0, 0))).toBe("Past 7 days");
    expect(label(new Date(2026, 5, 4, 23, 59))).toBe("Past 30 days");
    expect(label(new Date(2026, 4, 13, 0, 0))).toBe("Past 30 days");
  });

  it("falls back to month names within the year and bare years earlier", () => {
    expect(label(new Date(2026, 4, 1, 12, 0))).toBe("May");
    expect(label(new Date(2026, 0, 2, 12, 0))).toBe("January");
    expect(label(new Date(2025, 11, 31, 12, 0))).toBe("2025");
    expect(label(new Date(2023, 2, 1, 12, 0))).toBe("2023");
  });
});

describe("groupByRecency", () => {
  it("groups a newest-first list into ordered labeled sections", () => {
    const items = [
      { slug: "a", saved_at: new Date(2026, 5, 12, 10, 0).toISOString() },
      { slug: "b", saved_at: new Date(2026, 5, 11, 10, 0).toISOString() },
      { slug: "c", saved_at: new Date(2026, 5, 11, 9, 0).toISOString() },
      { slug: "d", saved_at: new Date(2026, 4, 1, 9, 0).toISOString() },
    ];
    const groups = groupByRecency(items, (item) => item.saved_at, NOW);
    expect(groups.map((group) => group.label)).toEqual(["Today", "Yesterday", "May"]);
    expect(groups[1]!.items.map((item) => item.slug)).toEqual(["b", "c"]);
  });

  it("keeps items with unparsable dates in the last open group", () => {
    const items = [
      { slug: "a", saved_at: new Date(2026, 5, 12, 10, 0).toISOString() },
      { slug: "broken", saved_at: "not-a-date" },
    ];
    const groups = groupByRecency(items, (item) => item.saved_at, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((item) => item.slug)).toEqual(["a", "broken"]);
  });
});
