import { describe, expect, it } from "vitest";
import { cardCornerRadius } from "./canvas";
import {
  CARD_THUMBNAIL_SIZE,
  GRAPH_CARD_RADIUS_MAX_PX,
  GRAPH_NODE_MAX_PX,
} from "./contracts";

describe("cardCornerRadius", () => {
  it("leaves a card at the floor size perfectly square", () => {
    // A radius here is three physical pixels on a retina screen: it reads as a
    // blurred edge, not as rounding.
    expect(cardCornerRadius(CARD_THUMBNAIL_SIZE)).toBe(0);
    expect(cardCornerRadius(CARD_THUMBNAIL_SIZE - 10)).toBe(0);
  });

  it("rounds a card at the ceiling to the radius the design system gives cards", () => {
    // --radius-1, not --radius-2: a fully approached card must not be rounder
    // than a card anywhere else in the interface.
    expect(cardCornerRadius(GRAPH_NODE_MAX_PX)).toBe(GRAPH_CARD_RADIUS_MAX_PX);
  });

  it("appears and disappears continuously, never at a step", () => {
    // Measured across the whole range: the largest change between neighbouring
    // sizes must stay small, or the corner would pop somewhere along the way.
    let previous = cardCornerRadius(CARD_THUMBNAIL_SIZE);
    let largestStep = 0;
    for (let size = CARD_THUMBNAIL_SIZE; size <= GRAPH_NODE_MAX_PX; size += 1) {
      const radius = cardCornerRadius(size);
      largestStep = Math.max(largestStep, Math.abs(radius - previous));
      previous = radius;
    }
    expect(largestStep).toBeLessThan(0.2);
  });

  it("grows with the card", () => {
    expect(cardCornerRadius(40)).toBeLessThan(cardCornerRadius(60));
    expect(cardCornerRadius(60)).toBeLessThan(cardCornerRadius(90));
  });

  it("never exceeds the radius the rest of the interface uses", () => {
    expect(cardCornerRadius(1000)).toBe(GRAPH_CARD_RADIUS_MAX_PX);
  });
});
