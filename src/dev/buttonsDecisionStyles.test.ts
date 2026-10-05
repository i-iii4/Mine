import { describe, expect, it } from "vitest";
import { RETRO_DEPTH } from "./buttonsDecisionStyles";

const layers = (depth: string) => depth.split(/,\s*(?=inset|\d)/);

describe("retro tile on the buttons decision page", () => {
  it("draws the light top line first, so it starts at the top edge", () => {
    for (const theme of ["light", "dark"] as const) {
      expect(layers(RETRO_DEPTH[theme])[0]).toMatch(/^inset 0 1px 0 rgb\(255 255 255/);
    }
  });

  it("has a dark bottom line, a hairline outside the face and no shadow", () => {
    for (const theme of ["light", "dark"] as const) {
      const [, bottom, hairline, ...rest] = layers(RETRO_DEPTH[theme]);
      expect(bottom).toMatch(/^inset 0 -1px 0 rgb\(0 0 0/);
      expect(hairline).toMatch(/^0 0 0 0\.5px rgb\(0 0 0/);
      expect(rest).toHaveLength(0);
    }
  });
});
