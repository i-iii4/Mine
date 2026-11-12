// One reader of the system's "Reduce motion" (SPEC_MOTION_LEVELS.md, НС6;
// «Тесты», п. 2): the media query is written in motion.ts alone, no
// stylesheet branches on it, and the old readers are gone. motion.test.ts
// fakes the query to test the system's flag itself, and this file names it to
// look for it: both are let through.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["src", "extension/popup"];
const SOURCE = /\.(ts|tsx|css)$/;
const QUERY = "prefers-reduced-motion";
const ALLOWED = new Set(["src/lib/motion.ts", "src/lib/motion.test.ts", "src/lib/motionReader.test.ts"]);

/** Every source and stylesheet under the roots, by its path from the repo. */
function sources(): Array<{ file: string; text: string }> {
  const found: Array<{ file: string; text: string }> = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (SOURCE.test(name)) found.push({ file: relative(process.cwd(), path), text: readFileSync(path, "utf8") });
    }
  };
  for (const root of ROOTS) walk(root);
  return found;
}

describe("the one reader of the system's Reduce motion", () => {
  const files = sources();

  it("has sources to check", () => {
    expect(files.map(({ file }) => file)).toEqual(expect.arrayContaining([
      "src/lib/motion.ts",
      "src/styles/global.css",
      "src/tabbar/tabbar.css",
      "extension/popup/main.tsx",
    ]));
  });

  it("writes the media query in motion.ts alone", () => {
    const readers = files.filter(({ file, text }) => text.includes(QUERY) && !ALLOWED.has(file)).map(({ file }) => file);
    expect(readers).toEqual([]);
    expect(files.find(({ file }) => file === "src/lib/motion.ts")?.text).toContain(QUERY);
  });

  it("has no stylesheet that branches on it", () => {
    for (const { file, text } of files.filter(({ file }) => file.endsWith(".css"))) {
      expect(text, file).not.toMatch(/@media\s*\(\s*prefers-reduced-motion/);
    }
  });

  it("imports the old readers nowhere", () => {
    for (const { file, text } of files) {
      expect(text, file).not.toMatch(/import\s*\{[^}]*\b(prefersReducedMotion|motionDuration)\b[^}]*\}\s*from/);
    }
  });
});
