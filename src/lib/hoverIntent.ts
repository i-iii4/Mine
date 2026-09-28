// Which card or sidebar row the pointer is really attending to
// (SPEC_CARD_STATES.md, С7).
//
// The pointer on its way somewhere crosses a dozen cards and rows. Answering
// every one of them at once turned the interface into a blinking tree. This
// engine turns raw pointer movement into two calmer answers:
//
// - `slow`: the target under a slow or resting pointer, at once. The sidebar
//   lights a row's name from it: the row the click will reach, but not every
//   row a fast sweep crosses.
// - `chosen`: the target the pointer has attended to, after a short dwell at
//   slow speed. The collection links (pills, the lit feed, a row's button, the
//   big preview) answer this one.
//
// Pure: no React, no DOM. Time and timers come from a clock, so every rule is
// testable to the millisecond.

/**
 * Every number of С7 lives here; change them only together with the spec.
 * The starting values are tuned by the browser acceptance.
 */
export const HOVER_INTENT = {
  /** С7.1: how long a slow pointer rests on a target before it is chosen. */
  dwellMs: 300,
  /**
   * С7.2: the fastest the pointer may move, in px/ms, and still be attending.
   * Deliberate aiming ends well below it; crossing the feed runs at 1 to 3.
   */
  maxSpeed: 0.25,
  /** С7.2: the stretch of recent movement the speed is measured over. */
  velocityWindowMs: 60,
  /**
   * С7.3, С7.4: after the pointer leaves the chosen target, neighbours answer
   * a slow pointer at once for this long, and a pointer moving fast over other
   * targets keeps the old answer for this long instead of blinking through
   * every target it crosses. 800 ms read as the answer sticking.
   */
  warmMs: 400,
  /**
   * С7.4: a pointer that leaves the feed or the sidebar, or slows down or
   * stops over empty space, clears the answer after this. It still bridges a
   * gap between two cards crossed at attending speed.
   */
  leaveGraceMs: 150,
  /** С7.5: quiet after the last scroll or reflow step. */
  scrollSettleMs: 150,
  /**
   * С7.6: answers fade in over `fadeInMs` and out over the shorter
   * `fadeOutMs`, so leaving reads as a response, not a lag. CSS holds the same
   * values as `--hover-intent-fade-in` and `--hover-intent-fade-out`; a test
   * keeps them equal.
   */
  fadeInMs: 150,
  fadeOutMs: 100,
} as const;

export type HoverIntentTiming = typeof HOVER_INTENT;

export interface HoverIntentState {
  slow: string | null;
  chosen: string | null;
}

export interface HoverIntentClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const browserClock: HoverIntentClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

interface Sample {
  x: number;
  y: number;
  t: number;
  /** Distance from the previous sample; infinite for the first one after entering. */
  step: number;
  /** Speed of that one step, px/ms. */
  stepSpeed: number;
}

/**
 * Pointer events come about once a frame while the pointer moves. A step after
 * a pause is timed as one frame, not as the whole pause: the pointer was still,
 * then moved that far in a frame.
 */
const FRAME_MS = 16;
const MIN_STEP_MS = 4;

export class HoverIntent {
  private readonly clock: HoverIntentClock;
  private readonly timing: HoverIntentTiming;
  private readonly onChange: (state: HoverIntentState) => void;

  private samples: Sample[] = [];
  private lastPoint: { x: number; y: number } | null = null;
  private under: string | null = null;
  private inside = false;
  private leftAt = 0;
  /** Content moved under a still pointer: nothing answers until it moves. */
  private needsMove = false;
  private quietUntil = -Infinity;
  private suspended = false;

  private candidate: { target: string; since: number } | null = null;
  private chosen: string | null = null;
  /** +Infinity while the pointer is on the chosen target. */
  private warmUntil = -Infinity;
  /** Since when a slow or resting pointer has been over no target. */
  private idleSince: number | null = null;
  private slow: string | null = null;
  private lastEmittedChosen: string | null = null;

  private timer: unknown = null;

  constructor(
    onChange: (state: HoverIntentState) => void,
    clock: HoverIntentClock = browserClock,
    timing: HoverIntentTiming = HOVER_INTENT,
  ) {
    this.onChange = onChange;
    this.clock = clock;
    this.timing = timing;
  }

  get state(): HoverIntentState {
    return { slow: this.slow, chosen: this.chosen };
  }

  /** Whether the pointer is slow enough to be attending right now. */
  isSlow(): boolean {
    return this.speed(this.clock.now()) <= this.timing.maxSpeed;
  }

  /**
   * The pointer is over the surface at (x, y), above `target` or a gap
   * (`null`). A report at the same point is not movement: WebKit repeats the
   * last point when content slides under a still pointer.
   */
  move(target: string | null, x: number, y: number): void {
    const now = this.clock.now();
    const last = this.lastPoint;
    // The first point after entering says nothing about speed: until the
    // window has passed, the pointer may be sweeping straight through.
    const step = last ? Math.hypot(x - last.x, y - last.y) : Infinity;
    if (!last || step > 0) {
      const previous = this.samples[this.samples.length - 1];
      const elapsed = previous ? Math.min(Math.max(now - previous.t, MIN_STEP_MS), FRAME_MS) : FRAME_MS;
      this.samples.push({ x, y, t: now, step, stepSpeed: step / elapsed });
      this.lastPoint = { x, y };
      // Entering the surface or moving across it is the pointer's own doing.
      this.needsMove = false;
    }
    this.under = target;
    this.inside = true;
    this.evaluate(now);
  }

  /** The pointer left the surface. */
  leave(): void {
    const now = this.clock.now();
    this.inside = false;
    this.under = null;
    this.leftAt = now;
    this.lastPoint = null;
    this.samples = [];
    this.evaluate(now);
  }

  /**
   * Content moved under the pointer: a scroll step or a reflow. The current
   * answer fades once, nothing new answers until the content settles and the
   * pointer really moves (С7.5).
   */
  displace(): void {
    const now = this.clock.now();
    this.quietUntil = now + this.timing.scrollSettleMs;
    this.needsMove = true;
    this.candidate = null;
    this.chosen = null;
    this.warmUntil = -Infinity;
    this.evaluate(now);
  }

  /**
   * A drag, an open menu or an unfocused window: nothing answers meanwhile,
   * and the current answer clears at once (С7.8).
   */
  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    const now = this.clock.now();
    if (suspended) {
      this.candidate = null;
      this.chosen = null;
      this.warmUntil = -Infinity;
    }
    this.evaluate(now);
  }

  dispose(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Pointer speed in px/ms: the distance covered over the velocity window, or
   * the latest step's own speed when that is higher, so a sweep that starts
   * after a pause reads as fast from its first step. A resting pointer reads 0
   * once its last step ages out of the window.
   */
  private speed(now: number): number {
    const from = now - this.timing.velocityWindowMs;
    let distance = 0;
    let fastestStep = 0;
    for (let index = this.samples.length - 1; index >= 0; index -= 1) {
      const sample = this.samples[index]!;
      if (sample.t <= from) break;
      distance += sample.step;
      fastestStep = Math.max(fastestStep, sample.stepSpeed);
    }
    return Math.max(distance / this.timing.velocityWindowMs, fastestStep);
  }

  private evaluate(now: number): void {
    const { dwellMs, maxSpeed, velocityWindowMs } = this.timing;
    // Keep only what the speed can still read.
    const horizon = now - velocityWindowMs;
    while (this.samples.length > 1 && this.samples[1]!.t <= horizon) this.samples.shift();

    const speed = this.speed(now);
    const attending = this.inside && !this.suspended && !this.needsMove && now >= this.quietUntil;
    const slow = attending && this.under !== null && speed <= maxSpeed ? this.under : null;

    if (slow === null) {
      this.candidate = null;
    } else if (this.candidate?.target !== slow) {
      this.candidate = { target: slow, since: now };
    }

    // A slow or resting pointer over empty space is attending to nothing.
    const idle = attending && this.under === null && speed <= maxSpeed;
    if (!idle) this.idleSince = null;
    else if (this.idleSince === null) this.idleSince = now;

    // The pointer is on the chosen target, or has just left it.
    if (this.chosen !== null) {
      if (this.under === this.chosen && this.inside) {
        this.warmUntil = Infinity;
      } else if (this.warmUntil === Infinity) {
        this.warmUntil = now + this.timing.warmMs;
      }
    }

    const warm = now < this.warmUntil;
    if (this.candidate && (warm || now - this.candidate.since >= dwellMs)) {
      this.chosen = this.candidate.target;
      this.warmUntil = Infinity;
    } else if (this.chosen !== null && this.under !== this.chosen && now >= this.releaseAt()) {
      this.chosen = null;
    }

    if (slow !== this.slow || this.chosen !== this.lastEmittedChosen) {
      this.slow = slow;
      this.lastEmittedChosen = this.chosen;
      this.onChange({ slow: this.slow, chosen: this.chosen });
    }
    this.schedule(now, speed);
  }

  /**
   * When the answer for a target the pointer has left clears: after the
   * leave grace once the pointer has left the surface or idles over empty
   * space (С7.4), otherwise at the end of the warm window, while it keeps
   * moving fast.
   */
  private releaseAt(): number {
    const { leaveGraceMs } = this.timing;
    if (!this.inside) return this.leftAt + leaveGraceMs;
    if (this.idleSince !== null) return Math.min(this.idleSince + leaveGraceMs, this.warmUntil);
    return this.warmUntil;
  }

  /** One timer: the next moment an answer could change without new input. */
  private schedule(now: number, speed: number): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    const { dwellMs, velocityWindowMs } = this.timing;
    const moments: number[] = [];
    // Speed decays as samples age out: a resting pointer becomes slow.
    if (speed > 0) {
      const newest = this.samples[this.samples.length - 1];
      if (newest) moments.push(newest.t + velocityWindowMs);
    }
    if (this.candidate && this.chosen !== this.candidate.target) {
      moments.push(this.candidate.since + dwellMs);
    }
    if (this.chosen !== null && this.under !== this.chosen) {
      moments.push(this.releaseAt());
    }
    if (now < this.quietUntil) moments.push(this.quietUntil);
    const next = Math.min(...moments.filter((moment) => moment > now && Number.isFinite(moment)));
    if (!Number.isFinite(next)) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.evaluate(this.clock.now());
    }, next - now);
  }
}
