import { describe, expect, it } from "vitest";
import type { TagCount } from "@/types";
import * as sidebarSearch from "./sidebarSearch";

const {
  SIDEBAR_ALL_ROW_KEY,
  buildSidebarSearchNavigationRows,
  filterSidebarTags,
  shouldShowSidebarEverythingRow,
  sidebarRowDomId,
  sidebarRowKeyToRoute,
} = sidebarSearch;

const TAGS: TagCount[] = [
  { tag: "Typography", count: 3 },
  { tag: "Type design", count: 1 },
  { tag: "Gardens", count: 2 },
];

// The arrows of the sidebar's search walk Everything and the collections the
// query finds; the row that names a new collection is not a result of the
// filter and is not walked (SPEC_FRONTEND.md, «Search»).
describe("sidebar search rows", () => {
  it("walks Everything and every collection without a query", () => {
    expect(buildSidebarSearchNavigationRows(TAGS, "")).toEqual([
      SIDEBAR_ALL_ROW_KEY, "tag:Typography", "tag:Type design", "tag:Gardens",
    ]);
  });

  it("walks only the collections the query finds, Everything while the query fits it", () => {
    const found = filterSidebarTags(TAGS, "typ").map((tc) => tc.tag);
    expect(found).toContain("Typography");
    expect(found).not.toContain("Gardens");
    expect(buildSidebarSearchNavigationRows(TAGS, "typ")).toEqual(found.map((tag) => `tag:${tag}`));
    expect(shouldShowSidebarEverythingRow("every")).toBe(true);
    expect(buildSidebarSearchNavigationRows(TAGS, "every")[0]).toBe(SIDEBAR_ALL_ROW_KEY);
  });

  it("has no row key for creating a collection", () => {
    expect(Object.keys(sidebarSearch).sort()).toEqual([
      "SIDEBAR_ALL_ROW_KEY",
      "buildSidebarSearchNavigationRows",
      "filterSidebarTags",
      "shouldShowSidebarEverythingRow",
      "sidebarRowDomId",
      "sidebarRowKeyToRoute",
    ]);
    expect(buildSidebarSearchNavigationRows(TAGS, "")).not.toContain("create-channel");
  });

  it("routes a row and names its element", () => {
    expect(sidebarRowKeyToRoute(SIDEBAR_ALL_ROW_KEY)).toBe("/");
    expect(sidebarRowKeyToRoute("tag:Type design")).toBe("/channel/Type%20design");
    expect(sidebarRowKeyToRoute("create-channel")).toBeNull();
    expect(sidebarRowDomId("tag:Type design")).toBe("sidebar-row-tag%3AType%20design");
  });
});
