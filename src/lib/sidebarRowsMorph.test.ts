import { describe, expect, it } from "vitest";
import { CHANNEL_ICON_SPRING_EASING, CHANNEL_ICON_SPRING_MS } from "./channelIcon";
import { MORPH_REST, lineLook, mixLook, morphSpring, stripLooks } from "./sidebarRowsMorph";

/// The rows' morph between the wide and the narrow table (user's decisions
/// of 23.10.2026) moves on the compact stack's spring and lays every part of
/// the wide rows over its narrow place.
describe("rows morph spring", () => {
  it("is the stack's spring from rest", () => {
    const spring = morphSpring();
    expect(spring.durationMs).toBe(CHANNEL_ICON_SPRING_MS);
    expect(spring.easing).toBe(CHANNEL_ICON_SPRING_EASING);
    expect(spring.progress(0)).toBe(0);
    expect(spring.progress(spring.durationMs)).toBe(1);
    expect(spring.speed(0)).toBeGreaterThanOrEqual(0);
  });

  it("turns around without a jump: it brakes from the speed it had", () => {
    const out = morphSpring();
    const frame = 1000 / 60;
    const at = out.durationMs / 10;
    const q = out.progress(at);
    const before = q - out.progress(at - frame);
    // Back toward 0 from q: progress r runs 0 → 1 over a span of −q.
    const back = morphSpring(out.speed(at) / -q);
    expect(q + back.progress(0) * -q).toBe(q);
    // The first frame back still goes the old way, slower than the last one
    // did: the new target pulls, the speed carries on.
    const after = back.progress(frame) * -q;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    expect(back.progress(back.durationMs)).toBe(1);
  });
});

describe("rows morph looks", () => {
  it("mixes the two ends linearly", () => {
    const narrow = { x: 10, y: -4, scaleX: 0.5, scaleY: 0.5, opacity: 0 };
    expect(mixLook(MORPH_REST, narrow, 0)).toEqual(MORPH_REST);
    expect(mixLook(MORPH_REST, narrow, 1)).toEqual(narrow);
    expect(mixLook(MORPH_REST, narrow, 0.5)).toEqual({ x: 5, y: -2, scaleX: 0.75, scaleY: 0.75, opacity: 0.5 });
  });

  it("shortens the line from edge to edge to 16px in from both edges", () => {
    const look = lineLook(366, { left: 1, right: 0 }, { left: 16, right: 16 });
    // Scaled from its left end: it starts at 1 + 15 and ends 16 before 366.
    expect(1 + look.x).toBe(16);
    expect(1 + look.x + 365 * look.scaleX).toBeCloseTo(350, 10);
  });

  it("lands the first three thumbnails on their cards and the rest under the bottom one", () => {
    const strip = { x: 135, y: 4, width: 122, height: 32 };
    const tiles = [0, 1, 2, 3, 4].map((index) => ({ x: 135 + index * 36, y: 4, width: 32, height: 32 }));
    const cards = [
      { x: 307, y: 4, width: 32, height: 32 },
      { x: 317, y: 6, width: 28, height: 28 },
      { x: 325, y: 8, width: 24, height: 24 },
    ];
    const looks = stripLooks(strip, tiles, cards);
    const landed = (index: number) => {
      const tile = tiles[index]!;
      const { narrow } = looks.tiles[index]!;
      const cx = tile.x + tile.width / 2 + narrow.x + looks.strip.x;
      const cy = tile.y + tile.height / 2 + narrow.y + looks.strip.y;
      return { cx, cy, size: tile.width * narrow.scaleX, opacity: narrow.opacity };
    };
    cards.forEach((card, index) => {
      expect(landed(index)).toEqual({ cx: card.x + card.width / 2, cy: card.y + card.height / 2, size: card.width, opacity: 1 });
    });
    const bottom = cards[2]!;
    expect(landed(3)).toMatchObject({ cx: bottom.x + bottom.width / 2, size: bottom.width, opacity: 0 });
    // The strip's edge hides the fourth one in part (shown), the fifth one whole.
    expect(looks.tiles[3]!.wide.opacity).toBe(1);
    expect(looks.tiles[4]!.wide.opacity).toBe(0);
  });
});
