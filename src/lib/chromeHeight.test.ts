import { afterEach, describe, expect, it } from "vitest";
import {
  applyChromeRowHeight,
  CHROME_ROW_VARIANTS,
  STANDARD_CHROME_ROW_HEIGHT,
  TALL_CHROME_ROW_HEIGHT,
} from "./chromeHeight";

// SPEC_TABS.md, В83: the bar and the pages go together (07.10.2026).
describe("chrome heights", () => {
  afterEach(() => document.documentElement.removeAttribute("data-chrome-height"));

  it("offers the standard and the tall chrome only, the bar with the pages", () => {
    expect(CHROME_ROW_VARIANTS.map(({ label }) => label)).toEqual(["Chrome Height 30", "Chrome Height 40"]);
    expect(CHROME_ROW_VARIANTS.map(({ rows }) => rows)).toEqual([
      { tab_bar: STANDARD_CHROME_ROW_HEIGHT, page: STANDARD_CHROME_ROW_HEIGHT },
      { tab_bar: TALL_CHROME_ROW_HEIGHT, page: TALL_CHROME_ROW_HEIGHT },
    ]);
  });

  it("names the tall row on the page's root and clears it for the standard one", () => {
    applyChromeRowHeight(TALL_CHROME_ROW_HEIGHT);
    expect(document.documentElement).toHaveAttribute("data-chrome-height", "40");
    applyChromeRowHeight(STANDARD_CHROME_ROW_HEIGHT);
    expect(document.documentElement).not.toHaveAttribute("data-chrome-height");
  });
});
