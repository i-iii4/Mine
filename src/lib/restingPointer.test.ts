import { describe, expect, it } from "vitest";
import { RestingPointer } from "./restingPointer";

describe("RestingPointer (SPEC_CARD_STATES.md, С7.5)", () => {
  it("is still until the pointer reports a second point", () => {
    const pointer = new RestingPointer();
    expect(pointer.isStill()).toBe(true);
    pointer.move(10, 10);
    expect(pointer.isStill()).toBe(true);
    pointer.move(11, 10);
    expect(pointer.isStill()).toBe(false);
  });

  it("stays still through a report repeated at the same point after content changed", () => {
    const pointer = new RestingPointer();
    pointer.move(10, 10);
    pointer.move(11, 10);
    pointer.displace();
    expect(pointer.isStill()).toBe(true);
    pointer.move(11, 10);
    pointer.move(11, 10);
    expect(pointer.isStill()).toBe(true);
    pointer.move(11, 12);
    expect(pointer.isStill()).toBe(false);
  });

  it("takes no movement from a first report after the pointer left", () => {
    const pointer = new RestingPointer();
    pointer.move(10, 10);
    pointer.leave();
    pointer.displace();
    // Rows slid under a pointer that stands beside the surface: a new point,
    // and still not the pointer's doing.
    pointer.move(40, 40);
    expect(pointer.isStill()).toBe(true);
    pointer.move(41, 40);
    expect(pointer.isStill()).toBe(false);
  });

  it("answers whether a report is the pointer's own step", () => {
    const pointer = new RestingPointer();
    expect(pointer.move(10, 10)).toBe(false);
    expect(pointer.move(11, 10)).toBe(true);
    expect(pointer.lastReportStepped()).toBe(true);
    // The same point is never a step, whatever content did under it.
    expect(pointer.move(11, 10)).toBe(false);
    expect(pointer.lastReportStepped()).toBe(false);
    pointer.displace();
    expect(pointer.lastReportStepped()).toBe(false);
    expect(pointer.move(11, 10)).toBe(false);
    expect(pointer.move(12, 10)).toBe(true);
    // Back from outside with no content change, the first report counts.
    pointer.leave();
    expect(pointer.move(40, 40)).toBe(true);
  });

  it("keeps answering through a pointer that leaves and comes back with no content change", () => {
    const pointer = new RestingPointer();
    pointer.move(10, 10);
    pointer.move(11, 10);
    pointer.leave();
    pointer.move(40, 40);
    expect(pointer.isStill()).toBe(false);
  });
});
