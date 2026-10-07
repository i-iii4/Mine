import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { MineLogo } from "./MineLogo";

// The logo's size against the chrome icons beside it (DESIGN_SYSTEM.md,
// «Кнопка логотипа»; user's report of 07.10.2026).
describe("MineLogo", () => {
  it("draws its 8 by 5 grid at 1.5px a pixel in a whole 12 by 8px box", () => {
    const { container } = render(
      <Button type="button" variant="chrome" size="chrome-icon" aria-label="Mine settings" tooltip={false}>
        <MineLogo />
      </Button>,
    );
    const svg = container.querySelector<SVGSVGElement>("svg[data-mine-logo]")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 800 500");
    // The mark at the box's top, so its rows start on the box's whole pixel.
    expect(svg.getAttribute("preserveAspectRatio")).toBe("xMidYMin meet");
    // Set on the element itself: the button's icon sizes (13px, 16px) would
    // otherwise scale the grid off the device pixels.
    expect(svg.style.width).toBe("12px");
    expect(svg.style.height).toBe("8px");
    const pixel = 12 / 8;
    expect(pixel * 2).toBe(3);
    expect(5 * pixel).toBeLessThanOrEqual(8);
  });
});
