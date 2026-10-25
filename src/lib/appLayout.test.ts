import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_MAIN_MIN_WIDTH_PX,
  APP_MIN_WIDTH_PX,
  SIDEBAR_BESIDE_MIN_WIDTH_PX,
  SIDEBAR_MIN_WIDTH_PX,
  SIDEBAR_OVERLAY_STRIP_PX,
  sidebarBesideMinWidthPx,
  sidebarEqualZonesWidth,
  sidebarOverlayBelowPx,
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
    expect(SIDEBAR_OVERLAY_STRIP_PX).toBe(rustConstant(rust, "SIDEBAR_OVERLAY_STRIP_PX"));
  });

  it("make the narrowest sidebar the narrowest window less the strip, one derivation (16.10.2026)", () => {
    expect(rust).toContain(
      "pub const SIDEBAR_MIN_WIDTH_PX: u32 = WINDOW_MIN_WIDTH_PX - SIDEBAR_OVERLAY_STRIP_PX;",
    );
    expect(SIDEBAR_MIN_WIDTH_PX).toBe(APP_MIN_WIDTH_PX - SIDEBAR_OVERLAY_STRIP_PX);
    expect(SIDEBAR_MIN_WIDTH_PX).toBe(350);
  });

  it("make the window's minimum a phone's width, which holds the sidebar over the feed (16.10.2026)", () => {
    expect(APP_MIN_WIDTH_PX).toBe(rustConstant(rust, "WINDOW_MIN_WIDTH_PX"));
    expect(rust).toContain("pub const WINDOW_MIN_WIDTH: f64 = WINDOW_MIN_WIDTH_PX as f64;");
    expect(APP_MIN_WIDTH_PX).toBe(390);
    expect(APP_MIN_WIDTH_PX).toBeGreaterThanOrEqual(SIDEBAR_MIN_WIDTH_PX + SIDEBAR_OVERLAY_STRIP_PX);
  });

  it("restate the narrowest sidebar beside the feed in Rust, and go narrow below it plus the feed (23.10.2026)", () => {
    // The width of a thumbnail's preview in the sidebar, whatever the chrome's height.
    expect(sidebarBesideMinWidthPx()).toBe(280);
    expect(SIDEBAR_BESIDE_MIN_WIDTH_PX).toBe(rustConstant(rust, "SIDEBAR_BESIDE_MIN_WIDTH_PX"));
    expect(sidebarOverlayBelowPx()).toBe(SIDEBAR_BESIDE_MIN_WIDTH_PX + APP_MAIN_MIN_WIDTH_PX);
    expect(sidebarOverlayBelowPx()).toBe(670);
    // The narrowest window is always narrow.
    expect(APP_MIN_WIDTH_PX).toBeLessThan(sidebarOverlayBelowPx());
    expect(rust).toContain("&& WINDOW_MIN_WIDTH_PX < SIDEBAR_BESIDE_MIN_WIDTH_PX + APP_MAIN_MIN_WIDTH_PX");
  });

  it("make the feed's minimum the window's, one value for both (16.10.2026)", () => {
    expect(rust).toContain("pub const APP_MAIN_MIN_WIDTH_PX: u32 = WINDOW_MIN_WIDTH_PX;");
    expect(APP_MAIN_MIN_WIDTH_PX).toBe(APP_MIN_WIDTH_PX);
  });

  it("keep the rows' three equal zones within the narrowest sidebar, in CSS too", () => {
    // The zones' own layout is unchanged; the narrowest panel holds it with
    // room to spare, so the curtain never clips a row at rest.
    expect(sidebarEqualZonesWidth()).toBe(314);
    expect(sidebarEqualZonesWidth()).toBeLessThanOrEqual(SIDEBAR_MIN_WIDTH_PX);
    expect(css).toContain(`--sidebar-equal-zones-width: ${sidebarEqualZonesWidth()}px;`);
  });
});
