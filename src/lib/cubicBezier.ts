// A CSS timing curve evaluated in code: where a motion driven by the
// compositor stands at a given moment, so the next motion starts from there
// (SPEC_MOTION_LEVELS.md, УД8, ОУ4). The browser draws the same curve from
// the same string.

/** The four control values of a `cubic-bezier()`. */
export type CubicBezierPoints = readonly [x1: number, y1: number, x2: number, y2: number];

/** How close the solved time's share comes to the asked one. */
const SOLVE_EPSILON = 1e-7;
/** Newton steps before the bisection takes over. */
const NEWTON_STEPS = 8;
/** Bisection steps at most: halves the share's range down to 2⁻⁴⁰. */
const BISECTION_STEPS = 40;

const CUBIC_BEZIER_PATTERN = /^cubic-bezier\(\s*([^,\s]+)\s*,\s*([^,\s]+)\s*,\s*([^,\s]+)\s*,\s*([^,\s)]+)\s*\)$/;

/** The control values of a CSS `cubic-bezier(x1, y1, x2, y2)` string, or
 *  null when the string is no such curve. */
export function parseCubicBezier(value: string): CubicBezierPoints | null {
  const match = CUBIC_BEZIER_PATTERN.exec(value.trim());
  if (!match) return null;
  const points = match.slice(1, 5).map(Number);
  if (points.some((point) => !Number.isFinite(point))) return null;
  const [x1, y1, x2, y2] = points;
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return null;
  // CSS keeps the time's controls in 0..1, so time runs one way only.
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return null;
  return [x1, y1, x2, y2];
}

/** The curve as a function: the share of the way gone at a share `t` of the
 *  time, both 0 at the start and 1 at the end, as CSS evaluates it. */
export function cubicBezier([x1, y1, x2, y2]: CubicBezierPoints): (t: number) => number {
  // Each axis a polynomial in the curve's own parameter u: a·u³ + b·u² + c·u.
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const xAt = (u: number) => ((ax * u + bx) * u + cx) * u;
  const yAt = (u: number) => ((ay * u + by) * u + cy) * u;
  const slopeX = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  const solve = (t: number) => {
    let u = t;
    for (let step = 0; step < NEWTON_STEPS; step += 1) {
      const error = xAt(u) - t;
      if (Math.abs(error) < SOLVE_EPSILON) return u;
      const slope = slopeX(u);
      if (Math.abs(slope) < SOLVE_EPSILON) break;
      u -= error / slope;
    }
    let low = 0;
    let high = 1;
    u = t;
    for (let step = 0; step < BISECTION_STEPS; step += 1) {
      const x = xAt(u);
      if (Math.abs(x - t) < SOLVE_EPSILON) return u;
      if (x < t) low = u;
      else high = u;
      u = (low + high) / 2;
    }
    return u;
  };
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return yAt(solve(t));
  };
}
