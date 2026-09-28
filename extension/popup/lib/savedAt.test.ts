import { describe, expect, it } from "vitest";
import { localSavedAt } from "./savedAt";

describe("localSavedAt", () => {
  it("writes the local wall clock without a time zone", () => {
    expect(localSavedAt(new Date(2026, 8, 27, 22, 5, 9))).toBe("2026-09-27T22:05:09");
  });

  it("reads back as the same local moment", () => {
    const date = new Date(2026, 0, 2, 3, 4, 5);
    expect(new Date(localSavedAt(date)).getTime()).toBe(date.getTime());
  });
});
