import { describe, expect, it, vi } from "vitest";
import { createSelectionStamps } from "./spaceSelection";

describe("space selection stamps (SPEC_TABS.md, В10)", () => {
  it("counts choices in the order the page makes them, under one generation asked once", async () => {
    const fetchGeneration = vi.fn(() => Promise.resolve(4));
    const next = createSelectionStamps(fetchGeneration);
    const first = next();
    const second = next();
    // The later choice may settle first; its place was taken when it was made.
    await expect(second).resolves.toEqual({ generation: 4, sequence: 2 });
    await expect(first).resolves.toEqual({ generation: 4, sequence: 1 });
    expect(fetchGeneration).toHaveBeenCalledTimes(1);
  });

  it("asks for the generation again after a failed ask, keeping the count", async () => {
    const fetchGeneration = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(9);
    const next = createSelectionStamps(fetchGeneration);
    await expect(next()).rejects.toThrow("offline");
    await expect(next()).resolves.toEqual({ generation: 9, sequence: 2 });
    expect(fetchGeneration).toHaveBeenCalledTimes(2);
  });
});
