import { describe, expect, it } from "vitest";
import { createProjectionRevisionOwner } from "./useProjectionRevisionOwner";

describe("ProjectionRevisionOwner", () => {
  it("accepts equal or newer revisions and rejects a stale surface response", () => {
    const owner = createProjectionRevisionOwner();

    expect(owner.accept("grid", 4)).toBe(true);
    expect(owner.accept("grid", 4)).toBe(true);
    expect(owner.accept("grid", 3)).toBe(false);
    expect(owner.accept("grid", 5)).toBe(true);
    expect(owner.current("grid")).toBe(5);
  });

  it("tracks each read model independently under one vault-scoped owner", () => {
    const owner = createProjectionRevisionOwner();

    expect(owner.accept("grid", 8)).toBe(true);
    expect(owner.accept("taxonomy", 6)).toBe(true);
    expect(owner.accept("sidebar-previews", 7)).toBe(true);
    expect(owner.accept("graph", 5)).toBe(true);
    expect(owner.current("taxonomy")).toBe(6);
  });

  it("resets every accepted revision on a vault owner reset", () => {
    const owner = createProjectionRevisionOwner();
    owner.accept("grid", 12);
    owner.accept("graph", 14);

    owner.reset();

    expect(owner.current("grid")).toBeNull();
    expect(owner.current("graph")).toBeNull();
  });
});
