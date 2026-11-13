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

  // Buttons that come up under the pointer answer as Отклик: in on
  // --motion-enter, wherever they come up, out on --motion-exit, the response
  // curve (SPEC_MOTION_LEVELS.md, В4; user's decision of 12.11.2026).
  it("shows them on Отклик's enter time and hides them on its exit time", () => {
    const hidden = mediaControlsClasses(false).split(" ");
    expect(hidden).toEqual(expect.arrayContaining([
      "transition-opacity",
      "duration-(--motion-exit)",
      "ease-(--motion-ease)",
      "group-hover/detail-media:duration-(--motion-enter)",
      "group-focus-within/detail-media:duration-(--motion-enter)",
    ]));
    expect(mediaControlsClasses(true).split(" ")).toEqual(expect.arrayContaining(["duration-(--motion-enter)", "ease-(--motion-ease)"]));
    expect(mediaControlsClasses(false)).not.toMatch(/duration-\[|data-motion/);
  });

  it("keeps them shown while their menu is open", () => {
    expect(mediaControlsClasses(true).split(" ")).toEqual(expect.arrayContaining(["opacity-100"]));
    expect(mediaControlsClasses(true)).not.toContain("opacity-0");
  });
});
