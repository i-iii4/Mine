import { readFileSync } from "node:fs";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_COLUMN_LAYOUT,
  SIDEBAR_COLUMNS_STORAGE_KEY,
  applySidebarColumnLayout,
  getSidebarColumnLayout,
  isDefaultSidebarColumnLayout,
  parseSidebarColumnLayout,
  reloadSidebarColumnLayout,
  setSidebarColumnOrder,
  setSidebarColumnShown,
  sidebarColumnRootStyle,
  useSidebarColumnLayout,
  type SidebarColumn,
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

  it("puts a reorder on the root: the columns' order, their leads, the guidelines, the meta zone's offset", () => {
    act(() => setSidebarColumnOrder(["meta", "name", "previews"]));
    expect(root.style.getPropertyValue("--sidebar-meta-order")).toBe("0");
    expect(root.style.getPropertyValue("--sidebar-name-order")).toBe("1");
    expect(root.style.getPropertyValue("--sidebar-previews-order")).toBe("2");
    // The first column owns no guideline's pixel, each after it the one before it.
    expect(root.style.getPropertyValue("--sidebar-meta-lead")).toBe("0px");
    expect(root.style.getPropertyValue("--sidebar-name-lead")).toBe("1px");
    expect(root.style.getPropertyValue("--sidebar-previews-lead")).toBe("1px");
    // The meta zone first: the name's zone (the row's inset with it) and the
    // previews' stand after it, each behind its guideline.
    expect(root.style.getPropertyValue("--sidebar-meta-right")).toBe(
      "calc((var(--sidebar-row-pad-x) + var(--sidebar-name-col)) + (100% - var(--sidebar-zone) - (var(--sidebar-row-pad-x) + var(--sidebar-name-col)) - 2px) + 2px)",
    );
    expect(root.style.getPropertyValue("--sidebar-guide-1-left")).toBe("calc(var(--sidebar-zone))");
    expect(root.style.getPropertyValue("--sidebar-guide-2-left")).toBe(
      "calc(var(--sidebar-zone) + (var(--sidebar-row-pad-x) + var(--sidebar-name-col)) + 1px)",
    );
    expect(root.style.getPropertyValue("--sidebar-guide-2-display")).toBe("block");
  });

  it("keeps every column's zone, in every order and with any column hidden", () => {
    // A row of 359px whose name column is 111px (a 360px sidebar).
    const width = 359;
    const values: Record<string, number> = {
      "100%": width,
      "var(--sidebar-row-pad-x)": 16,
      "var(--sidebar-name-col)": 111,
      "var(--sidebar-zone)": 104,
    };
    const orders: SidebarColumn[][] = [
      ["name", "previews", "meta"], ["name", "meta", "previews"], ["previews", "name", "meta"],
      ["previews", "meta", "name"], ["meta", "name", "previews"], ["meta", "previews", "name"],
    ];
    const hiddenSets: SidebarColumn[][] = [[], ["name"], ["previews"], ["meta"], ["name", "previews"], ["name", "meta"], ["previews", "meta"]];
    for (const order of orders) {
      for (const hidden of hiddenSets) {
        const layout = { order, hidden };
        if (isDefaultSidebarColumnLayout(layout)) continue;
        const style = sidebarColumnRootStyle(layout);
        const shown = order.filter((column) => !hidden.includes(column));
        const label = `${order.join(",")} without ${hidden.join(",") || "nothing"}`;
        // The zones the model gives: the name's with the row's inset, the
        // meta zone's, the previews' (or else the name's, or alone the meta
        // zone's) the rest.
        const flexible = (["previews", "name", "meta"] as const).find((column) => shown.includes(column));
        const fixed = (column: SidebarColumn) => (column === "meta" ? 104 : 16 + 111);
        const rest = width - shown.filter((column) => column !== flexible).map(fixed).reduce((a, b) => a + b, 0) - (shown.length - 1);
        const zone = (column: SidebarColumn) => (column === flexible ? rest : fixed(column));
        let start = 0;
        shown.forEach((column, index) => {
          expect(style[`--sidebar-${column}-lead`], label).toBe(index === 0 ? "0px" : "1px");
          if (index > 0) {
            // The guideline stands right where this column's zone begins.
            expect(evaluateCalc(style[`--sidebar-guide-${index}-left`]!, values), label).toBe(start - 1);
          }
          if (column === "meta") {
            expect(evaluateCalc(style["--sidebar-meta-right"]!, values), label).toBe(width - (start + zone(column)));
          }
          start += zone(column) + 1;
        });
        // The zones and the guidelines between them fill the row.
        expect(start - 1, label).toBe(width);
        expect(style["--sidebar-guide-1-display"], label).toBe(shown.length > 1 ? "block" : "none");
        expect(style["--sidebar-guide-2-display"], label).toBe(shown.length > 2 ? "block" : "none");
      }
    }
  });

  it("hides a column: the others share the row, one guideline fewer, never the last one shown", () => {
    act(() => setSidebarColumnShown("previews", false));
    expect(root.hasAttribute("data-sidebar-hide-previews")).toBe(true);
    expect(root.style.getPropertyValue("--sidebar-guide-1-left")).toBe(
      "calc((100% - var(--sidebar-zone) - 1px))",
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

/** The value of a `calc()` the layout writes, with each variable and `100%`
 *  given a number of pixels: sums and differences in parentheses only. */
function evaluateCalc(expression: string, values: Record<string, number>): number {
  let source = expression;
  for (const [name, value] of Object.entries(values)) source = source.split(name).join(String(value));
  const tokens = source.replace(/calc\(/g, "(").replace(/px/g, "").match(/\d+(?:\.\d+)?|[()+-]/g) ?? [];
  let position = 0;
  const term = (): number => {
    const token = tokens[position++];
    if (token === "(") {
      const value = sum();
      position += 1;
      return value;
    }
    const value = Number(token);
    if (Number.isNaN(value)) throw new Error(`Not a number in ${expression}: ${token}`);
    return value;
  };
  const sum = (): number => {
    let value = term();
    while (tokens[position] === "+" || tokens[position] === "-") {
      const sign = tokens[position++] === "+" ? 1 : -1;
      value += sign * term();
    }
    return value;
  };
  return sum();
}
