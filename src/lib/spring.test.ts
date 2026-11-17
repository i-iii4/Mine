import { describe, expect, it } from "vitest";
import { MOTION_LEVELS, MOTION_MOVE_EASE, MOTION_SPRING_MOVE_MS, springMotion } from "./motion";
import { setMotionLevel } from "@/test/motionLevel";
import { SPRING_EASING, SPRING_MS, SPRING_RESPONSE_S, moveRun, springRun, springSettleMs, springStyle } from "./spring";

/// The interface's spring (SPEC_MOTION_LEVELS.md, РД4): critically damped,
/// response 0.3 s, settled within 0.1% of its target.
describe("spring", () => {
  it("settles in 441 ms and ends its easing exactly on 1", () => {
    expect(SPRING_RESPONSE_S).toBe(0.3);
    expect(SPRING_MS).toBe(441);
    expect(springSettleMs(SPRING_RESPONSE_S)).toBe(SPRING_MS);
    expect(SPRING_EASING).toMatch(/^linear\(0, .*, 1\)$/);
  });

  it("is that spring from rest as a run", () => {
    const spring = springRun();
    expect(spring.durationMs).toBe(SPRING_MS);
    expect(spring.easing).toBe(SPRING_EASING);
    expect(spring.progress(0)).toBe(0);
    expect(spring.progress(spring.durationMs)).toBe(1);
    expect(spring.speed(0)).toBeGreaterThanOrEqual(0);
  });

  it("turns around without a jump: it brakes from the speed it had", () => {
    const out = springRun();
    const frame = 1000 / 60;
    const at = out.durationMs / 10;
    const q = out.progress(at);
    const before = q - out.progress(at - frame);
    // Back toward 0 from q: progress r runs 0 → 1 over a span of −q.
    const back = springRun(out.speed(at) / -q);
    expect(q + back.progress(0) * -q).toBe(q);
    // The first frame back still goes the old way, slower than the last one
    // did: the new target pulls, the speed carries on.
    const after = back.progress(frame) * -q;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    expect(back.progress(back.durationMs)).toBe(1);
  });

  it("runs Minimal's move from rest on the move curve", () => {
    const move = moveRun();
    expect(move.durationMs).toBe(MOTION_SPRING_MOVE_MS);
    expect(move.easing).toBe(MOTION_MOVE_EASE);
    expect(move.progress(0)).toBe(0);
    expect(move.progress(move.durationMs)).toBe(1);
    expect(move.speed(move.durationMs)).toBe(0);
  });

  // The mark's turn (С7, РД4): the spring in Full, Перемещение in Minimal,
  // nothing at Off, where global.css does not turn it.
  it("gives a CSS move the spring in Full, the calm move in Minimal and nothing at Off", () => {
    const styles = Object.fromEntries(MOTION_LEVELS.map((level) => {
      setMotionLevel(level);
      return [level, springStyle(springMotion())];
    }));
    expect(styles.full).toEqual({ "--spring-duration": `${SPRING_MS}ms`, "--spring-easing": SPRING_EASING });
    expect(styles.minimal).toEqual({ "--spring-duration": `${MOTION_SPRING_MOVE_MS}ms`, "--spring-easing": MOTION_MOVE_EASE });
    expect(styles.off).toEqual({});
  });
});
