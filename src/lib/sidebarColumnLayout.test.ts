import { readFileSync } from "node:fs";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_COLUMN_LAYOUT,
  SIDEBAR_COLUMNS_STORAGE_KEY,
  applySidebarColumnLayout,
  getSidebarColumnLayout,
  parseSidebarColumnLayout,
  reloadSidebarColumnLayout,
  setSidebarColumnOrder,
  setSidebarColumnShown,
  sidebarColumnRootStyle,
  useSidebarColumnLayout,
} from "./sidebarColumnLayout";

/// TRIAL (PLAN 47.6): the order and visibility of the sidebar rows' columns.
describe("sidebarColumnLayout", () => {
  const root = document.documentElement;

  beforeEach(() => {
    localStorage.removeItem(SIDEBAR_COLUMNS_STORAGE_KEY);
    reloadSidebarColumnLayout();
  });

  afterEach(() => {
    localStorage.removeItem(SIDEBAR_COLUMNS_STORAGE_KEY);
    reloadSidebarColumnLayout();
  });

  it("starts as the rows have always been and writes nothing on the root", () => {
    expect(getSidebarColumnLayout()).toEqual(DEFAULT_SIDEBAR_COLUMN_LAYOUT);
    expect(DEFAULT_SIDEBAR_COLUMN_LAYOUT).toEqual({ order: ["name", "previews", "meta"], hidden: [] });
    expect(sidebarColumnRootStyle(DEFAULT_SIDEBAR_COLUMN_LAYOUT)).toEqual({});
    expect(root.style.getPropertyValue("--sidebar-meta-right")).toBe("");
    expect(root.hasAttribute("data-sidebar-hide-previews")).toBe(false);
  });

  it("reads a damaged or incomplete stored value as the default", () => {
    for (const raw of [
      "not json",
      "null",
      JSON.stringify({ order: ["name", "previews"], hidden: [] }),
      JSON.stringify({ order: ["name", "previews", "meta", "x"], hidden: [] }),
      JSON.stringify({ order: ["name", "previews", "meta"], hidden: ["name", "previews", "meta"] }),
      JSON.stringify({ order: ["name", "previews", "meta"], hidden: ["other"] }),
    ]) {
      expect(parseSidebarColumnLayout(raw)).toEqual(DEFAULT_SIDEBAR_COLUMN_LAYOUT);
    }
    expect(parseSidebarColumnLayout(JSON.stringify({ order: ["meta", "name", "previews"], hidden: ["previews"] })))
      .toEqual({ order: ["meta", "name", "previews"], hidden: ["previews"] });
  });

  it("puts a reorder on the root: the columns' order, the guidelines, the meta zone's offset", () => {
    act(() => setSidebarColumnOrder(["meta", "name", "previews"]));
    expect(root.style.getPropertyValue("--sidebar-meta-order")).toBe("0");
    expect(root.style.getPropertyValue("--sidebar-name-order")).toBe("1");
    expect(root.style.getPropertyValue("--sidebar-previews-order")).toBe("2");
    // The meta zone first: the name and the previews stand after it.
    expect(root.style.getPropertyValue("--sidebar-meta-right")).toBe(
      "calc(var(--sidebar-name-col) + (100% - var(--sidebar-row-pad-x) - var(--sidebar-name-col) - (var(--sidebar-zone) + 1px)))",
    );
    expect(root.style.getPropertyValue("--sidebar-guide-1-left")).toBe(
      "calc(var(--sidebar-row-pad-x) + (var(--sidebar-zone) + 1px))",
    );
    expect(root.style.getPropertyValue("--sidebar-guide-2-display")).toBe("block");
  });

  it("hides a column: the others share the row, one guideline fewer, never the last one shown", () => {
    act(() => setSidebarColumnShown("previews", false));
    expect(root.hasAttribute("data-sidebar-hide-previews")).toBe(true);
    expect(root.style.getPropertyValue("--sidebar-guide-1-left")).toBe(
      "calc(var(--sidebar-row-pad-x) + (100% - var(--sidebar-row-pad-x) - (var(--sidebar-zone) + 1px)))",
    );
    expect(root.style.getPropertyValue("--sidebar-guide-2-display")).toBe("none");
    expect(root.style.getPropertyValue("--sidebar-meta-right")).toBe("0px");

    act(() => setSidebarColumnShown("name", false));
    act(() => setSidebarColumnShown("meta", false));
    expect(getSidebarColumnLayout().hidden).toEqual(["previews", "name"]);

    act(() => setSidebarColumnShown("previews", true));
    act(() => setSidebarColumnShown("name", true));
    expect(root.hasAttribute("data-sidebar-hide-previews")).toBe(false);
    // Back to the default: nothing left on the root.
    expect(root.style.getPropertyValue("--sidebar-guide-1-left")).toBe("");
  });

  it("keeps the choice between launches and follows another tab's", () => {
    act(() => setSidebarColumnOrder(["previews", "name", "meta"]));
    expect(JSON.parse(localStorage.getItem(SIDEBAR_COLUMNS_STORAGE_KEY) ?? "null"))
      .toEqual({ order: ["previews", "name", "meta"], hidden: [] });

    const { result } = renderHook(() => useSidebarColumnLayout());
    localStorage.setItem(SIDEBAR_COLUMNS_STORAGE_KEY, JSON.stringify({ order: ["name", "previews", "meta"], hidden: ["meta"] }));
    act(() => reloadSidebarColumnLayout());
    expect(result.current).toEqual({ order: ["name", "previews", "meta"], hidden: ["meta"] });
  });

  it("applies to any root", () => {
    const other = document.createElement("div");
    applySidebarColumnLayout({ order: ["name", "previews", "meta"], hidden: ["name"] }, other);
    expect(other.hasAttribute("data-sidebar-hide-name")).toBe(true);
  });

  it("has CSS whose defaults leave the rows as they were", () => {
    const css = readFileSync("src/styles/global.css", "utf8");
    expect(css).toContain("order: var(--sidebar-name-order, 0);");
    expect(css).toContain("order: var(--sidebar-previews-order, 1);");
    expect(css).toContain("order: var(--sidebar-meta-order, 2);");
  });
});
