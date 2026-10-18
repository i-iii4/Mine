import { describe, expect, it } from "vitest";
import { mediaControlsClasses } from "./mediaControls";

// SPEC_READING_MODE.md, Ч6.3: the copy button of a code block shows by the
// rule of ⤢ and ⋯ of the open card's media.
describe("mediaControlsClasses", () => {
  it("hides the controls at rest and shows them under the pointer and in focus", () => {
    const classes = mediaControlsClasses(false).split(" ");
    expect(classes).toEqual(expect.arrayContaining([
      "right-2",
      "top-2",
      "opacity-0",
      "pointer-events-none",
      "group-hover/detail-media:opacity-100",
      "group-focus-within/detail-media:opacity-100",
    ]));
  });

  it("keeps them shown while their menu is open", () => {
    expect(mediaControlsClasses(true).split(" ")).toEqual(expect.arrayContaining(["opacity-100"]));
    expect(mediaControlsClasses(true)).not.toContain("opacity-0");
  });
});
