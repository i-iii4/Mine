import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createCardLiftStore, useCardRaised } from "./cardLift";

/// The feed card the pointer has arrived on (SPEC_CARD_STATES.md, С8.6).
describe("the raised card's store", () => {
  it("answers for the raised card alone, by the id the engine keys it with", () => {
    const store = createCardLiftStore();
    expect(store.isRaised(1)).toBe(false);
    store.set("1");
    expect(store.isRaised(1)).toBe(true);
    expect(store.isRaised(2)).toBe(false);
    store.set(null);
    expect(store.isRaised(1)).toBe(false);
  });

  it("tells a listener only when the raised card changes, until it unsubscribes", () => {
    const store = createCardLiftStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set("1");
    store.set("1");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.set("2");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("renders again only the card that gains or loses the lift", () => {
    const store = createCardLiftStore();
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useCardRaised(store, 1);
    });
    expect(result.current).toBe(false);
    const atRest = renders;
    act(() => store.set("2"));
    expect(renders).toBe(atRest);
    act(() => store.set("1"));
    expect(result.current).toBe(true);
    expect(renders).toBe(atRest + 1);
    act(() => store.set(null));
    expect(result.current).toBe(false);
  });
});
