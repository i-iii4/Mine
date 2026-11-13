// The role classes are Tailwind utilities: this compiles them with the
// project's Tailwind and reads the rules it writes, since jsdom applies no
// stylesheet (SPEC_MOTION_LEVELS.md, РД3).
import { readFileSync } from "node:fs";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import { MOVE_CLASS, RESPONSE_ENTER_CLASS, RESPONSE_EXIT_CLASS, responseFadeClass } from "./motionClasses";

const UTILITIES = "node_modules/tailwindcss/utilities.css";

async function cssOf(classes: string): Promise<string> {
  const compiler = await compile('@import "tailwindcss/utilities";', {
    base: process.cwd(),
    loadStylesheet: async (_id, base) => ({ path: UTILITIES, base, content: readFileSync(UTILITIES, "utf8") }),
  });
  return compiler.build(classes.split(/\s+/)).replace(/\s+/g, " ");
}

describe("the roles' classes", () => {
  it("give Отклик's appearance its enter time and curve, at every level by the token", async () => {
    const css = await cssOf(RESPONSE_ENTER_CLASS);
    expect(css).toContain("--tw-duration: var(--motion-enter); transition-duration: var(--motion-enter);");
    expect(css).toContain("--tw-ease: var(--motion-ease); transition-timing-function: var(--motion-ease);");
    expect(css).not.toContain("data-motion");
  });

  it("give Отклик's leaving its exit time and curve", async () => {
    const css = await cssOf(RESPONSE_EXIT_CLASS);
    expect(css).toContain("transition-duration: var(--motion-exit);");
    expect(css).toContain("transition-timing-function: var(--motion-ease);");
    expect(css).not.toContain("--motion-enter");
  });

  it("give Перемещение its time and its own curve", async () => {
    const css = await cssOf(MOVE_CLASS);
    expect(css).toContain("transition-duration: var(--motion-move);");
    expect(css).toContain("transition-timing-function: var(--motion-move-ease);");
  });

  it("fade in on the enter time and out on the exit time", () => {
    expect(responseFadeClass(true)).toBe(RESPONSE_ENTER_CLASS);
    expect(responseFadeClass(false)).toBe(RESPONSE_EXIT_CLASS);
  });
});
