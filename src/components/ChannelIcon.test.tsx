import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CHANNEL_ICON_HEIGHT_PX, CHANNEL_ICON_SPRING_MS, CHANNEL_ICON_WIDTH_PX } from "@/lib/channelIcon";
import { ChannelIcon } from "./ChannelIcon";

describe("ChannelIcon", () => {
  it("is the stack's box: as wide as its cards reach, 32px tall, on the stack's spring", () => {
    const { container } = render(<ChannelIcon style={{ marginLeft: 4 }} />);
    const box = container.querySelector<HTMLElement>("[data-channel-icon]")!;
    expect(box.style.width).toBe(`${CHANNEL_ICON_WIDTH_PX}px`);
    expect(box.style.height).toBe(`${CHANNEL_ICON_HEIGHT_PX}px`);
    expect(box.style.marginLeft).toBe("4px");
    expect(box.style.getPropertyValue("--channel-icon-duration")).toBe(`${CHANNEL_ICON_SPRING_MS}ms`);
  });
});
