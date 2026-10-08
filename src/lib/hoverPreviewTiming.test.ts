import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOVER_INTENT } from "./hoverIntent";
import {
  HOVER_PREVIEW_COLD_OPEN_DELAY_MS,
  HOVER_PREVIEW_WARM_WINDOW_MS,
  HoverPreviewOpener,
} from "./hoverPreviewTiming";

describe("HoverPreviewOpener", () => {
  let resting = true;
  let shown: string[] = [];
  let opener: HoverPreviewOpener;
  const request = (name: string) => opener.request(() => shown.push(name));

  beforeEach(() => {
    vi.useFakeTimers();
    resting = true;
    shown = [];
    opener = new HoverPreviewOpener(() => resting);
  });

  afterEach(() => {
    opener.dispose();
    vi.useRealTimers();
  });

  it("opens after the cold delay", () => {
    request("a");
    vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS - 1);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual(["a"]);
  });

  it("opens nothing for a pointer passing over the triggers", () => {
    for (const name of ["a", "b", "c"]) {
      request(name);
      vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS - 100);
      opener.hide();
    }
    vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS * 2);
    expect(shown).toEqual([]);
  });

  it("waits past the delay for a moving pointer to rest", () => {
    resting = false;
    request("a");
    vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS + HOVER_INTENT.velocityWindowMs * 3);
    expect(shown).toEqual([]);
    resting = true;
    vi.advanceTimersByTime(HOVER_INTENT.velocityWindowMs);
    expect(shown).toEqual(["a"]);
  });

  it("hands a preview read for a while to the next trigger at once", () => {
    request("a");
    vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS);
    // Far longer on screen than the warm window.
    vi.advanceTimersByTime(HOVER_PREVIEW_WARM_WINDOW_MS * 3);
    opener.hide();
    request("b");
    expect(shown).toEqual(["a", "b"]);
    // A request while a preview is still on screen switches at once too.
    vi.advanceTimersByTime(HOVER_PREVIEW_WARM_WINDOW_MS * 3);
    request("c");
    expect(shown).toEqual(["a", "b", "c"]);
  });

  it("brings the delay back once the warm window after the last preview has passed", () => {
    request("a");
    vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS);
    opener.hide();
    vi.advanceTimersByTime(HOVER_PREVIEW_WARM_WINDOW_MS + 1);
    request("b");
    vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS - 1);
    expect(shown).toEqual(["a"]);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual(["a", "b"]);
  });

  it("starts no warm window from a request that never showed", () => {
    request("a");
    vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS - 1);
    opener.hide();
    request("b");
    vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS - 1);
    expect(shown).toEqual([]);
    opener.cancel();
    vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS);
    expect(shown).toEqual([]);
  });
});
