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

describe("the preview window's attending mode (SPEC_CARD_STATES.md, С7.11)", () => {
  it("has one threshold: on at or below it and off above it, going either way", () => {
    const { glide, intent, time } = setup();
    time.advance(HOVER_INTENT.velocityWindowMs);
    expect(intent.isAttending()).toBe(true);
    // The reading of steady movement runs a little above its speed.
    glide("a", HOVER_INTENT.previewSpeed * 0.9, 120);
    expect(intent.isAttending()).toBe(true);
    glide("a", HOVER_INTENT.previewSpeed * 3, 80);
    expect(intent.isAttending()).toBe(false);
    // No band to slow through: just under the threshold it is on again.
    glide("a", HOVER_INTENT.previewSpeed * 0.9, 120);
    expect(intent.isAttending()).toBe(true);
    glide("a", HOVER_INTENT.previewSpeed * 0.7, 120);
    expect(intent.isAttending()).toBe(true);
  });

  it("tells its listener when a pointer that stopped comes back on, with no new step", () => {
    const { glide, intent, time } = setup();
    let told = 0;
    intent.setAttendingListener(() => {
      told += 1;
    });
    glide("a", 5, 80);
    expect(told).toBe(1);
    expect(intent.isAttending()).toBe(false);
    time.advance(HOVER_INTENT.velocityWindowMs);
    expect(told).toBe(2);
    expect(intent.isAttending()).toBe(true);
  });

  it("stays off while the surface does not answer, and after content moved under a still pointer", () => {
    const { intent, time, arrive } = setup();
    time.advance(HOVER_INTENT.velocityWindowMs);
    intent.setSuspended(true);
    expect(intent.isAttending()).toBe(false);
    intent.setSuspended(false);
    expect(intent.isAttending()).toBe(true);
    intent.displace();
    expect(intent.isAttending()).toBe(false);
    time.advance(HOVER_INTENT.scrollSettleMs + HOVER_INTENT.velocityWindowMs);
    expect(intent.isAttending()).toBe(false);
    arrive("a");
    time.advance(HOVER_INTENT.velocityWindowMs);
    expect(intent.isAttending()).toBe(true);
  });

  it("does not move the slow answers' threshold", () => {
    const { glide, intent } = setup();
    glide("a", HOVER_INTENT.previewSpeed * 0.9, 120);
    expect(intent.isAttending()).toBe(true);
    expect(intent.isSlow()).toBe(false);
    expect(intent.state.slow).toBeNull();
  });
});

describe("a pointer that stopped after a fast arrival (SPEC_CARD_STATES.md, С8.6)", () => {
  // WebKit's clock is coarsened to milliseconds in seconds' arithmetic, so its
  // times carry rounding noise, and adding the window across a power of two drops
  // it: 2047.0000000000002 + 60 is exactly 2107. The window must read the same at
  // both ends, or the last sample stays fresh with no moment left to age it out.
  it("raises the card when the sample's age is read at a rounded moment", () => {
    const { time, intent } = setup();
    time.advance(2047.0000000000002 - time.now);
    expect(time.now).toBe(2047.0000000000002);
    intent.move("card", 500, 100);
    expect(intent.state.raised).toBeNull();
    time.advance(200);
    expect(intent.state.raised).toBe("card");
  });
});

describe("a menu going away from over a still pointer (SPEC_CARD_STATES.md, С7.8)", () => {
  /** On a card at rest at (1, 100), the point `arrive` reaches first. */
  const onRaisedCard = () => {
    const engine = setup();
    engine.arrive("card");
    engine.time.advance(HOVER_INTENT.velocityWindowMs + 10);
    expect(engine.intent.state.raised).toBe("card");
    return engine;
  };

  it("raises the card at once when the point comes back after a leave, with no movement", () => {
    const { time, intent } = onRaisedCard();
    // A right click: the menu opens under the pointer, and WebKit says it left.
    intent.setSuspended(true);
    intent.leave();
    time.advance(500);
    intent.setSuspended(false);
    expect(intent.state.raised).toBeNull();
    // The menu is gone, and WebKit tells the card under the same point.
    intent.move("card", 1, 100);
    expect(intent.state.raised).toBe("card");
  });

  it("raises the card at once when the menu lay over it and the point never changed", () => {
    const { time, intent } = onRaisedCard();
    intent.setSuspended(true);
    intent.move(null, 1, 100);
    time.advance(500);
    intent.setSuspended(false);
    expect(intent.state.raised).toBeNull();
    intent.move("card", 1, 100);
    expect(intent.state.raised).toBe("card");
  });

  it("С7.5: the same point after a leave does not lift the silence of a card that slid under the pointer", () => {
    const { time, intent } = onRaisedCard();
    intent.displace();
    intent.leave();
    time.advance(HOVER_INTENT.scrollSettleMs + 10);
    intent.move("other", 1, 100);
    time.advance(2000);
    expect(intent.state.raised).toBeNull();
    // A real step ends it.
    intent.move("other", 2, 100);
    time.advance(HOVER_INTENT.velocityWindowMs + 10);
    expect(intent.state.raised).toBe("other");
  });

  it("still reads entering at another point as unknown speed", () => {
    const { time, intent } = onRaisedCard();
    intent.leave();
    time.advance(500);
    intent.move("card", 40, 100);
    expect(intent.state.raised).toBeNull();
    time.advance(HOVER_INTENT.velocityWindowMs + 10);
    expect(intent.state.raised).toBe("card");
  });
});

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

describe("card lift arrival (SPEC_CARD_STATES.md, С8.6)", () => {
  const raisedHistory = (changes: HoverIntentState[]) =>
    changes.map((state) => state.raised).filter((value, index, all) => index === 0 || value !== all[index - 1]);

  it("lifts nothing while the pointer sweeps across cards", () => {
    const { glide, changes } = setup();
    // The first step after a rest is timed as one frame: 9 px/ms reads 4.5.
    glide("a", 9, 80);
    glide("b", 5, 80);
    glide("c", 5, 80);
    expect(changes.some((state) => state.raised !== null)).toBe(false);
  });

  it("lifts the card at once when the pointer arrives at lifting speed, with no dwell", () => {
    const { glide, intent } = setup();
    glide("a", HOVER_INTENT.liftEntrySpeed * 0.8, 8);
    expect(intent.state.raised).toBe("a");
    expect(intent.state.chosen).toBeNull();
  });

  it("keeps the lift mode on up to the exit speed: the next card lifts at a speed the entry would not allow", () => {
    const { glide, arrive, intent } = setup();
    arrive("a");
    expect(intent.state.raised).toBe("a");
    glide("b", HOVER_INTENT.liftExitSpeed, 40);
    expect(intent.state.raised).toBe("b");
  });

  it("turns the lift mode off above the exit speed, and takes it back only at the entry speed", () => {
    const { glide, intent } = setup();
    glide("a", HOVER_INTENT.liftExitSpeed * 3, 80);
    expect(intent.state.raised).toBeNull();
    // Slowed, but between the two thresholds: the mode stays off.
    glide("b", (HOVER_INTENT.liftEntrySpeed + HOVER_INTENT.liftExitSpeed) / 2, 120);
    expect(intent.state.raised).toBeNull();
    glide("c", HOVER_INTENT.liftEntrySpeed * 0.9, 120);
    expect(intent.state.raised).toBe("c");
  });

  it("holds the mode's exit at the values the spec names", () => {
    expect(HOVER_INTENT.liftEntrySpeed).toBe(3);
    expect(HOVER_INTENT.liftExitSpeed).toBe(3.5);
    expect(HOVER_INTENT.maxSpeed).toBe(0.25);
    expect(HOVER_INTENT.previewSpeed).toBe(0.5);
  });

  it("lifts the card a fast pointer stops on within the velocity window", () => {
    const { glide, time, intent } = setup();
    glide("a", 9, 80);
    expect(intent.state.raised).toBeNull();
    time.advance(HOVER_INTENT.velocityWindowMs);
    expect(intent.state.raised).toBe("a");
  });

  it("keeps the card raised while the pointer moves fast on it", () => {
    const { glide, arrive, intent } = setup();
    arrive("a");
    expect(intent.state.raised).toBe("a");
    glide("a", 3, 80);
    expect(intent.state.raised).toBe("a");
  });

  it("drops the lift the moment the pointer leaves the card", () => {
    const { arrive, intent, changes } = setup();
    arrive("a");
    arrive(null);
    expect(intent.state.raised).toBeNull();
    arrive("b");
    intent.leave();
    expect(raisedHistory(changes)).toEqual(["a", null, "b", null]);
  });

  it("drops the lift on a scroll and while anything is dragged or a menu is open", () => {
    const { arrive, intent, time } = setup();
    arrive("a");
    intent.displace();
    expect(intent.state.raised).toBeNull();
    time.advance(HOVER_INTENT.scrollSettleMs);
    arrive("a");
    expect(intent.state.raised).toBe("a");
    intent.setSuspended(true);
    expect(intent.state.raised).toBeNull();
  });
});

describe("the lift's speed rule and the other answers (SPEC_CARD_STATES.md, С8.6)", () => {
  it("lifts nothing on the first report of a pointer entering the surface, until its speed reads", () => {
    const time = fakeClock();
    const intent = new HoverIntent(() => {}, time.clock);
    intent.move("a", 0, 100);
    expect(intent.state.raised).toBeNull();
    time.advance(HOVER_INTENT.velocityWindowMs);
    expect(intent.state.raised).toBe("a");
  });

  it("С7.5: a card sliding under a still pointer does not lift until the pointer really moves", () => {
    const { time, intent, arrive, changes } = setup();
    arrive("a");
    expect(intent.state.raised).toBe("a");
    const before = changes.length;
    for (let step = 0; step < 20; step += 1) {
      time.advance(16);
      intent.displace();
      // WebKit reports the same point over whatever card is now under it.
      intent.move(`slid-${step}`, 1, 100);
    }
    time.advance(2000);
    expect(intent.state.raised).toBeNull();
    expect(changes.slice(before).filter((state) => state.raised !== null)).toHaveLength(0);
    arrive("slid-19");
    expect(intent.state.raised).toBe("slid-19");
  });

  it("С7.5: a pointer moving while the content settles lifts nothing until it settles", () => {
    const { time, intent, glide } = setup();
    intent.displace();
    glide("a", 3, 80);
    expect(intent.state.raised).toBeNull();
    time.advance(HOVER_INTENT.scrollSettleMs);
    expect(intent.state.raised).toBe("a");
  });

  it("С7.8: a drag or an open menu drops the lift and holds new ones until it ends", () => {
    const { glide, intent } = setup();
    glide("a", 3, 8);
    intent.setSuspended(true);
    expect(intent.state.raised).toBeNull();
    glide("b", 3, 80);
    expect(intent.state.raised).toBeNull();
    intent.setSuspended(false);
    glide("c", 3, 8);
    expect(intent.state.raised).toBe("c");
  });

  it("С7.2: leaves the other answers to their own speed: a sweep lights and chooses nothing", () => {
    const { intent, glide, changes } = setup();
    for (const target of ["a", "b", "c", "d"]) glide(target, 1.5, 120);
    expect(intent.state.raised).toBe("d");
    expect(intent.isSlow()).toBe(false);
    expect(changes.every((state) => state.chosen === null && state.slow === null)).toBe(true);
  });

  it("С7.1, С7.3: leaves the dwell and the warm neighbour as they are", () => {
    const { time, intent, arrive, glide } = setup();
    arrive("a");
    time.advance(HOVER_INTENT.dwellMs - 20);
    expect(intent.state.chosen).toBeNull();
    time.advance(40);
    expect(intent.state.chosen).toBe("a");
    glide("b", 0.2, 24);
    expect(intent.state.chosen).toBe("b");
    glide("c", 2, 40);
    expect(intent.state.chosen).toBe("b");
    expect(intent.state.raised).toBe("c");
  });
});
