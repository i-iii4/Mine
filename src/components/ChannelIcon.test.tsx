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

  // A member of Пружина (SPEC_MOTION_LEVELS.md, С5, РД4): its spring on the
  // box in Full; in Minimal and at Off none, and the stylesheet falls back to
  // Перемещение's tokens, 150 ms on the move curve in Minimal.
  it("carries the stack's spring in Full alone", () => {
    const spring = (level: (typeof MOTION_LEVELS)[number]) => {
      setMotionLevel(level);
      const { container, unmount } = render(<ChannelIcon />);
      const value = container.querySelector<HTMLElement>("[data-channel-icon]")!.style.getPropertyValue("--channel-icon-duration");
      unmount();
      return value;
    };
    expect(spring("full")).toBe(`${CHANNEL_ICON_SPRING_MS}ms`);
    expect(spring("minimal")).toBe("");
    expect(spring("off")).toBe("");
  });

  it("opens on the spring in Full, as Перемещение in Minimal, and stays at rest in Off (С5)", () => {
    expect(rule("[data-channel-icon-card]")).toContain(
      "transition: transform var(--channel-icon-duration, var(--motion-move)) var(--channel-icon-easing, var(--motion-move-ease))",
    );
    expect(css).not.toMatch(/\[data-motion="minimal"\] \[data-channel-icon-card\]/);
    expect(rule('[data-motion="off"] [data-sidebar-scroll] [data-sidebar-row-answer="true"] [data-channel-icon-card]'))
      .toBe("transform: var(--channel-icon-rest);");
  });
});
