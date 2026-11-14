// SPEC_MOTION_LEVELS.md, З1, З2: the fill follows the work on its own time,
// 300 ms ease-out, a status outside the roles and the same in every mode; the
// bar without a length keeps moving in every mode and breathes in place in
// Off.
import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Progress } from "./progress";

const css = readFileSync("src/styles/global.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string) => css.split("}").find((chunk) => chunk.slice(0, chunk.indexOf("{")).trim() === selector) ?? "";

describe("Progress in every mode", () => {
  it("moves the fill on its own time, outside the roles, as before the roles", () => {
    const { container } = render(<Progress value={40} />);
    const fill = container.querySelector<HTMLElement>("[data-slot='progress-indicator']")!;
    expect(fill).toHaveClass("mine-progress-fill");
    expect(rule(".mine-progress-fill")).toContain("transition: transform 300ms ease-out;");
    // No mode's rule names the fill: it says how the work goes, in each.
    expect(css).not.toMatch(/\[data-motion="(minimal|off)"\][^{]*mine-progress-fill/);
  });

  it("keeps the bar without a length moving, breathing in place in Off", () => {
    const breathing = rule('[data-motion="off"] .mine-progress-indeterminate');
    expect(breathing).toContain("animation: mine-progress-breathe 2s ease-in-out infinite");
    expect(breathing).toContain("width: 100%");
    const { container } = render(<Progress value={null} />);
    expect(container.querySelector("[data-slot='progress-indicator']")).toHaveClass("mine-progress-indeterminate");
  });
});
