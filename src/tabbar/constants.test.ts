import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHROME_DRAG_THRESHOLD_PX,
  TAB_BAR_HEIGHT_PX,
  TAB_DETACH_THRESHOLD_PX,
  TAB_MAX_WIDTH_PX,
  TAB_MIN_WIDTH_PX,
} from "./constants";
import { STANDARD_CHROME_ROW_HEIGHT, TALL_CHROME_ROW_HEIGHT } from "@/lib/chromeHeight";

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

  it("make the bar one chrome row and its 1 px separator (В44)", () => {
    const css = readFileSync("src/styles/global.css", "utf8");
    const row = /--chrome-row-content-height:\s*(\d+)px;/.exec(css);
    expect(row?.[1]).toBeDefined();
    expect(TAB_BAR_HEIGHT_PX).toBe(Number(row?.[1]) + 1);
  });

  it("step the tall chrome as a sidebar table row, its line included (В83)", () => {
    const css = readFileSync("src/styles/global.css", "utf8");
    const step = /--sidebar-row-height:\s*(\d+)px;/.exec(css);
    expect(step?.[1]).toBeDefined();
    expect(rustConstant(rust, "CHROME_ROW_TALL_HEIGHT_PX") + 1).toBe(Number(step?.[1]));
    expect(TALL_CHROME_ROW_HEIGHT).toBe(rustConstant(rust, "CHROME_ROW_TALL_HEIGHT_PX"));
    expect(STANDARD_CHROME_ROW_HEIGHT).toBe(rustConstant(rust, "CHROME_ROW_HEIGHT_PX"));
    expect(css).toContain("--chrome-row-content-height: calc(var(--sidebar-row-height) - 1px);");
  });

  it("drag tabs past the chrome's own threshold", () => {
    const hook = readFileSync("src/hooks/useChromeDragGesture.ts", "utf8");
    expect(hook).toContain(`const DEFAULT_CHROME_DRAG_THRESHOLD_PX = ${CHROME_DRAG_THRESHOLD_PX};`);
  });
});
