import { describe, it, expect } from "vitest";
import { countLines } from "./wordWrap";

describe("countLines", () => {
  it("returns 0 for empty input", () => {
    expect(countLines([], 4, 200)).toBe(0);
  });

  it("returns 1 for a single word that fits", () => {
    expect(countLines([50], 4, 200)).toBe(1);
  });

  it("returns 1 for words that all fit on one line", () => {
    // 30 + 4 + 30 + 4 + 30 = 98 ≤ 200
    expect(countLines([30, 30, 30], 4, 200)).toBe(1);
  });

  it("wraps to a second line when width exceeded", () => {
    // 80 + 4 + 80 = 164 fits, + 4 + 80 = 248 doesn't → line 2
    expect(countLines([80, 80, 80], 4, 200)).toBe(2);
  });

  it("handles a single oversized word as its own line", () => {
    // Single word wider than maxWidth still occupies one line (browser breaks
    // mid-word via CSS, but line count from our perspective is 1).
    expect(countLines([500], 4, 200)).toBe(1);
  });

  it("places an oversized word after a short one on a new line", () => {
    // 50 fits on line 1. 500 alone exceeds maxWidth but starts line 2.
    expect(countLines([50, 500], 4, 200)).toBe(2);
  });

  it("produces correct line count for many short words", () => {
    // Ten 20px words + 9 spaces (4px each) = 200 + 36 = 236 → needs 2 lines.
    // Per-line capacity: how many 20px words with 4px spaces fit in 200px?
    // N * 20 + (N-1) * 4 ≤ 200 → 24N - 4 ≤ 200 → N ≤ 8.5 → N = 8
    // 10 words / 8 per line = 2 lines
    const widths = Array.from({ length: 10 }, () => 20);
    expect(countLines(widths, 4, 200)).toBe(2);
  });

  it("degenerates gracefully at zero maxWidth", () => {
    // Invalid but callers may pass 0 during initial render — return word count
    // as a conservative upper bound, never throw.
    expect(countLines([10, 20, 30], 4, 0)).toBe(3);
  });

  it("is deterministic — same inputs always yield same output", () => {
    const widths = [40, 35, 50, 28, 60, 22, 45];
    const first = countLines(widths, 4, 200);
    const second = countLines(widths, 4, 200);
    const third = countLines(widths, 4, 200);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });
});
