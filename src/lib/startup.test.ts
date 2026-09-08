import { describe, expect, it, vi } from "vitest";

import { scheduleAfterNextPaint } from "./startup";

describe("scheduleAfterNextPaint", () => {
  it("waits for two animation frames", () => {
    const callbacks: FrameRequestCallback[] = [];
    const callback = vi.fn();
    const request = vi.fn((frame: FrameRequestCallback) => {
      callbacks.push(frame);
      return callbacks.length;
    });
    scheduleAfterNextPaint(callback, request, vi.fn());
    callbacks.shift()?.(1);
    expect(callback).not.toHaveBeenCalled();
    callbacks.shift()?.(2);
    expect(callback).toHaveBeenCalledOnce();
  });

  it("cancels work before maintenance starts", () => {
    const callbacks: FrameRequestCallback[] = [];
    const callback = vi.fn();
    const cancel = vi.fn();
    const dispose = scheduleAfterNextPaint(callback, (frame) => {
      callbacks.push(frame);
      return callbacks.length;
    }, cancel);
    dispose();
    callbacks.shift()?.(1);
    expect(callback).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(1);
  });
});
