import { describe, expect, it } from "vitest";
import { cardCornerRadius } from "./canvas";
import {
  CARD_THUMBNAIL_SIZE,
  GRAPH_CARD_RADIUS_MAX_PX,
  GRAPH_NODE_MAX_PX,
} from "./contracts";

describe("cardCornerRadius", () => {
  it("is invisible on a small card and present on a large one", () => {
    // At the 32px floor a corner radius is noise; at the ceiling a square
    // corner reads as sharp against an interface that is rounded everywhere
    // else.
    expect(cardCornerRadius(CARD_THUMBNAIL_SIZE)).toBeLessThan(2);
    expect(cardCornerRadius(GRAPH_NODE_MAX_PX)).toBeGreaterThanOrEqual(4);
  });

  it("grows with the card rather than jumping at a threshold", () => {
    const small = cardCornerRadius(40);
    const middle = cardCornerRadius(60);
    const large = cardCornerRadius(90);
    expect(small).toBeLessThan(middle);
    expect(middle).toBeLessThan(large);
  });

  it("never exceeds the radius the rest of the interface uses", () => {
    expect(cardCornerRadius(1000)).toBe(GRAPH_CARD_RADIUS_MAX_PX);
  });
});
