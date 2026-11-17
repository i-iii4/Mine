import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FeedGrowthAuditRoute } from "./FeedGrowthAuditRoute";

/// The feed growth gate (scripts/feed-growth-audit.mjs) drives this route's
/// list through the handle it announces and reads the number of cards held
/// from the route's marker.
describe("FeedGrowthAuditRoute", () => {
  const held = () => Number(
    document.querySelector<HTMLElement>("[data-feed-growth-audit-route]")?.dataset.feedGrowthAuditBlockCount,
  );

  it("grows, cuts and changes its list as the audit asks", () => {
    const { unmount } = render(<FeedGrowthAuditRoute />);
    const handle = window.__MINE_FEED_GROWTH_AUDIT__;
    if (!handle) throw new Error("The route announced no handle");
    expect(document.querySelector("[data-feed-growth-audit-route] [data-grid-scroll]")).not.toBeNull();
    expect(held()).toBe(0);

    act(() => handle.load(40));
    expect(handle.loaded()).toBe(40);
    expect(held()).toBe(40);

    let measure = { listMs: -1, feedMs: -1 };
    act(() => { measure = handle.appendPage(20); });
    expect(handle.loaded()).toBe(60);
    expect(held()).toBe(60);
    expect(measure.listMs).toBeGreaterThanOrEqual(0);
    expect(measure.feedMs).toBeGreaterThanOrEqual(0);

    act(() => handle.truncate(40));
    expect(handle.loaded()).toBe(40);

    // The first card is a picture: its row arrives changed, the list keeps its length.
    act(() => { measure = handle.changeCard(0); });
    expect(handle.loaded()).toBe(40);
    expect(measure.feedMs).toBeGreaterThanOrEqual(0);
    // The eleventh card is a saved page: the audit changes pictures only.
    expect(() => handle.changeCard(10)).toThrow("No picture card at 10");

    unmount();
    expect(window.__MINE_FEED_GROWTH_AUDIT__).toBeUndefined();
  });
});
