// SPEC_MOTION_LEVELS.md, З1, З2: the fill moves to a new value in 300 ms
// ease-out in Full, Minimal's 150 ms on E, at once in Off; the bar without a
// length keeps moving at every level and breathes in place in Off.
import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MINIMAL_ENTER_CLASS } from "@/lib/motionClasses";
import { Progress } from "./progress";

const css = readFileSync("src/styles/global.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("Progress by the motion level", () => {
  it("moves the fill on its own 300 ms in Full and on Minimal's enter time and E", () => {
    const { container } = render(<Progress value={40} />);
    const fill = container.querySelector<HTMLElement>("[data-slot='progress-indicator']")!;
    expect(fill).toHaveClass("transition-transform", "duration-300", "ease-out");
    for (const name of MINIMAL_ENTER_CLASS.split(" ")) expect(fill).toHaveClass(name);
  });

  it("lands the fill at once in Off, and keeps the bar without a length moving", () => {
    const atOnce = css.split("}").find((rule) => rule.includes("transition-duration: 0.01ms !important"))!;
    expect(atOnce).toContain('[data-motion="off"] *:not(.mine-progress-indeterminate):not(.animate-spin)');
    const breathing = css.split("}").find((rule) => rule.includes('[data-motion="off"] .mine-progress-indeterminate'))!;
    expect(breathing).toContain("animation: mine-progress-breathe 2s ease-in-out infinite");
    expect(breathing).toContain("width: 100%");
    const { container } = render(<Progress value={null} />);
    expect(container.querySelector("[data-slot='progress-indicator']")).toHaveClass("mine-progress-indeterminate");
  });
});
