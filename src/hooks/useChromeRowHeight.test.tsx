import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { STANDARD_CHROME_ROW_HEIGHT, TALL_CHROME_ROW_HEIGHT, applyChromeRowHeight } from "@/lib/chromeHeight";
import { useChromeRowHeight } from "./useChromeRowHeight";

describe("useChromeRowHeight", () => {
  afterEach(() => applyChromeRowHeight(STANDARD_CHROME_ROW_HEIGHT));

  it("follows the page's chrome height as the logo menu changes it", async () => {
    const { result } = renderHook(() => useChromeRowHeight());
    expect(result.current).toBe(STANDARD_CHROME_ROW_HEIGHT);
    // The observer reports after the attribute changes, in a microtask.
    await act(async () => applyChromeRowHeight(TALL_CHROME_ROW_HEIGHT));
    expect(result.current).toBe(TALL_CHROME_ROW_HEIGHT);
    await act(async () => applyChromeRowHeight(STANDARD_CHROME_ROW_HEIGHT));
    expect(result.current).toBe(STANDARD_CHROME_ROW_HEIGHT);
  });
});
