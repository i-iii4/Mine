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
  it.each(MOTION_LEVELS)("is the stack's box in %s: as wide as its cards reach, 32px tall, on the stack's spring", (level) => {
    // The level's motion lies in global.css, over the same box (SPEC_MOTION_LEVELS.md, С5).
    setMotionLevel(level);
    const { container } = render(<ChannelIcon style={{ marginLeft: 4 }} />);
    const box = container.querySelector<HTMLElement>("[data-channel-icon]")!;
    expect(box.style.width).toBe(`${CHANNEL_ICON_WIDTH_PX}px`);
    expect(box.style.height).toBe(`${CHANNEL_ICON_HEIGHT_PX}px`);
    expect(box.style.marginLeft).toBe("4px");
    expect(box.style.getPropertyValue("--channel-icon-duration")).toBe(`${CHANNEL_ICON_SPRING_MS}ms`);
  });

  it("opens on the spring in Full, in 150 ms and closes in 100 ms on E in Minimal, and stays at rest in Off (С5)", () => {
    expect(rule("[data-channel-icon-card]")).toContain("transition: transform var(--channel-icon-duration) var(--channel-icon-easing)");
    expect(rule('[data-motion="minimal"] [data-channel-icon-card]')).toBe("transition: transform var(--motion-exit) var(--motion-ease);");
    expect(rule('[data-motion="minimal"] [data-sidebar-scroll] [data-sidebar-row-answer="true"] [data-channel-icon-card]'))
      .toBe("transition-duration: var(--motion-enter);");
    expect(rule('[data-motion="off"] [data-sidebar-scroll] [data-sidebar-row-answer="true"] [data-channel-icon-card]'))
      .toBe("transform: var(--channel-icon-rest);");
  });
});
