import { describe, expect, it } from "vitest";
import { CHANNEL_ICON_SPRING_MS, springSettleMs } from "./channelIcon";
import {
  CARD_PEEK_CENTER_SCALE,
  CARD_PEEK_CONTENT_FADE_MS,
  CARD_PEEK_CONTENT_IN_FROM_MS,
  CARD_PEEK_SPRING_MS,
  CARD_PEEK_SPRING_RESPONSE_S,
  CARD_PEEK_FRAME_STEP_MS,
  CARD_PEEK_INPUT_WINDOW_MS,
  CARD_PEEK_MAX_WIDTH,
  CARD_PEEK_NUDGE_OFFSET_PX,
  CARD_PEEK_NUDGE_SCALE,
  cardPeekStackedMaxWidth,
  carriedPeekMediaPlace,
  centerPeekRect,
  centredPeekRect,
  coverPeekRect,
  intersectPeekRect,
  lerpPeekRect,
  peekBoxTransform,
  peekClosingKind,
  peekContentOpacity,
  peekFrameCut,
  peekFramePieceBoxes,
  peekFrameTransforms,
  peekMediaTransforms,
  peekOpeningFrom,
  peekOpeningKind,
  peekSpringSettled,
  peekSurfaceTransforms,
  peekNudgeTransform,
  peekWindowLayout,
  stepPeekSpring,
  type PeekInput,
  type PeekRect,
  type PeekSpring,
} from "./cardPeek";

/** The numbers of a transform `translate(x, y) scale(sx, sy)`. */
function parse(transform: string) {
  const match = /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\((-?[\d.e-]+), (-?[\d.e-]+)\)/.exec(transform);
  if (!match) throw new Error(`Not a box transform: ${transform}`);
  const [, x, y, sx, sy] = match.map(Number);
  return { x: x!, y: y!, sx: sx!, sy: sy! };
}

/** Where `transform` (origin at the top left) puts a box laid out as `laid`. */
function apply(laid: PeekRect, transform: string): PeekRect {
  const t = parse(transform);
  return { x: laid.x + t.x, y: laid.y + t.y, width: laid.width * t.sx, height: laid.height * t.sy };
}

function expectRect(actual: PeekRect, expected: PeekRect, digits = 3) {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.width).toBeCloseTo(expected.width, digits);
  expect(actual.height).toBeCloseTo(expected.height, digits);
}

function run(spring: PeekSpring, frameMs: number, untilSettled = true) {
  const positions: number[] = [];
  let elapsed = 0;
  let current = spring;
  while (elapsed < 2000) {
    current = stepPeekSpring(current, frameMs);
    elapsed += frameMs;
    positions.push(current.position);
    if (untilSettled && peekSpringSettled(current)) break;
  }
  return { positions, elapsed, spring: current };
}

const WINDOW = { x: 0, y: 0, width: 1000, height: 700 };
const CARD = { x: -120, y: 260, width: 200, height: 150 };

describe("card peek spring (SPEC_CARD_PEEK.md, «Величины», О12)", () => {
  it("has a response of its own, faster than the stack's, its time by the stack's rule", () => {
    expect(CARD_PEEK_SPRING_RESPONSE_S).toBe(0.25);
    expect(CARD_PEEK_SPRING_MS).toBe(springSettleMs(0.25));
    expect(CARD_PEEK_SPRING_MS).toBeLessThan(CHANNEL_ICON_SPRING_MS);
    // The stack keeps its own: 0.3 s lands in 441 ms.
    expect(springSettleMs(0.3)).toBe(CHANNEL_ICON_SPRING_MS);
  });

  it("lands from rest in its own time, never past its target", () => {
    const { positions, elapsed } = run({ position: 0, velocity: 0, target: 1 }, 1);
    expect(Math.abs(elapsed - CARD_PEEK_SPRING_MS)).toBeLessThanOrEqual(1);
    expect(Math.max(...positions)).toBeLessThanOrEqual(1);
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]!).toBeGreaterThanOrEqual(positions[index - 1]!);
    }
  });

  it("turns back from where it is: no jump, no break in speed, no overshoot", () => {
    const growing = run({ position: 0, velocity: 0, target: 1 }, 16, false);
    // A third of the way into the growth.
    let spring = { position: 0, velocity: 0, target: 1 as const } as PeekSpring;
    for (let frame = 0; frame < 9; frame += 1) spring = stepPeekSpring(spring, 16);
    expect(growing.positions.length).toBeGreaterThan(9);
    const turned: PeekSpring = { ...spring, target: 0 };
    const next = stepPeekSpring(turned, 0.1);
    // A tenth of a millisecond on, the window has barely moved and keeps
    // its speed.
    expect(Math.abs(next.position - spring.position)).toBeLessThan(0.01);
    expect(next.velocity).toBeCloseTo(spring.velocity, 0);
    const back = run(turned, 4);
    expect(Math.min(...back.positions)).toBeGreaterThanOrEqual(0);
    expect(back.spring.position).toBeCloseTo(0, 2);
  });

  it("steps a long frame as one frame: slower, never a jump", () => {
    const long = stepPeekSpring({ position: 0, velocity: 0, target: 1 }, 500);
    const capped = stepPeekSpring({ position: 0, velocity: 0, target: 1 }, CARD_PEEK_FRAME_STEP_MS);
    expect(long.position).toBeCloseTo(capped.position, 10);
    expect(CARD_PEEK_FRAME_STEP_MS).toBeLessThan(18);
    // Its fastest frame moves less than a sixth of the way.
    let spring: PeekSpring = { position: 0, velocity: 0, target: 1 };
    let largest = 0;
    for (let frame = 0; frame < 40; frame += 1) {
      const next = stepPeekSpring(spring, 1000);
      largest = Math.max(largest, next.position - spring.position);
      spring = next;
    }
    expect(largest).toBeLessThan(1 / 6);
  });
});

describe("card peek content timing (О10, п. 4; О11, п. 1)", () => {
  it("shows the content over the second half of an opening", () => {
    const half = CARD_PEEK_SPRING_MS / 2;
    expect(CARD_PEEK_CONTENT_IN_FROM_MS).toBe(half);
    expect(peekContentOpacity("in", 0, 0)).toBe(0);
    expect(peekContentOpacity("in", half - 1, 0)).toBe(0);
    expect(peekContentOpacity("in", half + half / 2, 0)).toBeCloseTo(0.5, 5);
    expect(peekContentOpacity("in", CARD_PEEK_SPRING_MS, 0)).toBe(1);
  });

  it("hides the content over the first third of a closing", () => {
    expect(CARD_PEEK_CONTENT_FADE_MS).toBe(CARD_PEEK_SPRING_MS / 3);
    expect(peekContentOpacity("out", 0, 1)).toBe(1);
    expect(peekContentOpacity("out", CARD_PEEK_CONTENT_FADE_MS, 1)).toBe(0);
    expect(peekContentOpacity("out", CARD_PEEK_SPRING_MS, 1)).toBe(0);
  });

  it("goes on from where a reversal found it", () => {
    expect(peekContentOpacity("in", 10, 0.4)).toBe(0.4);
    expect(peekContentOpacity("out", CARD_PEEK_CONTENT_FADE_MS / 2, 0.4)).toBeCloseTo(0.2, 5);
  });
});

describe("card peek geometry (О3, О10, О11)", () => {
  it("interpolates a box side by side and scales it about its centre", () => {
    expectRect(lerpPeekRect(CARD, WINDOW, 0), CARD);
    expectRect(lerpPeekRect(CARD, WINDOW, 1), WINDOW);
    expectRect(lerpPeekRect(CARD, WINDOW, 0.5), { x: -60, y: 130, width: 600, height: 425 });
    expectRect(centerPeekRect(WINDOW, CARD_PEEK_CENTER_SCALE), { x: 25, y: 17.5, width: 950, height: 665 });
  });

  it("keeps the part of a box inside another, an empty box at the nearest edge otherwise", () => {
    expectRect(intersectPeekRect({ x: -50, y: 10, width: 100, height: 40 }, WINDOW), { x: 0, y: 10, width: 50, height: 40 });
    expectRect(intersectPeekRect({ x: 100, y: -300, width: 100, height: 100 }, WINDOW), { x: 100, y: 0, width: 100, height: 0 });
  });

  it("covers a box with a picture as object-cover does", () => {
    expectRect(coverPeekRect({ x: 0, y: 0, width: 100, height: 100 }, 200, 100), { x: -50, y: 0, width: 200, height: 100 });
    expectRect(coverPeekRect({ x: 0, y: 0, width: 200, height: 50 }, 100, 100), { x: 0, y: -75, width: 200, height: 200 });
  });

  it("maps a laid-out box onto a shown one", () => {
    expectRect(apply(WINDOW, peekBoxTransform(WINDOW, CARD)), CARD);
  });
});

describe("card peek step back (О15)", () => {
  it("takes its values from the window's own: half its leaving scale, half of M", () => {
    expect(CARD_PEEK_NUDGE_SCALE).toBeCloseTo(1 - 0.05 / 6, 6);
    expect(CARD_PEEK_NUDGE_OFFSET_PX).toBeCloseTo(40 / 6, 6);
  });

  it("moves the window down and back by its share, nothing at its place", () => {
    expect(peekNudgeTransform(0)).toBe("");
    expect(peekNudgeTransform(1)).toBe("translateY(6.667px) scale(0.991667)");
    expect(peekNudgeTransform(0.5)).toBe("translateY(3.333px) scale(0.995833)");
  });
});

describe("card peek window width (О3, О8)", () => {
  const PAD = 32;

  it("puts the panel beside the content while the widest window the right part holds has room for it", () => {
    // 4 × pad + W + the panel's 320 and its line, the window's line on both
    // sides: 128 + 680 + 321 + 2.
    expect(peekWindowLayout(1131, 680, PAD)).toBe("rail");
    expect(peekWindowLayout(1130, 680, PAD)).toBe("stacked");
    // A narrower content needs less room.
    expect(peekWindowLayout(851, 400, PAD)).toBe("rail");
    expect(peekWindowLayout(850, 400, PAD)).toBe("stacked");
  });

  it("decides by the place, not by the window's width: a window narrowed to its content widens again", () => {
    // Narrowed to a 400 px content the window is 466 px wide; the place
    // decides the panel beside it once it holds 851 px.
    expect(peekWindowLayout(900, 400, PAD)).toBe("rail");
  });

  it("is no wider than the content and its insets with the panel under it, the panel's widest beside it", () => {
    expect(cardPeekStackedMaxWidth(400)).toBe("calc(402px + 2 * var(--card-content-pad))");
    expect(CARD_PEEK_MAX_WIDTH).toBe("calc(1001px + 4 * var(--card-content-pad) + 2px)");
  });

  it("narrows and widens the window about its centre", () => {
    expectRect(centredPeekRect(WINDOW, 600), { x: 200, y: 0, width: 600, height: 700 });
    expectRect(centredPeekRect(WINDOW, 1200), { x: -100, y: 0, width: 1200, height: 700 });
  });
});

describe("card peek frame pieces (О12: no corner, line or letter stretched)", () => {
  const cut = peekFrameCut(0, 3);

  it("cuts round the larger corner, a corner piece overlapping the edges beside it", () => {
    expect(cut).toEqual({ round: 3, corner: 5 });
    expect(peekFrameCut(12, 3)).toEqual({ round: 12, corner: 14 });
  });

  it("puts every piece where the shown frame's own piece stands", () => {
    const transforms = peekFrameTransforms(WINDOW, CARD, cut);
    const laid = peekFramePieceBoxes(WINDOW.width, WINDOW.height, cut);
    const shown = peekFramePieceBoxes(CARD.width, CARD.height, cut);
    for (const piece of Object.keys(laid) as (keyof typeof laid)[]) {
      const target = shown[piece];
      expectRect(apply(laid[piece], transforms[piece]), { ...target, x: target.x + CARD.x, y: target.y + CARD.y });
    }
  });

  it("scales lines only along themselves and never scales a corner", () => {
    const transforms = peekFrameTransforms(WINDOW, CARD, cut);
    expect(parse(transforms.lineTop).sy).toBe(1);
    expect(parse(transforms.lineBottom).sy).toBe(1);
    expect(parse(transforms.lineLeft).sx).toBe(1);
    expect(parse(transforms.lineRight).sx).toBe(1);
    for (const corner of ["cornerTopLeft", "cornerTopRight", "cornerBottomLeft", "cornerBottomRight"] as const) {
      const t = parse(transforms[corner]);
      expect([t.sx, t.sy]).toEqual([1, 1]);
    }
  });

  it("keeps the bands of fill off the corners' curve", () => {
    const boxes = peekFramePieceBoxes(200, 150, cut);
    expect(boxes.bandAcross.y).toBe(cut.round);
    expect(boxes.bandDown.x).toBe(cut.round);
    expect(boxes.cornerTopLeft.width).toBeGreaterThan(cut.round);
  });

  it("scales the surface to the frame and the content back to its own size, on the frame's centre", () => {
    const { surface, content } = peekSurfaceTransforms(WINDOW, CARD);
    const s = parse(surface);
    const c = parse(content);
    // The content's net scale is one: no letter is stretched.
    expect(s.sx * c.sx).toBeCloseTo(1, 3);
    expect(s.sy * c.sy).toBeCloseTo(1, 3);
    // The content box (inside the 1px line) lands centred on the shown frame.
    const left = s.x + (1 + c.x) * s.sx;
    const top = s.y + (1 + c.y) * s.sy;
    expect(left + (WINDOW.width - 2) / 2).toBeCloseTo(CARD.x + CARD.width / 2, 2);
    expect(top + (WINDOW.height - 2) / 2).toBeCloseTo(CARD.y + CARD.height / 2, 2);
  });
});

describe("card peek picture (О10, п. 3)", () => {
  const laid = WINDOW;
  const clip = { x: 10, y: 20, width: 200, height: 100 };
  const image = { x: -40, y: 20, width: 300, height: 100 };

  it("shows the picture through its clip, uniformly scaled", () => {
    const transforms = peekMediaTransforms(laid, clip, image);
    expectRect(apply(laid, transforms.clip), clip);
    const c = parse(transforms.clip);
    const i = parse(transforms.image);
    const shownImage = {
      x: c.x + i.x * c.sx,
      y: c.y + i.y * c.sy,
      width: laid.width * i.sx * c.sx,
      height: laid.height * i.sy * c.sy,
    };
    expectRect(shownImage, image, 2);
  });

  it("goes from the card's crop to the whole picture with no switch", () => {
    // A 3:2 picture cropped square in the card, whole in the window.
    const cardClip = { x: 0, y: 0, width: 100, height: 100 };
    const cardImage = coverPeekRect(cardClip, 300, 200);
    const windowImage = { x: 200, y: 100, width: 600, height: 400 };
    let previousVisibleShare = 0;
    for (let step = 0; step <= 10; step += 1) {
      const p = step / 10;
      const shownClip = lerpPeekRect(cardClip, windowImage, p);
      const shownImage = lerpPeekRect(cardImage, windowImage, p);
      // The picture keeps its proportion all the way.
      expect(shownImage.width / shownImage.height).toBeCloseTo(1.5, 6);
      // The share of the picture shown only grows, to the whole of it.
      const share = (shownClip.width * shownClip.height) / (shownImage.width * shownImage.height);
      expect(share).toBeGreaterThanOrEqual(previousVisibleShare - 1e-9);
      previousVisibleShare = share;
    }
    expect(previousVisibleShare).toBeCloseTo(1, 6);
  });

  it("carries the card's crop into a window without a frame for it", () => {
    const place = carriedPeekMediaPlace(CARD, { clip: CARD, image: CARD }, WINDOW, 4, 3);
    expectRect(place.clip, WINDOW);
    expect(place.image.width / place.image.height).toBeCloseTo(4 / 3, 6);
  });
});

describe("card peek opening and closing (О10, О11, О13)", () => {
  const input = (overrides: Partial<PeekInput>): PeekInput => ({
    kind: "pointer",
    at: 1000,
    feedCardSlug: null,
    onGraph: false,
    inRightPart: false,
    ...overrides,
  });

  it("reads what opened the card from the last input", () => {
    expect(peekOpeningFrom(input({ feedCardSlug: "a" }), "a", 1010)).toBe("card");
    expect(peekOpeningFrom(input({ onGraph: true }), "a", 1010)).toBe("card");
    expect(peekOpeningFrom(input({ feedCardSlug: "b" }), "a", 1010)).toBe("elsewhere");
    expect(peekOpeningFrom(input({ kind: "key", inRightPart: true }), "a", 1010)).toBe("keyboard");
    expect(peekOpeningFrom(input({ kind: "key", inRightPart: false }), "a", 1010)).toBe("elsewhere");
    expect(peekOpeningFrom(input({ feedCardSlug: "a" }), "a", 1000 + CARD_PEEK_INPUT_WINDOW_MS + 1)).toBe("elsewhere");
    expect(peekOpeningFrom(null, "a", 0)).toBe("elsewhere");
  });

  it("grows out of a clicked card, fades for a key, comes out of the centre otherwise", () => {
    expect(peekOpeningKind({ from: "card", restored: false, reducedMotion: false })).toBe("card");
    expect(peekOpeningKind({ from: "keyboard", restored: false, reducedMotion: false })).toBe("fade");
    expect(peekOpeningKind({ from: "elsewhere", restored: false, reducedMotion: false })).toBe("center");
    expect(peekOpeningKind({ from: "card", restored: false, reducedMotion: true })).toBe("fade");
    expect(peekOpeningKind({ from: "card", restored: true, reducedMotion: false })).toBe("instant");
  });

  it("closes the way it came, to the centre when its card is gone", () => {
    const close = (overrides: Partial<Parameters<typeof peekClosingKind>[0]>) => peekClosingKind({
      openedAs: "card",
      exit: "return",
      reducedMotion: false,
      cardOnScreen: true,
      ...overrides,
    });
    expect(close({})).toBe("card");
    expect(close({ cardOnScreen: false })).toBe("center");
    expect(close({ exit: "center" })).toBe("center");
    expect(close({ openedAs: "center" })).toBe("center");
    expect(close({ openedAs: "fade" })).toBe("fade");
    expect(close({ openedAs: "fade", exit: "center" })).toBe("fade");
    expect(close({ exit: "fade" })).toBe("fade");
    expect(close({ reducedMotion: true })).toBe("fade");
    expect(close({ exit: "none" })).toBe("none");
  });
});
