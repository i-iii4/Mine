import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cn } from "./utils";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles/global.css"), "utf8");
const tokens = (prefix: string) =>
  [...new Set([...css.matchAll(new RegExp(`--${prefix}-([a-z0-9]+):`, "g"))].map((match) => match[1]))];

describe("cn with the project's design tokens", () => {
  it("lets a later radius token replace an earlier one", () => {
    // The clipper's Save progress: the base pill must yield to the button's radius.
    expect(cn("relative h-2 rounded-pill", "h-10 rounded-1")).toBe("relative h-10 rounded-1");
    expect(cn("rounded-t-pill", "rounded-t-2")).toBe("rounded-t-2");
  });

  it("lets a later spacing token replace an earlier one", () => {
    expect(cn("gap-s2", "gap-s4")).toBe("gap-s4");
    expect(cn("p-s3", "p-4")).toBe("p-4");
  });

  it("knows every radius and spacing token the stylesheet defines", () => {
    for (const token of tokens("radius")) {
      expect(cn("rounded-pill", `rounded-${token}`)).toBe(`rounded-${token}`);
    }
    for (const token of tokens("spacing")) {
      expect(cn("gap-4", `gap-${token}`)).toBe(`gap-${token}`);
    }
  });
});
