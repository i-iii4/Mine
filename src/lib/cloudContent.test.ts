import { describe, expect, it } from "vitest";
import { CLOUD_BADGE_DELAY_MS, shouldShowCloudBadge } from "./cloudContent";

describe("shouldShowCloudBadge", () => {
  it("stays hidden during ordinary fast loading", () => {
    // A card that fills in quickly must never flash a badge: the explanation
    // would be gone before it could be read, leaving only visual noise.
    expect(shouldShowCloudBadge(true, 0)).toBe(false);
    expect(shouldShowCloudBadge(true, CLOUD_BADGE_DELAY_MS - 1)).toBe(false);
  });

  it("appears once waiting is long enough to need an explanation", () => {
    expect(shouldShowCloudBadge(true, CLOUD_BADGE_DELAY_MS)).toBe(true);
    expect(shouldShowCloudBadge(true, CLOUD_BADGE_DELAY_MS * 10)).toBe(true);
  });

  it("never appears for content that is on this Mac", () => {
    // Slow disks and slow decoding are not iCloud, and saying so would be a lie.
    expect(shouldShowCloudBadge(false, CLOUD_BADGE_DELAY_MS * 10)).toBe(false);
  });
});
