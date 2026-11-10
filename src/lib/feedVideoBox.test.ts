import { describe, expect, it } from "vitest";
import { feedVideoBox } from "./feedVideoBox";

// The four shapes measured in the real WebKit feed (SPEC_CARD_MEDIA_GEOMETRY.md,
// «Коробка видео в целых пикселях»): a 226 px column, a 225 px media clip.
const SHAPES = [
  { name: "16:9", natural: { width: 1920, height: 1080 }, slot: { width: 225, height: 127 }, box: { left: 0, top: 0, width: 226, height: 127 } },
  { name: "2.4:1", natural: { width: 2400, height: 1000 }, slot: { width: 225, height: 113 }, box: { left: -23, top: 0, width: 271, height: 113 } },
  { name: "1:2.5", natural: { width: 800, height: 2000 }, slot: { width: 225, height: 449 }, box: { left: 0, top: -57, width: 225, height: 563 } },
  { name: "4:5", natural: { width: 1080, height: 1350 }, slot: { width: 225, height: 281 }, box: { left: 0, top: 0, width: 225, height: 281 } },
];

describe("feedVideoBox", () => {
  it.each(SHAPES)("gives a $name video the whole-pixel box that covers its slot", ({ natural, slot, box }) => {
    expect(feedVideoBox(slot, natural)).toEqual(box);
  });

  it("keeps every edge and size on a whole pixel, covers the slot and keeps the video's shape within a pixel", () => {
    const naturals = [[1920, 1080], [2400, 1000], [800, 2000], [1080, 1350], [1080, 1920], [1000, 1000], [3840, 1606], [1281, 719]];
    for (let width = 150; width <= 420; width += 7) {
      for (const heightFraction of [0, 0.125, 0.5, 0.5625, 0.984375]) {
        for (const [naturalWidth, naturalHeight] of naturals) {
          const aspect = naturalWidth! / naturalHeight!;
          // A slot like the feed's: the layout's height of the clamped shape, maybe fractional.
          const clamped = Math.min(2, Math.max(0.5, aspect));
          const slot = { width, height: Math.round(width / clamped) + heightFraction };
          const box = feedVideoBox(slot, { width: naturalWidth!, height: naturalHeight! })!;
          const label = `${naturalWidth}x${naturalHeight} in ${slot.width}x${slot.height}`;
          for (const value of [box.left, box.top, box.width, box.height]) {
            expect(Number.isInteger(value), label).toBe(true);
          }
          expect(box.left, label).toBeLessThanOrEqual(0);
          expect(box.top, label).toBeLessThanOrEqual(0);
          expect(box.left + box.width, label).toBeGreaterThanOrEqual(slot.width);
          expect(box.top + box.height, label).toBeGreaterThanOrEqual(slot.height);
          // Within one pixel of the video's shape along the side the shape sets.
          const offWidth = Math.abs(box.width - box.height * aspect);
          const offHeight = Math.abs(box.height - box.width / aspect);
          expect(Math.min(offWidth, offHeight), label).toBeLessThanOrEqual(1);
          // Centred: the overflow splits within a pixel.
          expect(Math.abs(-box.left - (box.left + box.width - slot.width)), label).toBeLessThanOrEqual(1);
          expect(Math.abs(-box.top - (box.top + box.height - slot.height)), label).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("takes a size the layout hands over within a LayoutUnit of a whole pixel as that pixel", () => {
    expect(feedVideoBox({ width: 225.004, height: 127 }, { width: 1920, height: 1080 })).toEqual({ left: 0, top: 0, width: 226, height: 127 });
  });

  it("answers nothing while the slot or the video is unknown", () => {
    expect(feedVideoBox({ width: 0, height: 127 }, { width: 1920, height: 1080 })).toBeNull();
    expect(feedVideoBox({ width: 225, height: 127 }, { width: 0, height: 0 })).toBeNull();
    expect(feedVideoBox({ width: Number.NaN, height: 127 }, { width: 1920, height: 1080 })).toBeNull();
  });
});
