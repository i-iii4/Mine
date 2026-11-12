// SPEC_MOTION_LEVELS.md, В3; УД4, п. 7: a refused name shakes only in Full,
// after Enter too; Minimal and Off keep the reason under the name alone.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAME_REFUSAL_NOTICE_MS, NAME_REFUSED_SHAKE_MS, useNameEdit } from "./useNameEdit";
import { setMotionLevel } from "@/test/motionLevel";

const REASON = "A collection named \"Taken\" already exists.";

function nameEdit() {
  const end = vi.fn();
  const view = renderHook(() => useNameEdit({
    current: "Inbox",
    save: async () => {
      throw new Error(REASON);
    },
    reasonOf: (error) => (error instanceof Error ? error.message : "Could not rename."),
    end,
  }));
  return { ...view, end };
}

/** Lets the refused save's promise settle. */
async function settle() {
  await act(async () => {
    for (let flush = 0; flush < 4; flush += 1) await Promise.resolve();
  });
}

describe("the refused name's shake by the motion level", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shakes in Full after Enter, then keeps the field and the reason", async () => {
    const { result, end } = nameEdit();
    act(() => result.current.begin("Inbox"));
    act(() => result.current.submit("Taken"));
    await settle();
    expect(result.current.refused).toBe(true);
    expect(result.current.notice).toBe(REASON);
    act(() => vi.advanceTimersByTime(NAME_REFUSED_SHAKE_MS));
    expect(result.current.refused).toBe(false);
    expect(result.current.notice).toBe(REASON);
    expect(end).not.toHaveBeenCalled();
  });

  it.each(["minimal", "off"] as const)("does not shake at %s after Enter: the reason stays under the kept field", async (level) => {
    setMotionLevel(level);
    const { result, end } = nameEdit();
    act(() => result.current.begin("Inbox"));
    act(() => result.current.submit("Taken"));
    await settle();
    expect(result.current.refused).toBe(false);
    expect(result.current.notice).toBe(REASON);
    expect(end).not.toHaveBeenCalled();
    // The field takes the next try at once: nothing is held for a shake.
    act(() => result.current.submit("Taken"));
    await settle();
    expect(result.current.notice).toBe(REASON);
  });

  it.each(["minimal", "off"] as const)("does not shake at %s on leaving: the old name returns, the reason stays its 2.5 s", async (level) => {
    setMotionLevel(level);
    const { result, end } = nameEdit();
    act(() => result.current.begin("Inbox"));
    act(() => result.current.leave("Taken"));
    await settle();
    expect(result.current.refused).toBe(false);
    expect(end).toHaveBeenCalledTimes(1);
    expect(result.current.notice).toBe(REASON);
    act(() => vi.advanceTimersByTime(NAME_REFUSAL_NOTICE_MS - 1));
    expect(result.current.notice).toBe(REASON);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.notice).toBeNull();
  });
});
