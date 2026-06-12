import { describe, expect, it } from "vitest";
import { formatBytes } from "./formatBytes";

describe("formatBytes", () => {
  it("uses the decimal base so sizes match Finder", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1_000)).toBe("1 KB");
    expect(formatBytes(52_000)).toBe("52 KB");
    expect(formatBytes(999_499)).toBe("999 KB");
    expect(formatBytes(1_000_000)).toBe("1.0 MB");
    expect(formatBytes(2_400_000)).toBe("2.4 MB");
    expect(formatBytes(1_000_000_000)).toBe("1.0 GB");
    expect(formatBytes(4_200_000_000)).toBe("4.2 GB");
  });
});
