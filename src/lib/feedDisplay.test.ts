import { afterEach, describe, expect, it } from "vitest";
import {
  FEED_MEDIA_STORAGE_KEY,
  FEED_SHOW_STORAGE_KEY,
  FEED_SORT_STORAGE_KEY,
  getFeedDisplay,
  reloadFeedDisplay,
  setFeedMedia,
  setFeedShow,
  setFeedSort,
} from "./feedDisplay";

describe("feed display options (SPEC_FEED_DISPLAY.md, Д18)", () => {
  afterEach(() => {
    window.localStorage.clear();
    reloadFeedDisplay();
  });

  it("starts newest first, mixed, media inset", () => {
    window.localStorage.clear();
    reloadFeedDisplay();
    expect(getFeedDisplay()).toEqual({ sort: "newest", show: "mixed", media: "inset" });
  });

  it("keeps the choice for the next launch", () => {
    setFeedSort("oldest");
    setFeedShow("media");
    setFeedMedia("edge");
    expect(window.localStorage.getItem(FEED_SORT_STORAGE_KEY)).toBe("oldest");
    expect(window.localStorage.getItem(FEED_SHOW_STORAGE_KEY)).toBe("media");
    expect(window.localStorage.getItem(FEED_MEDIA_STORAGE_KEY)).toBe("edge");

    // A new launch reads storage afresh.
    reloadFeedDisplay();
    expect(getFeedDisplay()).toEqual({ sort: "oldest", show: "media", media: "edge" });
  });

  it("stores media inset once it is chosen back (Д19)", () => {
    setFeedMedia("edge");
    setFeedMedia("inset");
    expect(window.localStorage.getItem(FEED_MEDIA_STORAGE_KEY)).toBe("inset");
    reloadFeedDisplay();
    expect(getFeedDisplay().media).toBe("inset");
  });

  it("reads a damaged value as the default", () => {
    window.localStorage.setItem(FEED_SORT_STORAGE_KEY, "sideways");
    window.localStorage.setItem(FEED_SHOW_STORAGE_KEY, "{broken");
    window.localStorage.setItem(FEED_MEDIA_STORAGE_KEY, "EDGE");
    reloadFeedDisplay();
    expect(getFeedDisplay()).toEqual({ sort: "newest", show: "mixed", media: "inset" });
  });
});
