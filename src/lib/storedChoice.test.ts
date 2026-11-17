import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storedChoice } from "./storedChoice";

const KEY = "mine.test.storedChoice";
const SIDES = ["left", "right"] as const;

/// One choice kept in its own localStorage key (SPEC_CARD_PEEK.md, О1: the
/// open card's view keeps its choice this way).
describe("storedChoice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(KEY);
  });

  it("is the fallback until a value is chosen, and keeps the choice", () => {
    const side = storedChoice(KEY, "left", SIDES);
    expect(side.get()).toBe("left");
    side.set("right");
    expect(side.get()).toBe("right");
    expect(localStorage.getItem(KEY)).toBe("right");
    // The next launch reads what was kept.
    expect(storedChoice(KEY, "left", SIDES).get()).toBe("right");
  });

  it("re-reads a choice another tab stored and drops an unknown one", () => {
    const side = storedChoice(KEY, "left", SIDES);
    localStorage.setItem(KEY, "right");
    side.reload();
    expect(side.get()).toBe("right");
    localStorage.setItem(KEY, "up");
    side.reload();
    expect(side.get()).toBe("left");
  });

  it("tells React of a choice and of a re-read", () => {
    const side = storedChoice(KEY, "left", SIDES);
    const { result } = renderHook(() => side.use());
    expect(result.current).toBe("left");
    act(() => side.set("right"));
    expect(result.current).toBe("right");
    localStorage.removeItem(KEY);
    act(() => side.reload());
    expect(result.current).toBe("left");
  });

  it("keeps the choice for the session where the storage cannot be written or read", () => {
    const side = storedChoice(KEY, "left", SIDES);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    side.set("right");
    expect(side.get()).toBe("right");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    side.reload();
    expect(side.get()).toBe("left");
  });
});
