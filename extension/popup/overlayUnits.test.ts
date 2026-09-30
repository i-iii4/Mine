import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

// The clipper overlay lives inside another site's page: `rem` there is the
// site's root font, not Mine's (SPEC_AUDIT_FIXES.md, А4.3).
const OVERLAY_STYLED = [
  "src/styles/global.css",
  "src/components/CollectionPicker.tsx",
  "src/components/ui/button.tsx",
  "src/components/ui/dialog.tsx",
  "src/components/ui/alert-dialog.tsx",
  "src/components/ui/dropdown-menu.tsx",
  "src/components/ui/context-menu.tsx",
  "src/components/ui/segmented-control.tsx",
  "extension/popup/components/VaultSelect.tsx",
];

describe("clipper overlay independence from the host page", () => {
  it.each(OVERLAY_STYLED)("sizes %s without rem", (path) => {
    expect(read(path).match(/\d(?:\.\d+)?rem\b/g) ?? []).toEqual([]);
  });

  it("keeps its control font reset below the utilities (А4.2)", () => {
    const overlay = read("extension/popup/overlay-entry.tsx");
    const reset = overlay.indexOf("font: inherit;");
    const layer = overlay.lastIndexOf("@layer base {", reset);
    expect(reset).toBeGreaterThan(0);
    expect(layer).toBeGreaterThan(0);
    expect(overlay.slice(layer, reset)).toContain("#root button");
  });
});
