import { describe, expect, it } from "vitest";
import { MessageRow } from "./menuPanelProtocol";
import { parseMenuMode } from "./menuMode";

describe("the messages of one menu", () => {
  it("are taken in the order of their numbers, each once", () => {
    const row = new MessageRow<string>();
    // The second came first: it waits for the first.
    expect(row.take(2, "b")).toEqual([]);
    expect(row.take(1, "a")).toEqual(["a", "b"]);
    // One already taken is dropped, and so is a second copy of one ahead.
    expect(row.take(1, "again")).toEqual([]);
    expect(row.take(4, "d")).toEqual([]);
    expect(row.take(4, "other")).toEqual([]);
    expect(row.take(3, "c")).toEqual(["c", "d"]);
  });
});

describe("parseMenuMode", () => {
  it("is Web unless Window was chosen", () => {
    expect(parseMenuMode(null)).toBe("web");
    expect(parseMenuMode("system")).toBe("web");
    expect(parseMenuMode("window")).toBe("window");
  });
});
