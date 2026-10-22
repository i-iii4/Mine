// The stack of one to three mini-cards with real previews that opens on
// hover, after the channel icon of PLAN 7.23 (01.03.2026, `fa34940f`), back as the
// previews of a compact sidebar item (PLAN 50.36, 22.10.2026; DESIGN_SYSTEM.md,
// «Компактная строка боковой панели»).
//
// A compact item is shadcn's large menu button, which holds a 32px avatar
// (`size-8`, Mine's `--spacing-card-thumb`): the stack takes that height.
// The depth, the opening and its spring are the user's decisions of
// 22.10.2026 (below); the opening answers the hover-intent engine, not the plate's timing
// (global.css, «Compact rows»).

import type { CSSProperties } from "react";

/** Most cards a stack holds. */
export const CHANNEL_ICON_MAX_CARDS = 3;

/** The height the stack fills: the avatar of shadcn's `size="lg"` menu
 *  button, `size-8`, which is Mine's card-row thumbnail. One card's side. */
export const CHANNEL_ICON_HEIGHT_PX = 32;
export const CHANNEL_ICON_CARD_PX = CHANNEL_ICON_HEIGHT_PX;

/** Depth at rest (user's decision of 22.10.2026), one projection: each step
 *  back the card is `r` of the one before it, and its centre moves from the
 *  front card's centre toward one vanishing point `V` by the share it lost,
 *  `c_d = c_0 + (V − c_0)·(1 − r^d)`. Size, the shrinking step and the
 *  direction come from the same formula: the steps get shorter with depth
 *  and every centre lies on the line from `c_0` to `V`. `V` stands right of
 *  the stack at the height of its middle, from the front card's
 *  centre; `V.x` is solved so the back card ends where the 7.23 cascade ended
 *  (32 + 2 × 16/3 to the right of the front card's left edge). `r` 0.88 (user's
 *  remark of 22.10.2026: the depth read too faintly at 0.94). */
const DEPTH_REDUCTION = 0.88;
/** The 7.23 cascade's right end from the front card's left edge. */
const CASCADE_END_PX = 32 + 2 * (16 / 3);
const BACK_SCALE = DEPTH_REDUCTION ** 2;
const VANISHING_POINT = {
  // The back card's right edge lands on the cascade's end:
  // 16 + V.x·(1 − r²) + 16·r² = CASCADE_END_PX.
  x: (CASCADE_END_PX - 16 - 16 * BACK_SCALE) / (1 - BACK_SCALE),
  // On the cards' middle: a deck facing the viewer recedes evenly up and
  // down (user's decision of 22.10.2026).
  y: 0,
} as const;

/** Where the card `depth` steps behind the front one stands at rest: its
 *  scale and its centre's offset from the front card's centre, in px. */
export function channelIconDepth(depth: number): { scale: number; x: number; y: number } {
  const scale = DEPTH_REDUCTION ** depth;
  const share = 1 - scale;
  return { scale, x: VANISHING_POINT.x * share, y: VANISHING_POINT.y * share };
}

/** The stack's box: as wide as its cards reach, the front card's left edge
 *  to the back card's right one. */
export const CHANNEL_ICON_WIDTH_PX = Math.max(
  ...Array.from({ length: CHANNEL_ICON_MAX_CARDS }, (_, depth) => {
    const { scale, x } = channelIconDepth(depth);
    return CHANNEL_ICON_CARD_PX / 2 + x + (CHANNEL_ICON_CARD_PX / 2) * scale;
  }),
);

/** On hover the deck opens (user's decision of 22.10.2026, after a row of
 *  avatars that spreads under the pointer; it replaced a fan): the bottom
 *  card stays, the vanishing point moves away from it by this factor, so the
 *  cards above it slide toward the name in proportion to their distance from
 *  it and the steps stay shorter with depth. The top card slides
 *  `HOVER_TOP_SHIFT_PX`, the room the name's end leaves. Only the place
 *  moves: sizes stay, nothing turns. */
const HOVER_TOP_SHIFT_PX = 3;

/** How far card `depth` of a deck of `count` slides left on hover: its
 *  distance from the bottom card, times the vanishing point's growth. */
function hoverShift(depth: number, count: number): number {
  const bottom = channelIconDepth(count - 1).x;
  if (bottom === 0) return 0;
  return (bottom - channelIconDepth(depth).x) * (HOVER_TOP_SHIFT_PX / bottom);
}

/** Three decimals of a pixel or a scale: enough for the screen, short in CSS. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Every card is laid out where the front one is, its transform origin its
 *  own centre (the front card's centre), then moved to its place and scaled
 *  there. The same two functions at rest and on hover, so CSS interpolates
 *  them one by one. */
function cardTransform(x: number, y: number, scale: number): string {
  return `translate(${round(x)}px, ${round(y)}px) scale(${round(scale)})`;
}

/** The stack's spring, opening and closing alike (user's decision of
 *  22.10.2026; apple-design, «Поведение важнее анимации»): critically damped
 *  (ratio 1, no overshoot: a hover carries no momentum), response 0.3s. Its
 *  step response is x(t) = 1 − (1 + ωt)·e^(−ωt), ω = 2π / response; it lasts
 *  until it is within 0.1% of the target, (1 + ωt)·e^(−ωt) = 0.001, and runs
 *  as a CSS `linear()` easing of evenly spaced samples of x. */
const SPRING_RESPONSE_S = 0.3;
const SPRING_SETTLE = 0.001;
const SPRING_SAMPLES = 40;

function springRemainder(omegaT: number): number {
  return (1 + omegaT) * Math.exp(-omegaT);
}

/** ωt where the remainder, which falls monotonically, reaches the settle
 *  threshold: bisection. */
function springSettleOmegaT(): number {
  let low = 0;
  let high = 50;
  for (let step = 0; step < 60; step += 1) {
    const middle = (low + high) / 2;
    if (springRemainder(middle) > SPRING_SETTLE) low = middle;
    else high = middle;
  }
  return high;
}

const SETTLE_OMEGA_T = springSettleOmegaT();
const OMEGA = (2 * Math.PI) / SPRING_RESPONSE_S;

/** The movement's duration: the spring's settling time, ms. */
export const CHANNEL_ICON_SPRING_MS = Math.round((SETTLE_OMEGA_T / OMEGA) * 1000);

/** The spring as a CSS `linear()` easing, ending exactly on 1. */
export const CHANNEL_ICON_SPRING_EASING = `linear(${Array.from(
  { length: SPRING_SAMPLES + 1 },
  (_, index) => (index === SPRING_SAMPLES
    ? "1"
    : String(Math.round((1 - springRemainder((index / SPRING_SAMPLES) * SETTLE_OMEGA_T)) * 10000) / 10000)),
).join(", ")})`;

/** The stack box's own style: its size and the spring its cards move on. */
export function channelIconBoxStyle(): CSSProperties {
  // Custom properties by construction; CSSProperties has no key for them.
  return {
    width: CHANNEL_ICON_WIDTH_PX,
    height: CHANNEL_ICON_HEIGHT_PX,
    "--channel-icon-duration": `${CHANNEL_ICON_SPRING_MS}ms`,
    "--channel-icon-easing": CHANNEL_ICON_SPRING_EASING,
  } as CSSProperties;
}

/** Where card `index` of `count` stands, at rest and on hover. The last card
 *  is the front one, at the left; the ones behind recede toward the vanishing
 *  point (`channelIconDepth`). The two transforms are custom properties: the
 *  item's hover state picks one (global.css, «Compact rows»). The bottom
 *  card does not move. */
export function channelIconCardStyle(index: number, count: number): CSSProperties {
  const depth = count - 1 - index;
  const { scale, x, y } = channelIconDepth(depth);
  // Custom properties by construction; CSSProperties has no key for them.
  return {
    left: 0,
    width: CHANNEL_ICON_CARD_PX,
    height: CHANNEL_ICON_CARD_PX,
    zIndex: index,
    transformOrigin: "center",
    "--channel-icon-rest": cardTransform(x, y, scale),
    "--channel-icon-hover": cardTransform(x - hoverShift(depth, count), y, scale),
  } as CSSProperties;
}
