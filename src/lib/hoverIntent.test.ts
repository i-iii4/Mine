import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOVER_INTENT, HoverIntent, type HoverIntentClock, type HoverIntentState } from "./hoverIntent";

/** A clock that only moves when the test says so. */
function fakeClock() {
  let now = 0;
  let pending: { at: number; callback: () => void; id: number } | null = null;
  let nextId = 1;
  const clock: HoverIntentClock = {
    now: () => now,
    setTimeout: (callback, ms) => {
      pending = { at: now + ms, callback, id: nextId++ };
      return pending.id;
    },
    clearTimeout: (handle) => {
      if (pending?.id === handle) pending = null;
    },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    while (pending && pending.at <= target) {
      const due = pending;
      pending = null;
      now = due.at;
      due.callback();
    }
    now = target;
  };
  return { clock, advance, get now() { return now; } };
}

function setup() {
  const time = fakeClock();
  const changes: HoverIntentState[] = [];
  const intent = new HoverIntent((state) => changes.push(state), time.clock);
  // The pointer is already over the surface, in a gap, at rest.
  intent.move(null, 0, 100);
  time.advance(100);
  let x = 0;
  /** Move to `target` at `speed` px/ms, one event every 8 ms, for `ms`. */
  const glide = (target: string | null, speed: number, ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 8) {
      time.advance(8);
      x += speed * 8;
      intent.move(target, x, 100);
    }
  };
  /** One small step onto `target`, then rest. */
  const arrive = (target: string | null) => {
    time.advance(8);
    x += 1;
    intent.move(target, x, 100);
  };
  const chosenHistory = () => changes.map((state) => state.chosen).filter((value, index, all) => index === 0 || value !== all[index - 1]);
  return { time, intent, changes, glide, arrive, chosenHistory };
}

describe("hover intent (SPEC_CARD_STATES.md, С7)", () => {
  it("С7.1: chooses a target after the pointer rests on it for the dwell", () => {
    const { time, intent, arrive } = setup();
    arrive("a");
    time.advance(HOVER_INTENT.dwellMs - 20);
    expect(intent.state.chosen).toBeNull();
    time.advance(40);
    expect(intent.state.chosen).toBe("a");
  });

  it("С7.2: a pointer crossing targets at ordinary speed chooses nothing and lights nothing", () => {
    const { intent, glide, changes } = setup();
    for (const target of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]) glide(target, 1.5, 120);
    expect(intent.state.chosen).toBeNull();
    expect(changes.every((state) => state.chosen === null && state.slow === null)).toBe(true);
  });

  it("С7.2: a slow pointer lights the target under it at once, before any dwell", () => {
    const { intent, glide } = setup();
    glide("a", 0.1, 16);
    expect(intent.state.slow).toBe("a");
    expect(intent.state.chosen).toBeNull();
  });

  it("С7.2: fast movement resets the dwell", () => {
    const { time, intent, arrive, glide } = setup();
    arrive("a");
    time.advance(200);
    glide("a", 1, 40);
    time.advance(200);
    expect(intent.state.chosen).toBeNull();
    time.advance(200);
    expect(intent.state.chosen).toBe("a");
  });

  it("С7.3: once warm, a neighbour reached slowly is chosen at once, with no blank between", () => {
    const { time, intent, arrive, glide, chosenHistory } = setup();
    arrive("a");
    time.advance(HOVER_INTENT.dwellMs + 10);
    glide("b", 0.2, 24);
    expect(intent.state.chosen).toBe("b");
    expect(chosenHistory()).toEqual([null, "a", "b"].slice(chosenHistory()[0] === null ? 0 : 1));
    expect(chosenHistory()).not.toContain(undefined);
  });

  it("С7.4: a fast pass keeps the last answer instead of blinking through each target", () => {
    const { time, intent, arrive, glide, chosenHistory } = setup();
    arrive("a");
    time.advance(HOVER_INTENT.dwellMs + 10);
    for (const target of ["b", "c", "d"]) glide(target, 2, 40);
    expect(intent.state.chosen).toBe("a");
    // Coming to rest on a new target within the warm window switches straight to it.
    time.advance(HOVER_INTENT.velocityWindowMs + 10);
    expect(intent.state.chosen).toBe("d");
    expect(chosenHistory().filter((value) => value !== null)).toEqual(["a", "d"]);
  });

  it("С7.4: a pointer moving fast over empty space keeps the answer only for the warm window", () => {
    const { time, intent, arrive, glide } = setup();
    arrive("a");
    time.advance(HOVER_INTENT.dwellMs + 10);
    glide(null, 1.5, HOVER_INTENT.warmMs - 40);
    expect(intent.state.chosen).toBe("a");
    glide(null, 1.5, 80);
    expect(intent.state.chosen).toBeNull();
  });

  it("С7.4: a pointer that slows or stops over empty space clears the answer after the leave grace, not the warm window", () => {
    const { time, intent, arrive, glide } = setup();
    arrive("a");
    time.advance(HOVER_INTENT.dwellMs + 10);
    // Leaves the card fast and stops in the gap.
    glide(null, 1.5, 24);
    time.advance(HOVER_INTENT.velocityWindowMs + HOVER_INTENT.leaveGraceMs - 20);
    expect(intent.state.chosen).toBe("a");
    time.advance(40);
    expect(intent.state.chosen).toBeNull();
    expect(time.now).toBeLessThan(HOVER_INTENT.warmMs + 400);
  });

  it("С7.4: a gap crossed slowly between two cards does not blink the answer", () => {
    const { time, intent, arrive, glide, chosenHistory } = setup();
    arrive("a");
    time.advance(HOVER_INTENT.dwellMs + 10);
    // A 24 px gap at attending speed takes 120 ms, inside the leave grace.
    glide(null, 0.2, 120);
    glide("b", 0.2, 16);
    expect(intent.state.chosen).toBe("b");
    expect(chosenHistory().slice(chosenHistory().indexOf("a"))).toEqual(["a", "b"]);
  });

  it("С7.4: leaving the surface clears the answer after the leave grace", () => {
    const { time, intent, arrive } = setup();
    arrive("a");
    time.advance(HOVER_INTENT.dwellMs + 10);
    intent.leave();
    time.advance(HOVER_INTENT.leaveGraceMs - 10);
    expect(intent.state.chosen).toBe("a");
    time.advance(20);
    expect(intent.state.chosen).toBeNull();
  });

  it("С7.5: a scroll clears the answer once and a card that slides under a still pointer never answers", () => {
    const { time, intent, arrive, changes } = setup();
    arrive("a");
    time.advance(HOVER_INTENT.dwellMs + 10);
    const before = changes.length;
    for (let step = 0; step < 20; step += 1) {
      time.advance(16);
      intent.displace();
      // WebKit reports the same point over whatever card is now under it.
      intent.move(`slid-${step}`, 301, 100);
    }
    time.advance(2000);
    expect(intent.state.chosen).toBeNull();
    expect(intent.state.slow).toBeNull();
    expect(changes.slice(before).filter((state) => state.chosen !== null)).toHaveLength(0);
  });

  it("С7.5: after the scroll settles, real movement and the dwell choose again", () => {
    const { time, intent, arrive } = setup();
    intent.displace();
    time.advance(HOVER_INTENT.scrollSettleMs + 10);
    arrive("b");
    time.advance(HOVER_INTENT.dwellMs + 10);
    expect(intent.state.chosen).toBe("b");
  });

  it("С7.5: nothing is chosen while the content is still settling", () => {
    const { time, intent, arrive } = setup();
    arrive("a");
    intent.displace();
    time.advance(20);
    arrive("a");
    time.advance(HOVER_INTENT.scrollSettleMs - 40);
    expect(intent.state.slow).toBeNull();
    time.advance(HOVER_INTENT.dwellMs + 200);
    expect(intent.state.chosen).toBe("a");
  });

  it("С7.8: a suspension clears the answer and holds new ones until it ends", () => {
    const { time, intent, arrive } = setup();
    arrive("a");
    time.advance(HOVER_INTENT.dwellMs + 10);
    intent.setSuspended(true);
    expect(intent.state.chosen).toBeNull();
    arrive("b");
    time.advance(1000);
    expect(intent.state.chosen).toBeNull();
    intent.setSuspended(false);
    arrive("b");
    time.advance(HOVER_INTENT.dwellMs + 10);
    expect(intent.state.chosen).toBe("b");
  });

  it("С7.6: the fades in CSS match the engine's, and leaving is the faster one", () => {
    const css = readFileSync("src/styles/global.css", "utf8");
    expect(css).toContain(`--hover-intent-fade-in: ${HOVER_INTENT.fadeInMs}ms`);
    expect(css).toContain(`--hover-intent-fade-out: ${HOVER_INTENT.fadeOutMs}ms`);
    expect(HOVER_INTENT.fadeOutMs).toBeLessThan(HOVER_INTENT.fadeInMs);
  });
});
