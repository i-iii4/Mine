import { describe, expect, it } from "vitest";
import { deleteCollectionKeptLinksText } from "./deleteFailure";

// SPEC_DEEP_AUDIT.md, Е1.3: a deleted collection's link that stayed in an
// element the deletion could not change is named.
describe("deleteCollectionKeptLinksText", () => {
  it("names the one element by its file name", () => {
    expect(deleteCollectionKeptLinksText("Typography", ["Cards/Locked"])).toBe(
      "“Locked” could not be changed and still links to “Typography”.",
    );
  });

  it("counts several elements", () => {
    expect(deleteCollectionKeptLinksText("Typography", ["Cards/One", "Two"])).toBe(
      "2 elements could not be changed and still link to “Typography”.",
    );
  });
});
