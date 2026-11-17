// The spring of the interface's own moves (user's decision of 22.10.2026;
// apple-design, «Поведение важнее анимации»): critically damped (ratio 1, no
// overshoot), response 0.3s. Its members are those of Пружина
// (SPEC_MOTION_LEVELS.md, РД4): the turn of the Contents list's mark
// (Sidebar.tsx), the rows' move between the List and the table
// (sidebarListMorph.ts), the preview window (hoverPreviewWindow.ts). The
// card's window has a spring of its own response and takes the settling rule
// from here (cardPeek.ts).
//
// The step response is x(t) = 1 − (1 + ωt)·e^(−ωt), ω = 2π / response; it
// lasts until it is within 0.1% of the target, (1 + ωt)·e^(−ωt) = 0.001, and
// runs as a CSS `linear()` easing of evenly spaced samples of x.

import type { CSSProperties } from "react";
import { cubicBezierCurve } from "./cubicBezier";
import { MOTION_MOVE_EASE, MOTION_SPRING_MOVE_MS, type SpringMotion } from "./motion";

export const SPRING_RESPONSE_S = 0.3;
export const SPRING_SETTLE = 0.001;
export const SPRING_SAMPLES = 40;

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

/** The spring's settling time from rest, ms: a move's duration. */
export const SPRING_MS = Math.round((SETTLE_OMEGA_T / OMEGA) * 1000);

/** The settling time, ms, of a critically damped spring of `responseS`,
 *  by the same rule: within 0.1% of its target (the card's window,
 *  cardPeek.ts, has a spring of its own). */
export function springSettleMs(responseS: number): number {
  return Math.round((SETTLE_OMEGA_T / ((2 * Math.PI) / responseS)) * 1000);
}

/** The spring from rest as a CSS `linear()` easing, ending exactly on 1. */
export const SPRING_EASING = `linear(${Array.from(
  { length: SPRING_SAMPLES + 1 },
  (_, index) => (index === SPRING_SAMPLES
    ? "1"
    : String(Math.round((1 - springRemainder((index / SPRING_SAMPLES) * SETTLE_OMEGA_T)) * 10000) / 10000)),
).join(", ")})`;

/** How a CSS move on the spring runs, as custom properties: the Contents
 *  list's plus turning into a cross (global.css, «List sidebar»), a member
 *  of Пружина (SPEC_MOTION_LEVELS.md, РД4). The mark turns on a press (С7):
 *  on the spring in Full, by the calm move that stands in for a spring in
 *  Minimal; at Off global.css does not turn it. */
export function springStyle(motion: SpringMotion): CSSProperties {
  if (motion === "instant") return {};
  // Custom properties by construction; CSSProperties has no key for them.
  if (motion === "move") {
    return {
      "--spring-duration": `${MOTION_SPRING_MOVE_MS}ms`,
      "--spring-easing": MOTION_MOVE_EASE,
    } as CSSProperties;
  }
  return {
    "--spring-duration": `${SPRING_MS}ms`,
    "--spring-easing": SPRING_EASING,
  } as CSSProperties;
}

// ─── A run, as WAAPI plays it ───────────────────────────────────────────

/** The spring's distance from its target `t` seconds in, from −1 (the start)
 *  with velocity `v` per second: a critically damped spring from
 *  displacement d₀ and velocity v₀ is d(t) = (d₀ + (v₀ + ωd₀)t)·e^(−ωt). */
function springOffset(t: number, v: number): number {
  return (-1 + (v - OMEGA) * t) * Math.exp(-OMEGA * t);
}

/** Where the spring's settling is looked for, backwards from a time it has
 *  surely settled by: steps this fine of its response, then bisection. */
const SETTLE_SCAN_STEPS_PER_RESPONSE = 1000;
const SETTLE_BISECTIONS = 60;

/** When the spring from rest at −1 with velocity `v` comes within the
 *  settle threshold for good, seconds. `(1 + |v − ω|·t)·e^(−ωt)` bounds the
 *  offset and falls after its peak, so once it is under the threshold the
 *  spring is too; the last crossing before that is the settling time. */
function springSettleSeconds(v: number): number {
  const slope = Math.abs(v - OMEGA);
  const bound = (t: number) => (1 + slope * t) * Math.exp(-OMEGA * t);
  let late = slope > OMEGA ? (slope - OMEGA) / (slope * OMEGA) : 0;
  while (bound(late) > SPRING_SETTLE) late += SPRING_RESPONSE_S;
  const step = SPRING_RESPONSE_S / SETTLE_SCAN_STEPS_PER_RESPONSE;
  let low = late;
  while (low > 0 && Math.abs(springOffset(low, v)) <= SPRING_SETTLE) low = Math.max(0, low - step);
  let high = Math.min(late, low + step);
  for (let index = 0; index < SETTLE_BISECTIONS; index += 1) {
    const middle = (low + high) / 2;
    if (Math.abs(springOffset(middle, v)) > SPRING_SETTLE) low = middle;
    else high = middle;
  }
  return high;
}

/** One run from 0 to 1, as WAAPI plays it. */
export interface SpringRun {
  /** Its settling time, ms: the animation's duration. */
  durationMs: number;
  /** The CSS easing: a `linear()` of evenly spaced samples, ending on 1. */
  easing: string;
  /** The eased progress `elapsedMs` in, as that easing renders it. */
  progress: (elapsedMs: number) => number;
  /** How fast the rendered progress changes `elapsedMs` in, per second. */
  speed: (elapsedMs: number) => number;
}

/** The spring's run from progress 0 to 1, starting with velocity `v`
 *  (progress per second). At rest, `v` 0, it is `SPRING_EASING` over
 *  `SPRING_MS`; a turn mid-move starts at the speed the move had, so it
 *  brakes without a jump. */
export function springRun(v = 0): SpringRun {
  const settle = springSettleSeconds(v);
  const samples = Array.from({ length: SPRING_SAMPLES + 1 }, (_, index) => (index === SPRING_SAMPLES
    ? 1
    : Math.round((1 + springOffset((index / SPRING_SAMPLES) * settle, v)) * 10000) / 10000));
  const durationMs = Math.round(settle * 1000);
  const segment = (elapsedMs: number) => {
    const at = Math.min(1, Math.max(0, elapsedMs / durationMs)) * SPRING_SAMPLES;
    const index = Math.min(SPRING_SAMPLES - 1, Math.floor(at));
    return { index, within: at - index };
  };
  return {
    durationMs,
    easing: `linear(${samples.join(", ")})`,
    progress(elapsedMs) {
      if (elapsedMs >= durationMs) return 1;
      const { index, within } = segment(elapsedMs);
      return samples[index]! + (samples[index + 1]! - samples[index]!) * within;
    },
    speed(elapsedMs) {
      if (elapsedMs >= durationMs || elapsedMs < 0) return 0;
      const { index } = segment(elapsedMs);
      return ((samples[index + 1]! - samples[index]!) * SPRING_SAMPLES) / (durationMs / 1000);
    },
  };
}

/** The move curve as a function: Minimal's move in place of the spring. */
const moveEase = cubicBezierCurve(MOTION_MOVE_EASE);

/** The step, as a share of the time, that `speed` reads the curve's slope
 *  over. */
const MOVE_SLOPE_STEP = 1e-3;

/** Minimal's run from 0 to 1 in place of the spring (SPEC_MOTION_LEVELS.md,
 *  С3, РД4): Перемещение's time on the move curve, from rest, whatever
 *  speed the run it turns had. The same shape as the spring's, so a move
 *  plays either. */
export function moveRun(durationMs: number = MOTION_SPRING_MOVE_MS): SpringRun {
  const share = (elapsedMs: number) => Math.min(1, Math.max(0, elapsedMs / durationMs));
  return {
    durationMs,
    easing: MOTION_MOVE_EASE,
    progress(elapsedMs) {
      if (elapsedMs >= durationMs) return 1;
      return moveEase(share(elapsedMs));
    },
    speed(elapsedMs) {
      if (elapsedMs >= durationMs || elapsedMs < 0) return 0;
      const at = share(elapsedMs);
      const before = Math.max(0, at - MOVE_SLOPE_STEP);
      const after = Math.min(1, at + MOVE_SLOPE_STEP);
      return ((moveEase(after) - moveEase(before)) / (after - before)) / (durationMs / 1000);
    },
  };
}
