import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "src/styles/global.css"), "utf8");

describe("surface tokens", () => {
  it("keeps the dark card surface visibly lifted from the page background", () => {
    expect(css).toMatch(/--background:\s*oklch\(0\.14 0 0\);/);
    expect(css).toMatch(/--card:\s*oklch\(0\.17 0 0\);/);
    expect(css).not.toMatch(/--card:\s*oklch\(0\.14 0 0\);/);
  });
});
