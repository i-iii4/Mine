import { describe, expect, it } from "vitest";
// The environment under test; the run has already loaded it as its setup file.
import "./setup";

describe("the test environment's clocks", () => {
  it("stamps a frame on the clock of performance.now(), as a browser does", async () => {
    const before = performance.now();
    const stamp = await new Promise<number>((resolve) => {
      requestAnimationFrame(resolve);
    });
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(performance.now());
  });

  it("still cancels a frame", async () => {
    let ran = false;
    const handle = requestAnimationFrame(() => {
      ran = true;
    });
    cancelAnimationFrame(handle);
    await new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });
    expect(ran).toBe(false);
  });
});
