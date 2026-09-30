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

  it("starts newest first and mixed", () => {
    window.localStorage.clear();
    reloadFeedDisplay();
    expect(getFeedDisplay()).toEqual({ sort: "newest", show: "mixed" });
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

  it("reads a damaged value as the default", () => {
    window.localStorage.setItem(FEED_SORT_STORAGE_KEY, "sideways");
    window.localStorage.setItem(FEED_SHOW_STORAGE_KEY, "{broken");
    reloadFeedDisplay();
    expect(getFeedDisplay()).toEqual({ sort: "newest", show: "mixed" });
  });
});
