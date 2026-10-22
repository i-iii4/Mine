import { describe, expect, it } from "vitest";
import { textOverflows } from "./textClip";

describe("text clip", () => {
  const cell = { left: 0, right: 100 };

  it("leaves a text that ends before the clear tail whole", () => {
    expect(textOverflows({ left: 17, right: 97 }, cell, 3)).toBe(false);
  });

  it("dissolves a text that enters the clear tail or runs past the cell", () => {
    expect(textOverflows({ left: 17, right: 98 }, cell, 3)).toBe(true);
    expect(textOverflows({ left: 17, right: 140 }, cell, 3)).toBe(true);
    expect(textOverflows({ left: -10, right: 60 }, cell, 3)).toBe(true);
  });
});
