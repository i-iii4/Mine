import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FeedScrollAuditRoute } from "./FeedScrollAuditRoute";

/// The feed scroll gate (scripts/feed-scroll-audit.mjs) waits for this route's
/// marker and reads the block count it announces before it scrolls.
describe("FeedScrollAuditRoute", () => {
  it("mounts the synthetic feed and announces its block count", () => {
    const { unmount } = render(<FeedScrollAuditRoute />);
    const route = document.querySelector<HTMLElement>("[data-feed-scroll-audit-route]");
    expect(route?.querySelector("[data-grid-scroll]")).not.toBeNull();
    expect(window.__MINE_FEED_SCROLL_AUDIT_ROUTE__?.blockCount).toBeGreaterThan(0);

    unmount();
    expect(window.__MINE_FEED_SCROLL_AUDIT_ROUTE__).toBeUndefined();
  });
});
