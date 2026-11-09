import { describe, expect, it } from "vitest";

import { CARD_PEEK_SPRING_MS, stepPeekSpring, peekSpringSettled, type PeekRect, type PeekSpring } from "./cardPeek";
import {
  containPeekRect,
  fitImagePreviewSize,
  imagePreviewClosingKind,
  imagePreviewFrame,
  imagePreviewOpeningKind,
  imagePreviewPlace,
  imagePreviewRestRect,
  imagePreviewRestTransform,
  measureLaidImage,
  readImagePreviewPlace,
  type ImagePreviewTransform,
} from "./imagePreviewMotion";

const AT_REST: ImagePreviewTransform = { scale: 1, x: 0, y: 0 };
const LAID: PeekRect = { x: 200, y: 100, width: 800, height: 600 };
const SCREEN: PeekRect = { x: 0, y: 0, width: 1200, height: 800 };

/** What a frame's transform and clip show, for a picture laid as `laid`. */
function shownBy(frame: { transform: string; clipPath: string }, laid: PeekRect) {
  const move = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\) scale\(([\d.]+)\)/.exec(frame.transform)!;
  const [x, y, scale] = [Number(move[1]), Number(move[2]), Number(move[3])];
  const width = laid.width * scale;
  const height = laid.height * scale;
  const image = {
    x: laid.x + laid.width / 2 + x - width / 2,
    y: laid.y + laid.height / 2 + y - height / 2,
    width,
    height,
  };
  const clip = /inset\(([\d.]+)px ([\d.]+)px ([\d.]+)px ([\d.]+)px round ([\d.]+)px\)/.exec(frame.clipPath)!;
  const [top, right, bottom, left, radius] = clip.slice(1).map((value) => Number(value) * scale) as [number, number, number, number, number];
  return {
    image,
    clip: {
      x: image.x + left,
      y: image.y + top,
      width: width - left - right,
      height: height - top - bottom,
    },
    radius,
    scale,
  };
}

function expectRect(actual: PeekRect, expected: PeekRect) {
  expect(actual.x).toBeCloseTo(expected.x, 2);
  expect(actual.y).toBeCloseTo(expected.y, 2);
  expect(actual.width).toBeCloseTo(expected.width, 2);
  expect(actual.height).toBeCloseTo(expected.height, 2);
}

describe("how the preview opens and closes", () => {
  it("opens at once by a key, in place with Reduce motion, out of a source by a press, as a dialog with none", () => {
    expect(imagePreviewOpeningKind({ keyboard: true, reducedMotion: true, hasSource: true })).toBe("instant");
    expect(imagePreviewOpeningKind({ keyboard: true, reducedMotion: false, hasSource: false })).toBe("instant");
    expect(imagePreviewOpeningKind({ keyboard: false, reducedMotion: true, hasSource: true })).toBe("fade");
    expect(imagePreviewOpeningKind({ keyboard: false, reducedMotion: true, hasSource: false })).toBe("fade");
    expect(imagePreviewOpeningKind({ keyboard: false, reducedMotion: false, hasSource: true })).toBe("flight");
    expect(imagePreviewOpeningKind({ keyboard: false, reducedMotion: false, hasSource: false })).toBe("dialog");
  });

  it("closes into a source on screen, as a dialog without one, in place after a key or with Reduce motion", () => {
    expect(imagePreviewClosingKind({ openedAs: "flight", reducedMotion: false, sourceOnScreen: true })).toBe("flight");
    expect(imagePreviewClosingKind({ openedAs: "flight", reducedMotion: false, sourceOnScreen: false })).toBe("dialog");
    expect(imagePreviewClosingKind({ openedAs: "dialog", reducedMotion: false, sourceOnScreen: false })).toBe("dialog");
    expect(imagePreviewClosingKind({ openedAs: "instant", reducedMotion: false, sourceOnScreen: true })).toBe("fade");
    expect(imagePreviewClosingKind({ openedAs: "flight", reducedMotion: true, sourceOnScreen: true })).toBe("fade");
  });
});

describe("the picture's place in its source", () => {
  it("is the whole picture inside the frame when the frame draws it whole", () => {
    const place = imagePreviewPlace({
      box: { x: 10, y: 20, width: 400, height: 400 },
      bounds: SCREEN,
      fit: "contain",
      width: 800,
      height: 600,
      radius: 0,
    })!;
    expectRect(place.image, { x: 10, y: 70, width: 400, height: 300 });
    expectRect(place.clip, place.image);
  });

  it("is the frame's crop of the whole picture when the frame covers with it (object-cover)", () => {
    const box = { x: 10, y: 20, width: 300, height: 300 };
    const place = imagePreviewPlace({ box, bounds: SCREEN, fit: "cover", width: 800, height: 600, radius: 12 })!;
    expectRect(place.image, { x: -40, y: 20, width: 400, height: 300 });
    expectRect(place.clip, box);
    expect(place.radius).toBe(12);
  });

  it("shows no more of it than the scroller does", () => {
    const place = imagePreviewPlace({
      box: { x: 100, y: 700, width: 400, height: 300 },
      bounds: SCREEN,
      fit: "cover",
      width: 400,
      height: 300,
      radius: 0,
    })!;
    expectRect(place.clip, { x: 100, y: 700, width: 400, height: 100 });
    expectRect(place.image, { x: 100, y: 700, width: 400, height: 300 });
  });

  it("is none when nothing of it shows", () => {
    expect(imagePreviewPlace({
      box: { x: 100, y: 900, width: 400, height: 300 },
      bounds: SCREEN,
      fit: "cover",
      width: 400,
      height: 300,
      radius: 0,
    })).toBeNull();
    expect(imagePreviewPlace({
      box: { x: 0, y: 0, width: 0, height: 0 },
      bounds: SCREEN,
      fit: "cover",
      width: 400,
      height: 300,
      radius: 0,
    })).toBeNull();
  });

  it("fits a picture whole in a box, as contain draws it", () => {
    expectRect(containPeekRect({ x: 0, y: 0, width: 100, height: 100 }, 200, 100), { x: 0, y: 25, width: 100, height: 50 });
  });
});

describe("a frame of the way", () => {
  const place = imagePreviewPlace({
    box: { x: 40, y: 500, width: 200, height: 200 },
    bounds: SCREEN,
    fit: "cover",
    width: 800,
    height: 600,
    radius: 16,
  })!;

  it("stands exactly on the source in its first frame, crop and corner included", () => {
    const shown = shownBy(imagePreviewFrame(place, LAID, AT_REST, 0), LAID);
    expectRect(shown.image, place.image);
    expectRect(shown.clip, place.clip);
    expect(shown.radius).toBeCloseTo(16, 3);
  });

  it("stands exactly on the preview's place in its last, the whole picture with no corner", () => {
    const shown = shownBy(imagePreviewFrame(place, LAID, AT_REST, 1), LAID);
    expectRect(shown.image, LAID);
    expectRect(shown.clip, LAID);
    expect(shown.radius).toBe(0);
  });

  it("starts a closing from the zoom and pan the preview shows, with no jump", () => {
    const zoomed = { scale: 1.5, x: 30, y: -20 };
    const shown = shownBy(imagePreviewFrame(place, LAID, zoomed, 1), LAID);
    expectRect(shown.image, imagePreviewRestRect(LAID, zoomed));
  });

  it("stretches nothing: one scale, the crop opening continuously, the corner round on screen", () => {
    let previousClipWidth = 0;
    for (let index = 0; index <= 10; index += 1) {
      const progress = index / 10;
      const frame = imagePreviewFrame(place, LAID, AT_REST, progress);
      const shown = shownBy(frame, LAID);
      // A uniform scale only: the transform has one number for both axes.
      expect(shown.image.width / shown.image.height).toBeCloseTo(LAID.width / LAID.height, 5);
      expect(shown.clip.width).toBeGreaterThan(previousClipWidth);
      previousClipWidth = shown.clip.width;
      expect(shown.clip.x).toBeGreaterThanOrEqual(shown.image.x - 0.01);
      expect(shown.clip.x + shown.clip.width).toBeLessThanOrEqual(shown.image.x + shown.image.width + 0.01);
      expect(shown.radius).toBeCloseTo(16 * (1 - progress), 3);
    }
  });

  it("keeps no layer at 100 % at rest", () => {
    expect(imagePreviewRestTransform(AT_REST)).toBe("none");
    expect(imagePreviewRestTransform({ scale: 1.5, x: 1, y: 2 })).toBe("translate3d(1px, 2px, 0) scale(1.5)");
  });

  it("runs on the card window's spring: no overshoot, at rest by its stop", () => {
    let spring: PeekSpring = { position: 0, velocity: 0, target: 1 };
    let previous = 0;
    let elapsed = 0;
    while (!peekSpringSettled(spring)) {
      spring = stepPeekSpring(spring, 1000 / 60);
      elapsed += 1000 / 60;
      expect(spring.position).toBeGreaterThanOrEqual(previous);
      expect(spring.position).toBeLessThanOrEqual(1);
      previous = spring.position;
    }
    expect(Math.abs(elapsed - CARD_PEEK_SPRING_MS)).toBeLessThanOrEqual(1000 / 60);
  });
});

describe("reading the page", () => {
  function box(element: Element, rect: PeekRect) {
    element.getBoundingClientRect = () => ({
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
      x: rect.x,
      y: rect.y,
      toJSON: () => rect,
    });
  }

  it("reads the frame's corner, fit and the scroller round it", () => {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    scroller.style.overflowX = "hidden";
    box(scroller, { x: 0, y: 40, width: 1024, height: 300 });
    const frame = document.createElement("div");
    frame.style.borderTopLeftRadius = "8px";
    const picture = document.createElement("img");
    picture.style.objectFit = "cover";
    frame.append(picture);
    scroller.append(frame);
    document.body.append(scroller);
    box(frame, { x: 100, y: 200, width: 400, height: 300 });
    box(picture, { x: 100, y: 200, width: 400, height: 300 });
    const place = readImagePreviewPlace(frame, 400, 300)!;
    expect(place.radius).toBe(8);
    expectRect(place.image, { x: 100, y: 200, width: 400, height: 300 });
    expectRect(place.clip, { x: 100, y: 200, width: 400, height: 140 });

    box(picture, { x: 100, y: 700, width: 400, height: 300 });
    expect(readImagePreviewPlace(frame, 400, 300)).toBeNull();
    scroller.remove();
    expect(readImagePreviewPlace(frame, 400, 300)).toBeNull();
  });

  it("gives an original of unknown size the largest place of its source's proportion", () => {
    expect(fitImagePreviewSize(400, 300, 1000, 600)).toEqual({ width: 800, height: 600 });
    expect(fitImagePreviewSize(0, 300, 1000, 600)).toBeNull();
    expect(fitImagePreviewSize(400, 300, Number.NaN, 600)).toBeNull();

    const frame = document.createElement("div");
    const thumb = document.createElement("img");
    thumb.setAttribute("data-detail-preview-backing", "");
    Object.defineProperty(thumb, "naturalWidth", { value: 40 });
    Object.defineProperty(thumb, "naturalHeight", { value: 30 });
    frame.append(thumb);
    const image = document.createElement("img");
    image.style.maxWidth = "1000px";
    image.style.maxHeight = "600px";
    document.body.append(image);
    box(image, { x: 100, y: 50, width: 800, height: 600 });
    expect(measureLaidImage(image, frame)).toEqual({ x: 100, y: 50, width: 800, height: 600 });
    expect(image.style.width).toBe("800px");
    expect(image.style.height).toBe("600px");
    image.remove();
  });

  it("measures the picture with no transform and gives its transform back", () => {
    const image = document.createElement("img");
    Object.defineProperty(image, "naturalWidth", { value: 800 });
    image.style.transform = "scale(2)";
    let transformWhenRead = "";
    image.getBoundingClientRect = () => {
      transformWhenRead = image.style.transform;
      return { left: 1, top: 2, width: 3, height: 4, right: 4, bottom: 6, x: 1, y: 2, toJSON: () => null };
    };
    expect(measureLaidImage(image, null)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(transformWhenRead).toBe("none");
    expect(image.style.transform).toBe("scale(2)");
  });
});
