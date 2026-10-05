import { describe, expect, it } from "vitest";
import { contrastRatio, greyFromOklch, over } from "@/lib/colorLaw";
import { describeFact, level, SIGNAL_TOKENS, tokenLines } from "./textLadderData";

describe("the dark signal ladder", () => {
  it("groups tokens with the same value into one line", () => {
    const lines = tokenLines({
      "--active-alpha": "5.25%",
      "--muted-alpha": "69.28%",
      "--tertiary-alpha": "27.92%",
      "--inert-frame-elevation": "0.0429",
      "--border": "oklch(0.243 0 0)",
      "--sidebar-border": "oklch(0.243 0 0)",
      "--ring": "oklch(0.757 0 0)",
      "--sidebar-ring": "oklch(0.757 0 0)",
    });
    expect(lines.map((line) => line.names)).toEqual([
      ["--active-alpha"],
      ["--muted-alpha"],
      ["--tertiary-alpha"],
      ["--inert-frame-elevation"],
      ["--border", "--sidebar-border"],
      ["--ring", "--sidebar-ring"],
    ]);
    expect(lines[0]).toEqual({ names: ["--active-alpha"], value: "5.25%" });
    expect(tokenLines({}).map((line) => line.names)).toEqual([[...SIGNAL_TOKENS]]);
  });

  it("says in plain words what a fact measures, with the levels and the difference", () => {
    const page = greyFromOklch(0.14);
    const ink = greyFromOklch(0.985);
    const plate = over(ink, 0.0525, page);
    const fact = { label: "подложка", probe: "plate", against: "page" };
    const text = describeFact(fact, { plate, page }) ?? "";
    expect(text.startsWith(`подложка: ${level(plate)} на ${level(page)}, ΔL `)).toBe(true);
    expect(text).not.toContain("контраст");
    expect(describeFact({ ...fact, text: true }, { plate, page })).toContain(`контраст ${contrastRatio(plate, page).toFixed(2)}`);
  });

  it("waits until both probes are measured", () => {
    const page = greyFromOklch(0.14);
    expect(describeFact({ label: "x", probe: "plate", against: "page" }, { page })).toBeNull();
  });
});
