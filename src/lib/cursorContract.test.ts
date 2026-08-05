import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/// Files allowed to carry `cursor-pointer`, with the element that earns it.
///
/// The contract (DESIGN_SYSTEM.md → Интерактивные состояния → Курсор): in a
/// macOS app the pointing hand means "this leaves for a URL", so only controls
/// that open the browser may use it. Everything else stays under the arrow.
const LEAVES_THE_APP: Record<string, string> = {
  "src/components/MetadataRow.tsx": "the source domain opens in the browser",
  "src/components/Detail.tsx": "the Source button opens in the browser",
  "src/components/CardHoverMenu.tsx": "the Source button opens in the browser",
};

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, found);
    } else if (/\.tsx?$/.test(entry) && !entry.includes(".test.")) {
      found.push(path);
    }
  }
  return found;
}

describe("cursor contract", () => {
  it("keeps the pointing hand on controls that leave the app", () => {
    const offenders = sourceFiles("src")
      .filter((path) => readFileSync(path, "utf8").includes("cursor-pointer"))
      .filter((path) => !(path in LEAVES_THE_APP));

    expect(
      offenders,
      "cursor-pointer marks a jump out of Mine. A control that acts inside the "
        + "app keeps the arrow — if it feels unclickable, fix its hover response "
        + "instead. See DESIGN_SYSTEM.md → Интерактивные состояния → Курсор.",
    ).toEqual([]);
  });

  it("names why each allowed file is allowed", () => {
    // Guards the allowlist against growing by copy-paste: a new entry has to
    // state which control opens the browser.
    for (const [path, reason] of Object.entries(LEAVES_THE_APP)) {
      expect(readFileSync(path, "utf8")).toContain("cursor-pointer");
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});
