import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CHANNEL_ICON_HEIGHT_PX, CHANNEL_ICON_SPRING_MS, CHANNEL_ICON_WIDTH_PX } from "@/lib/channelIcon";
import { MOTION_LEVELS } from "@/lib/motion";
import { setMotionLevel } from "@/test/motionLevel";
import { ChannelIcon } from "./ChannelIcon";

/** global.css without its comments, for the rules' text. */
const css = readFileSync("src/styles/global.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match?.[1]) throw new Error(`no rule ${selector}`);
  return match[1].replace(/\s+/g, " ").trim();
}

describe("ChannelIcon", () => {
  it.each(MOTION_LEVELS)("is the stack's box in %s: as wide as its cards reach, 32px tall", (level) => {
    setMotionLevel(level);
    const { container } = render(<ChannelIcon style={{ marginLeft: 4 }} />);
    const box = container.querySelector<HTMLElement>("[data-channel-icon]")!;
    expect(box.style.width).toBe(`${CHANNEL_ICON_WIDTH_PX}px`);
    expect(box.style.height).toBe(`${CHANNEL_ICON_HEIGHT_PX}px`);
    expect(box.style.marginLeft).toBe("4px");
  });

  // A member of Пружина (SPEC_MOTION_LEVELS.md, С5, РД4). The stack answers
  // the pointer, so its spring stands on the box in every mode («Режимы»).
  it("carries the stack's spring in every mode", () => {
    for (const level of MOTION_LEVELS) {
      setMotionLevel(level);
      const { container, unmount } = render(<ChannelIcon />);
      const value = container.querySelector<HTMLElement>("[data-channel-icon]")!.style.getPropertyValue("--channel-icon-duration");
      unmount();
      expect(value, level).toBe(`${CHANNEL_ICON_SPRING_MS}ms`);
    }
  });

  it("opens under the pointer in every mode: no rule of a mode holds it at rest (С5)", () => {
    expect(rule("[data-channel-icon-card]")).toContain(
      "transition: transform var(--channel-icon-duration, var(--motion-move)) var(--channel-icon-easing, var(--motion-move-ease))",
    );
    expect(css).not.toMatch(/\[data-motion="(minimal|off)"\][^{]*\[data-channel-icon-card\]/);
  });
});
