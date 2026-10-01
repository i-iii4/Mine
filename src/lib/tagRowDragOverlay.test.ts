import { afterEach, describe, expect, it, vi } from "vitest";
import { tagRowDropAnimation } from "./tagRowDragOverlay";

function reduceMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query === "(prefers-reduced-motion: reduce)",
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

describe("collection row drop flight (Ф12, Г5.2)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not fly under Reduce motion: the row lands where it is dropped", () => {
    // dnd-kit plays the flight through Web Animations, which the global
    // reduced-motion CSS rule does not reach; the drop asks the setting itself.
    reduceMotion(true);
    expect(tagRowDropAnimation()).toBeNull();
  });

  it("flies into the open slot for 200 ms when motion is not reduced", () => {
    reduceMotion(false);
    expect(tagRowDropAnimation()).toMatchObject({
      duration: 200,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    });
  });
});
