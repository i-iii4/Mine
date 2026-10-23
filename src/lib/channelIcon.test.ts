import { describe, expect, it } from "vitest";
import { CHANNEL_ICON_CARD_PX, CHANNEL_ICON_WIDTH_PX, channelIconDepth } from "./channelIcon";

/// The compact stack's depth is one projection (PLAN 50.36, user's decision
/// of 22.10.2026): each card behind is `r` of the one before it and recedes
/// toward one vanishing point by the share it lost.
describe("channel icon depth", () => {
  const cards = [0, 1, 2].map(channelIconDepth);

  it("scales each step back by the same reduction, r^d", () => {
    const r = cards[1]!.scale;
    expect(cards[0]!.scale).toBe(1);
    expect(r).toBeCloseTo(0.88, 10);
    expect(cards[2]!.scale).toBeCloseTo(r * r, 10);
  });

  it("makes the steps shorter with depth", () => {
    const step = (from: number, to: number) =>
      Math.hypot(cards[to]!.x - cards[from]!.x, cards[to]!.y - cards[from]!.y);
    expect(step(0, 1)).toBeGreaterThan(0);
    expect(step(1, 2)).toBeLessThan(step(0, 1));
  });

  it("puts every centre on one line toward the vanishing point", () => {
    // The vanishing point is where the scale would reach 0: share 1.
    const far = channelIconDepth(Number.POSITIVE_INFINITY);
    for (const card of cards) {
      // Collinear with the front card's centre (the origin) and V.
      expect(card.x * far.y - card.y * far.x).toBeCloseTo(0, 10);
    }
    expect(far.x).toBeGreaterThan(0);
    // On the cards' middle: the deck recedes evenly up and down.
    expect(far.y).toBe(0);
  });

  it("ends the back card about where the 7.23 cascade ended", () => {
    expect(CHANNEL_ICON_WIDTH_PX).toBeCloseTo(CHANNEL_ICON_CARD_PX + 2 * (CHANNEL_ICON_CARD_PX / 6), 0);
  });
});

describe("the large stack (PLAN 50.38)", () => {
  it("scales the whole projection with the card, the hover's shift kept", async () => {
    const { CHANNEL_ICON_LARGE_CARD_PX, channelIconBoxStyle, channelIconCardStyle } = await import("./channelIcon");
    const k = CHANNEL_ICON_LARGE_CARD_PX / CHANNEL_ICON_CARD_PX;
    expect(CHANNEL_ICON_LARGE_CARD_PX).toBe(40);
    expect(channelIconBoxStyle(40)).toMatchObject({ width: CHANNEL_ICON_WIDTH_PX * k, height: 40 });
    const middle = channelIconCardStyle(1, 3, 40) as Record<string, unknown>;
    expect(middle.width).toBe(40);
    expect(middle["--channel-icon-rest"]).toBe(`translate(${Math.round(channelIconDepth(1).x * k * 1000) / 1000}px, 0px) scale(0.88)`);
    const top = channelIconCardStyle(2, 3, 40) as Record<string, unknown>;
    expect(top["--channel-icon-hover"]).toBe("translate(-3px, 0px) scale(1)");
  });
});
