import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  DetailMotionGateContext,
  IMMEDIATE_DETAIL_GATE,
  useDetailMotionGate,
  type DetailMotionGate,
} from "./detailMotionGate";

/// The open card's work and the window's motion (SPEC_CARD_PEEK.md, О12).
describe("detailMotionGate", () => {
  it("lets everything through at once outside the card's window", async () => {
    const { result } = renderHook(() => useDetailMotionGate());
    expect(result.current).toBe(IMMEDIATE_DETAIL_GATE);
    const update = vi.fn();
    result.current.defer(update);
    expect(update).toHaveBeenCalledTimes(1);
    const work = Promise.resolve(7);
    expect(result.current.track(work)).toBe(work);
    await expect(work).resolves.toBe(7);
  });

  it("gives the card the gate of the window it stands in", () => {
    const gate: DetailMotionGate = { defer: vi.fn(), track: (work) => work };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DetailMotionGateContext.Provider value={gate}>{children}</DetailMotionGateContext.Provider>
    );
    const { result } = renderHook(() => useDetailMotionGate(), { wrapper });
    expect(result.current).toBe(gate);
  });
});
