import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_MAIN_MIN_WIDTH_PX,
  APP_MIN_WIDTH_PX,
  SIDEBAR_MIN_WIDTH_PX,
  SIDEBAR_OVERLAY_STRIP_PX,
  sidebarMinWidth,
} from "./appLayout";

/** The value of `pub const <name>: u32 = <value>;` in the Rust source. */
function rustConstant(source: string, name: string): number {
  const match = new RegExp(`pub const ${name}: u32 = (\\d+);`).exec(source);
  if (!match?.[1]) throw new Error(`${name} is not a u32 constant in domain/windows.rs`);
  return Number(match[1]);
}

/// The backend sets the window's minimum from these widths; the page lays
/// itself out with its own copies (SPEC_NARROW_WINDOW.md, У3, У11). They are
/// one value each.
describe("window widths", () => {
  const rust = readFileSync("src-tauri/src/domain/windows.rs", "utf8");
  const css = readFileSync("src/styles/global.css", "utf8");

  it("match the Rust constants in domain/windows.rs", () => {
    expect(SIDEBAR_MIN_WIDTH_PX).toBe(rustConstant(rust, "SIDEBAR_MIN_WIDTH_PX"));
    expect(APP_MAIN_MIN_WIDTH_PX).toBe(rustConstant(rust, "APP_MAIN_MIN_WIDTH_PX"));
    expect(SIDEBAR_OVERLAY_STRIP_PX).toBe(rustConstant(rust, "SIDEBAR_OVERLAY_STRIP_PX"));
  });

  it("make the window's minimum the narrowest sidebar beside the narrowest feed (47.2b)", () => {
    expect(rust).toContain(
      "pub const WINDOW_MIN_WIDTH: f64 = (SIDEBAR_MIN_WIDTH_PX + APP_MAIN_MIN_WIDTH_PX) as f64;",
    );
    expect(APP_MIN_WIDTH_PX).toBe(SIDEBAR_MIN_WIDTH_PX + APP_MAIN_MIN_WIDTH_PX);
    expect(APP_MIN_WIDTH_PX).toBe(618);
  });

  it("take the narrowest sidebar from its three equal zones, in CSS too", () => {
    expect(sidebarMinWidth()).toBe(SIDEBAR_MIN_WIDTH_PX);
    expect(css).toContain(`--sidebar-min-width: ${SIDEBAR_MIN_WIDTH_PX}px;`);
  });
});
