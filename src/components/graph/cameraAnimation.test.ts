import { describe, expect, it } from "vitest";
import { animateCamera, type CameraGraph } from "./cameraAnimation";

function fakeGraph() {
  const state = { x: 0, y: 0, k: 1 };
  const graph: CameraGraph = {
    centerAt: ((x?: number, y?: number) => {
      if (x === undefined || y === undefined) return { x: state.x, y: state.y };
      state.x = x;
      state.y = y;
      return graph;
    }) as CameraGraph["centerAt"],
    zoom: ((k?: number) => {
      if (k === undefined) return state.k;
      state.k = k;
      return graph;
    }) as CameraGraph["zoom"],
  };
  return { graph, state };
}

function frames() {
  let clock = 0;
  const queue = new Map<number, FrameRequestCallback>();
  let next = 1;
  return {
    frame: (callback: FrameRequestCallback) => {
      queue.set(next, callback);
      return next++;
    },
    cancel: (handle: number) => { queue.delete(handle); },
    now: () => clock,
    advance(ms: number) {
      clock += ms;
      const due = [...queue.entries()];
      queue.clear();
      for (const [, callback] of due) callback(clock);
    },
  };
}

describe("graph camera glide (А5.2)", () => {
  it("reaches its target over its duration", () => {
    const { graph, state } = fakeGraph();
    const clock = frames();
    animateCamera(graph, { x: 100, y: 50, k: 2 }, 300, clock.frame, clock.cancel, clock.now);
    clock.advance(150);
    expect(state.x).toBeGreaterThan(0);
    expect(state.x).toBeLessThan(100);
    clock.advance(200);
    expect(state).toEqual({ x: 100, y: 50, k: 2 });
  });

  it("stops where it is when a gesture cancels it", () => {
    const { graph, state } = fakeGraph();
    const clock = frames();
    const cancel = animateCamera(graph, { x: 100, y: 0, k: null }, 300, clock.frame, clock.cancel, clock.now);
    clock.advance(100);
    const stoppedAt = state.x;
    cancel();
    clock.advance(300);
    expect(state.x).toBe(stoppedAt);
    expect(state.k).toBe(1);
  });

  it("places the camera at once without motion", () => {
    const { graph, state } = fakeGraph();
    const clock = frames();
    animateCamera(graph, { x: 10, y: 20, k: 3 }, 0, clock.frame, clock.cancel, clock.now);
    expect(state).toEqual({ x: 10, y: 20, k: 3 });
  });
});
