import { afterEach, describe, expect, it } from "vitest";
import {
  FEED_SHOW_STORAGE_KEY,
  FEED_SORT_STORAGE_KEY,
  getFeedDisplay,
  reloadFeedDisplay,
  setFeedShow,
  setFeedSort,
} from "./feedDisplay";

describe("feed display options (SPEC_FEED_DISPLAY.md, Д18)", () => {
  afterEach(() => {
    window.localStorage.clear();
    reloadFeedDisplay();
  });

  it("starts newest first, in Cards", () => {
    window.localStorage.clear();
    reloadFeedDisplay();
    expect(getFeedDisplay()).toEqual({ sort: "newest", show: "cards" });
  });

  it("reads the retired Mixed as Cards (SPEC_CARD_UNIFIED.md, Е11)", () => {
    window.localStorage.setItem(FEED_SHOW_STORAGE_KEY, "mixed");
    reloadFeedDisplay();
    expect(getFeedDisplay()).toEqual({ sort: "newest", show: "cards" });
  });

  it("keeps the choice for the next launch", () => {
    setFeedSort("oldest");
    setFeedShow("media");
    expect(window.localStorage.getItem(FEED_SORT_STORAGE_KEY)).toBe("oldest");
    expect(window.localStorage.getItem(FEED_SHOW_STORAGE_KEY)).toBe("media");

    // A new launch reads storage afresh.
    reloadFeedDisplay();
    expect(getFeedDisplay()).toEqual({ sort: "oldest", show: "media" });
  });

  it("reads a choice stored before the renaming of 11.11.2026 as it was (Д10, Д18)", () => {
    window.localStorage.setItem(FEED_SHOW_STORAGE_KEY, "cards");
    reloadFeedDisplay();
    expect(getFeedDisplay().show).toBe("cards");
    window.localStorage.setItem(FEED_SHOW_STORAGE_KEY, "media");
    reloadFeedDisplay();
    expect(getFeedDisplay().show).toBe("media");
  });

  it("keeps Media Only for the next launch (Д31)", () => {
    setFeedShow("media-only");
    expect(window.localStorage.getItem(FEED_SHOW_STORAGE_KEY)).toBe("media-only");
    setFeedShow("cards");
    window.localStorage.setItem(FEED_SHOW_STORAGE_KEY, "media-only");
    reloadFeedDisplay();
    expect(getFeedDisplay()).toEqual({ sort: "newest", show: "media-only" });
  });

  it("ignores the retired media placement a launch may still find (Д19)", () => {
    window.localStorage.setItem("mine.feed.media", "inset");
    reloadFeedDisplay();
    expect(getFeedDisplay()).toEqual({ sort: "newest", show: "cards" });
  });

  it("reads a damaged value as the default", () => {
    window.localStorage.setItem(FEED_SORT_STORAGE_KEY, "sideways");
    window.localStorage.setItem(FEED_SHOW_STORAGE_KEY, "{broken");
    reloadFeedDisplay();
    expect(getFeedDisplay()).toEqual({ sort: "newest", show: "cards" });
  });
});
