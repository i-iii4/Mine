import { describe, expect, it } from "vitest";

import { folderStateBlocksSave, identityStateMessage } from "./folderState";

describe("helper folder states the person reads (SPEC_AUDIT_FIXES.md, Д2.1)", () => {
  it("says in one line why Mine cannot tell which space the folder is", () => {
    expect(identityStateMessage("identity_in_cloud")).toBe(
      "This space is still downloading from iCloud. Try again in a moment.",
    );
    expect(identityStateMessage("identity_unreadable")).toBe("Mine cannot read this space's identity file.");
    expect(identityStateMessage("identity_unwritable")).toBe(
      "This folder is a copy and Mine could not give it its own identity.",
    );
    for (const state of ["identity_in_cloud", "identity_unreadable", "identity_unwritable"]) {
      expect(folderStateBlocksSave(state)).toBe(true);
    }
  });

  it("leaves every other state, an unknown one and a non-state to the helper's own words", () => {
    for (const state of ["ready", "moved", "missing", "unavailable", "a_state_from_a_newer_helper", "constructor", "", undefined, null, 7, {}]) {
      expect(identityStateMessage(state)).toBeNull();
      expect(folderStateBlocksSave(state)).toBe(false);
    }
  });
});
