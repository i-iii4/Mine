// The relations between the values of motion (SPEC_MOTION_LEVELS.md, «Основания
// значений», «Отношения системы»; user's decision of 14.11.2026). A value is
// right when it has a basis of its own kind; the system is right when these
// relations hold over all the values together. Each check computes how a curve
// spreads its path over its time, from the values alone: no page, no frames.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CARD_PEEK_SPRING_MS, CARD_PEEK_SPRING_RESPONSE_S } from "@/lib/cardPeek";
import { SPRING_RESPONSE_S } from "@/lib/channelIcon";
import {
  MOTION_EASE,
  MOTION_ENTER_MS,
  MOTION_EXIT_MS,
  MOTION_MOVE_EASE,
  MOTION_MOVE_MS,
  MOTION_SPRING_MOVE_MS,
  MOTION_SURFACE_EASE,
  MOTION_SURFACE_MS,
} from "@/lib/motion";

/** A frame at 60 Hz, ms. */
const FRAME_MS = 1000 / 60;

/** `cubic-bezier(x1, y1, x2, y2)` as its four numbers. */
function points(curve: string): [number, number, number, number] {
  const numbers = /cubic-bezier\(([^)]+)\)/.exec(curve)?.[1]?.split(",").map((part) => Number(part.trim()));
  if (!numbers || numbers.length !== 4 || numbers.some((value) => Number.isNaN(value))) {
    throw new Error(`not a cubic-bezier: ${curve}`);
  }
  return [numbers[0]!, numbers[1]!, numbers[2]!, numbers[3]!];
}

/** The curve as the share of the path at a share of the time. */
function bezier(curve: string): (time: number) => number {
  const [x1, y1, x2, y2] = points(curve);
  return (time) => {
    let low = 0;
    let high = 1;
    for (let step = 0; step < 60; step += 1) {
      const middle = (low + high) / 2;
      const x = 3 * (1 - middle) ** 2 * middle * x1 + 3 * (1 - middle) * middle ** 2 * x2 + middle ** 3;
      if (x < time) low = middle;
      else high = middle;
    }
    const at = (low + high) / 2;
    return 3 * (1 - at) ** 2 * at * y1 + 3 * (1 - at) * at ** 2 * y2 + at ** 3;
  };
}

/** A critically damped spring of `responseS` as the share of the path at a
 *  time in ms. */
function spring(responseS: number): (ms: number) => number {
  const omega = (2 * Math.PI) / responseS;
  return (ms) => 1 - (1 + (omega * ms) / 1000) * Math.exp((-omega * ms) / 1000);
}

/** When `share` of the path is passed, ms, searched up to `limitMs`. */
function reaches(path: (ms: number) => number, share: number, limitMs: number): number {
  let low = 0;
  let high = limitMs;
  for (let step = 0; step < 60; step += 1) {
    const middle = (low + high) / 2;
    if (path(middle) < share) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/** How a motion spreads its path: the share its first frame takes, and how
 *  long the main part of the path lasts, from 10 % to 90 % of it. */
interface Profile {
  firstFrame: number;
  mainMs: number;
}

function curveProfile(curve: string, durationMs: number): Profile {
  const share = bezier(curve);
  const path = (ms: number) => share(Math.min(1, ms / durationMs));
  return { firstFrame: path(FRAME_MS), mainMs: reaches(path, 0.9, durationMs) - reaches(path, 0.1, durationMs) };
}

function springProfile(responseS: number): Profile {
  const path = spring(responseS);
  return { firstFrame: path(FRAME_MS), mainMs: reaches(path, 0.9, 2000) - reaches(path, 0.1, 2000) };
}

const css = readFileSync("src/styles/global.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const token = (name: string): string => {
  const value = new RegExp(`${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();
  if (value === undefined) throw new Error(`no token ${name}`);
  return value;
};

/** The card's lift, the product's own compact motion with a path (С8.4): its
 *  time and curve, read from the tokens. */
const liftUp = /^(\d+)ms var\(--card-lift-curve-up\)$/.exec(token("--lift-up"));
const LIFT = curveProfile(token("--card-lift-curve-up"), Number(liftUp?.[1]));
/** The card window's spring in Full: how a window moves when it flies. */
const WINDOW_SPRING = springProfile(CARD_PEEK_SPRING_RESPONSE_S);
/** The stack's spring in Full: the List and the table, the mark. */
const STACK_SPRING = springProfile(SPRING_RESPONSE_S);

describe("the system of motion values (SPEC_MOTION_LEVELS.md, «Отношения системы»)", () => {
  it("reads the references it compares with", () => {
    expect(liftUp).not.toBeNull();
    expect(LIFT.mainMs).toBeGreaterThan(80);
    expect(WINDOW_SPRING.mainMs).toBeGreaterThan(LIFT.mainMs);
  });

  it("moves a surface readably: no sharper than the card's lift, no slower than the window's flight", () => {
    const surface = curveProfile(MOTION_SURFACE_EASE, MOTION_SURFACE_MS);
    // The main part of the path lasts at least as long as the lift's, the
    // most compact motion of the product, and the first frame takes no more
    // than a fifth of the path: the motion is seen, not a cut.
    expect(surface.mainMs).toBeGreaterThanOrEqual(LIFT.mainMs);
    expect(surface.firstFrame).toBeLessThanOrEqual(0.2);
    // Minimal's window is this surface (ОУ2, ОУ3): more compact than Full's
    // flight, never slower.
    expect(surface.mainMs).toBeLessThanOrEqual(WINDOW_SPRING.mainMs);
    expect(MOTION_SURFACE_MS).toBeLessThanOrEqual(CARD_PEEK_SPRING_MS);
  });

  it("keeps the response curve off the surfaces: on it a window's leaving is a cut", () => {
    // The finding of 14.11.2026, kept as a check: E at a surface's time, and
    // at the times Minimal's window had, fails the rule above.
    for (const duration of [MOTION_EXIT_MS, MOTION_ENTER_MS, MOTION_SURFACE_MS]) {
      const onResponse = curveProfile(MOTION_EASE, duration);
      expect(onResponse.firstFrame > 0.2 || onResponse.mainMs < LIFT.mainMs).toBe(true);
    }
    expect(MOTION_SURFACE_EASE).not.toBe(MOTION_EASE);
  });

  it("orders the times by size: an answer, a popup, a surface, a move", () => {
    // A leaving is not longer than a coming of the same thing.
    expect(MOTION_EXIT_MS).toBeLessThanOrEqual(MOTION_ENTER_MS);
    expect(token("--motion-surface-exit")).toBe(token("--motion-surface-enter"));
    // A larger thing is not faster than a smaller one.
    expect(MOTION_ENTER_MS).toBeLessThanOrEqual(MOTION_SURFACE_MS);
    expect(MOTION_ENTER_MS).toBeLessThanOrEqual(MOTION_MOVE_MS);
  });

  it("carries a thing across the page the same way in every place: one kind, one value", () => {
    // The calm move that stands in for a spring in Minimal is Перемещение.
    expect(MOTION_SPRING_MOVE_MS).toBe(MOTION_MOVE_MS);
    const move = curveProfile(MOTION_MOVE_EASE, MOTION_SPRING_MOVE_MS);
    // Seen, and no slower than the springs it stands in for.
    expect(move.mainMs).toBeGreaterThanOrEqual(LIFT.mainMs);
    expect(move.firstFrame).toBeLessThanOrEqual(0.2);
    expect(move.mainMs).toBeLessThanOrEqual(WINDOW_SPRING.mainMs);
    expect(move.mainMs).toBeLessThanOrEqual(STACK_SPRING.mainMs);
  });

  it("keeps the tokens of the stylesheet equal to the values in code", () => {
    expect(token("--motion-surface-ease")).toBe(MOTION_SURFACE_EASE);
    expect(token("--motion-surface-enter")).toBe(`${MOTION_SURFACE_MS}ms`);
    expect(token("--motion-move")).toBe(`${MOTION_MOVE_MS}ms`);
    expect(token("--motion-move-ease")).toBe(MOTION_MOVE_EASE);
  });
});
