// The level classes are Tailwind arbitrary variants: this compiles them with
// the project's Tailwind and reads the rules it writes, since jsdom applies no
// stylesheet (SPEC_MOTION_LEVELS.md, УД2, НС6).
import { readFileSync } from "node:fs";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import { MINIMAL_EASE_CLASS, MINIMAL_ENTER_CLASS, MINIMAL_EXIT_CLASS, minimalFadeClass } from "./motionClasses";

const UTILITIES = "node_modules/tailwindcss/utilities.css";

async function cssOf(classes: string): Promise<string> {
  const compiler = await compile('@import "tailwindcss/utilities";', {
    base: process.cwd(),
    loadStylesheet: async (_id, base) => ({ path: UTILITIES, base, content: readFileSync(UTILITIES, "utf8") }),
  });
  return compiler.build(classes.split(/\s+/)).replace(/\s+/g, " ");
}

describe("Minimal's classes", () => {
  it("set the enter time and E under a Minimal ancestor alone", async () => {
    const css = await cssOf(MINIMAL_ENTER_CLASS);
    expect(css).toContain("[data-motion=minimal] & { --tw-duration: var(--motion-enter); transition-duration: var(--motion-enter); }");
    expect(css).toContain("[data-motion=minimal] & { --tw-ease: var(--motion-ease); transition-timing-function: var(--motion-ease); }");
  });

  it("set the exit time and E under a Minimal ancestor alone", async () => {
    const css = await cssOf(MINIMAL_EXIT_CLASS);
    expect(css).toContain("transition-duration: var(--motion-exit);");
    expect(css).toContain("transition-timing-function: var(--motion-ease);");
    expect(css).not.toContain("--motion-enter");
  });

  it("change only the curve where Minimal keeps the time", async () => {
    const css = await cssOf(MINIMAL_EASE_CLASS);
    expect(css).toContain("transition-timing-function: var(--motion-ease);");
    expect(css).not.toContain("transition-duration");
  });

  it("fade in on the enter time and out on the exit time", () => {
    expect(minimalFadeClass(true)).toBe(MINIMAL_ENTER_CLASS);
    expect(minimalFadeClass(false)).toBe(MINIMAL_EXIT_CLASS);
  });
});
