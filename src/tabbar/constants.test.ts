import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHROME_DRAG_THRESHOLD_PX,
  TAB_BAR_HEIGHT_PX,
  TAB_DETACH_THRESHOLD_PX,
  TAB_MAX_WIDTH_PX,
  TAB_MIN_WIDTH_PX,
} from "./constants";

/** The value of `pub const <name>: u32 = <value>;` in the Rust source. */
function rustConstant(source: string, name: string): number {
  const match = new RegExp(`pub const ${name}: u32 = (\\d+);`).exec(source);
  if (!match?.[1]) throw new Error(`${name} is not a u32 constant in domain/windows.rs`);
  return Number(match[1]);
}

/// The backend lays out the bar's page and follows a torn tab with these
/// numbers; the bar draws with its own copies. They are one value each.
describe("tab bar constants", () => {
  const rust = readFileSync("src-tauri/src/domain/windows.rs", "utf8");

  it("match the Rust constants in domain/windows.rs", () => {
    expect(TAB_BAR_HEIGHT_PX).toBe(rustConstant(rust, "TAB_BAR_HEIGHT_PX"));
    expect(TAB_MIN_WIDTH_PX).toBe(rustConstant(rust, "TAB_MIN_WIDTH_PX"));
    expect(TAB_MAX_WIDTH_PX).toBe(rustConstant(rust, "TAB_MAX_WIDTH_PX"));
    expect(TAB_DETACH_THRESHOLD_PX).toBe(rustConstant(rust, "TAB_DETACH_THRESHOLD_PX"));
  });

  it("make the bar one chrome row and its 1 px separator, the step of a sidebar table row (В44, В83)", () => {
    const css = readFileSync("src/styles/global.css", "utf8");
    const step = /--sidebar-row-height:\s*(\d+)px;/.exec(css);
    expect(step?.[1]).toBeDefined();
    expect(TAB_BAR_HEIGHT_PX).toBe(Number(step?.[1]));
    expect(rustConstant(rust, "CHROME_ROW_HEIGHT_PX") + 1).toBe(TAB_BAR_HEIGHT_PX);
    // Every top row, the bar's included, takes that step: one height only.
    expect(css).toContain(`.chrome-row[data-chrome-separator="bottom"] {
  /* A row and its 1px line make one table row's step. */
  --chrome-row-content-height: calc(var(--sidebar-row-height) - 1px);
}`);
    expect(css).not.toContain("data-chrome-height");
  });

  it("drag tabs past the chrome's own threshold", () => {
    const hook = readFileSync("src/hooks/usePressDragGesture.ts", "utf8");
    expect(hook).toContain(`const DEFAULT_CHROME_DRAG_THRESHOLD_PX = ${CHROME_DRAG_THRESHOLD_PX};`);
  });
});
