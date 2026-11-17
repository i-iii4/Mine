import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cardConnectSpec, cardMenuSpec, type CardMenuPicker } from "./cardMenuEntries";
import { FLOATING_LAYER_EDGE_PX, MENU_PLATE_GAP_PX, MENU_POINT_OFFSET_PX } from "./floatingLayer";
import { groupConnectSpec, groupSelectionSpec } from "./groupSelectionMenu";
import { COLLECTION_PICKER_MAX_HEIGHT_PX, MENU_SHADOW_FIELD_PX, MENU_WIDTH_PX, SPACE_LIST_MAX_HEIGHT_PX, menuActionCloses, menuItem, menuSpecSize, menuSubmenu } from "./menuSpec";
import type { MenuSpec, MenuWidgetAction } from "@/types";

const PICKER: CardMenuPicker = { card: "card", selected: [], tags: [{ tag: "Web", count: 1 }], currentTag: null };

describe("menuSpecSize", () => {
  it("counts a menu of commands from its rows, separators, inset and border", () => {
    // Connect, Table, Source, Copy Link, Reveal, Copy Path, Rename,
    // Disconnect and Delete: nine rows; three separators.
    const full = cardMenuSpec({
      hasUrl: true,
      disconnectFrom: "Web",
      tableCommands: [{ id: "a", label: "A", destructive: false, separatorBefore: false }],
      picker: PICKER,
    });
    expect(menuSpecSize(full).size).toEqual({ width: 240, height: 9 * 32 + 3 * 9 + 2 * 5 });
    // The browser check measures the same menus (scripts/menu-panel-audit.mjs).
    expect(menuSpecSize(full).size.height).toBe(325);
    const bare = cardMenuSpec({ hasUrl: false, disconnectFrom: null, tableCommands: [], picker: PICKER });
    expect(menuSpecSize(bare).size).toEqual({ width: 240, height: 188 });
  });

  it("counts each submenu and the row it opens off", () => {
    const spec = cardMenuSpec({
      hasUrl: false,
      disconnectFrom: null,
      tableCommands: [
        { id: "a", label: "A", destructive: false, separatorBefore: false },
        { id: "b", label: "B", destructive: true, separatorBefore: true },
      ],
      picker: PICKER,
    });
    expect(menuSpecSize(spec).submenus).toEqual([
      // Connect: the first row, under the border and the surface's inset;
      // the picker at its tallest, a list under a search field.
      { row_top: 5, width: 300, height: COLLECTION_PICKER_MAX_HEIGHT_PX + 2 },
      // Table: the second row; two commands and the separator between them.
      { row_top: 5 + 32, width: 240, height: 2 * 32 + 9 + 2 * 5 },
    ]);
  });

  it("counts a list under a search field at its tallest, to the surface's border", () => {
    // The search field 41, eight rows of 32, the list's own inset 4.
    expect(COLLECTION_PICKER_MAX_HEIGHT_PX).toBe(41 + 8 * 32 + 4);
    expect(menuSpecSize(cardConnectSpec(PICKER))).toEqual({ size: { width: 300, height: 303 }, submenus: [] });
  });

  it("counts a caption and a line of text as one line each, and a selection's picker as a card's", () => {
    const picker = { cards: ["one", "two"], tags: [{ tag: "Web", count: 1 }], lookup: new Map<string, string[]>() };
    const plain = groupSelectionSpec({ count: 2, inCollection: true, error: null, picker });
    // The caption 28, a separator 9, Connect, Disconnect, Merge and Delete.
    expect(menuSpecSize(plain).size).toEqual({ width: 240, height: 10 + 28 + 9 + 4 * 32 });
    // Connect's row starts under the caption and the separator.
    expect(menuSpecSize(plain).submenus).toEqual([{ row_top: 5 + 28 + 9, width: 300, height: 303 }]);
    const failed = groupSelectionSpec({ count: 2, inCollection: true, error: "The index is busy.", picker });
    expect(menuSpecSize(failed).size.height).toBe(menuSpecSize(plain).size.height + 9 + 28);
    expect(menuSpecSize(groupConnectSpec(picker)).size).toEqual({ width: 300, height: 303 });
  });

  it("counts an empty menu as its surface alone", () => {
    const empty: MenuSpec = { role: "action", entries: [] };
    expect(menuSpecSize(empty)).toEqual({ size: { width: 240, height: 10 }, submenus: [] });
  });
});

describe("a command's row", () => {
  it("is an ordinary one that closes its menu, but for what is said of it", () => {
    expect(menuItem("reveal", "Reveal in Finder")).toEqual({
      kind: "item",
      id: "reveal",
      label: "Reveal in Finder",
      icon: null,
      variant: "default",
      truncate: false,
      disabled: false,
      stays_open: false,
      plain: false,
      detail: null,
    });
    // A row of a menu with no column of icons.
    expect(menuItem("appearance", "Appearance", { plain: true })).toMatchObject({ icon: null, plain: true });
    expect(menuItem("delete", "Delete", { icon: "trash", variant: "destructive", disabled: true })).toMatchObject({
      icon: "trash",
      variant: "destructive",
      disabled: true,
      stays_open: false,
    });
  });

  it("closes the menu unless its row keeps it open, in the menu or in a submenu of it", () => {
    const spec: MenuSpec = {
      role: "action",
      entries: [
        menuItem("copy", "Copy", { stays_open: true }),
        menuItem("reveal", "Reveal in Finder"),
        menuSubmenu("more", "More", { role: "action", entries: [menuItem("pin", "Pin", { stays_open: true }), menuItem("rename", "Rename")] }),
      ],
    };
    expect(["copy", "reveal", "pin", "rename"].map((id) => menuActionCloses(spec, { kind: "run", id }))).toEqual([false, true, false, true]);
  });

  it("opens a menu beside it, with an empty leading slot unless it is plain", () => {
    const content: MenuSpec = { role: "action", entries: [] };
    expect(menuSubmenu("more", "More", content)).toEqual({ kind: "submenu", id: "more", label: "More", icon: null, plain: false, content });
    expect(menuSubmenu("menus", "Menus", content, { plain: true })).toMatchObject({ icon: null, plain: true });
  });

  it("is two lines of text tall with a second line under its label", () => {
    const plain: MenuSpec = { role: "action", entries: [menuItem("remove", "Remove Space")] };
    const detailed: MenuSpec = { role: "action", entries: [menuItem("remove", "Remove Space", { detail: "Files stay on disk" })] };
    expect(menuSpecSize(plain).size.height).toBe(10 + 32);
    expect(menuSpecSize(detailed).size.height).toBe(10 + 40);
  });
});

describe("a choice of a value and a switch", () => {
  const select: MenuSpec = {
    role: "action",
    entries: [
      { kind: "radio", id: "space", value: "a", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], closes: true },
      { kind: "radio", id: "sort", value: "newest", options: [{ value: "newest", label: "Newest first" }], closes: false },
      { kind: "checkbox", id: "links", label: "Wikilinks", checked: true },
      menuSubmenu("menus", "Menus", {
        role: "action",
        entries: [{ kind: "radio", id: "menus.mode", value: "web", options: [{ value: "web", label: "Web" }], closes: true }],
      }),
    ],
  };

  it("close the menu only where the choice's group says so; a switch and a widget's asking never do", () => {
    expect(menuActionCloses(select, { kind: "choose", id: "space", value: "b" })).toBe(true);
    expect(menuActionCloses(select, { kind: "choose", id: "sort", value: "newest" })).toBe(false);
    expect(menuActionCloses(select, { kind: "choose", id: "menus.mode", value: "web" })).toBe(true);
    expect(menuActionCloses(select, { kind: "choose", id: "absent", value: "x" })).toBe(false);
    expect(menuActionCloses(select, { kind: "check", id: "links", checked: false })).toBe(false);
    expect(menuActionCloses(select, { kind: "widget", id: "picker", action: { kind: "create_collection", name: "Web" } })).toBe(false);
  });
});

describe("the list of spaces", () => {
  const spec: MenuSpec = {
    role: "search",
    entries: [{ kind: "widget", id: "spaces", widget: { kind: "space_list", spaces: [], unavailable: [], tabs: true } }],
  };

  it("counts at its tallest: the field, eight rows with the list's inset, the line and the two pinned actions", () => {
    expect(SPACE_LIST_MAX_HEIGHT_PX).toBe(41 + (8 * 32 + 8) + (1 + 8 + 2 * 32));
    expect(menuSpecSize(spec).size).toEqual({ width: 300, height: 378 + 2 });
  });

  it("ends the menu on a space chosen, a space to forget and the pinned actions, not on a folder shown", () => {
    const closes = (action: MenuWidgetAction) => menuActionCloses(spec, { kind: "widget", id: "spaces", action });
    expect(closes({ kind: "switch_space", path: "/a", new_tab: false })).toBe(true);
    expect(closes({ kind: "switch_space", path: "/a", new_tab: true })).toBe(true);
    expect(closes({ kind: "forget_space", path: "/a" })).toBe(true);
    expect(closes({ kind: "reveal_current_space" })).toBe(true);
    expect(closes({ kind: "add_space" })).toBe(true);
    expect(closes({ kind: "reveal_space", path: "/a" })).toBe(false);
  });
});

describe("the measures the backend shares", () => {
  const rust = readFileSync("src-tauri/src/menu_panel/geometry.rs", "utf8");
  function constant(name: string): number {
    const match = new RegExp(`pub const ${name}: f64 = ([0-9.]+);`).exec(rust);
    expect(match, name).not.toBeNull();
    return Number(match?.[1]);
  }

  it("are the page's own numbers", () => {
    // No field off the screen's edge, and a right click's menu with its
    // corner on the point (SPEC_MENU_WINDOW.md, МО2, МО10): a layer on a
    // page keeps `FLOATING_LAYER_EDGE_PX` off the window's edge instead,
    // and stands with its corner on the point too.
    expect(constant("EDGE_PX")).toBe(0);
    expect(FLOATING_LAYER_EDGE_PX).toBe(8);
    expect(constant("CONTEXT_MENU_OFFSET_PX")).toBe(MENU_POINT_OFFSET_PX);
    expect(constant("PLATE_GAP_PX")).toBe(MENU_PLATE_GAP_PX);
    expect(constant("SHADOW_FIELD_PX")).toBe(MENU_SHADOW_FIELD_PX);
    // A submenu stands against its row: the surface's border and inset in.
    expect(constant("SUBMENU_TRIGGER_INSET_PX")).toBe(5);
  });

  it("take their widths from the roles of global.css", () => {
    const css = readFileSync("src/styles/global.css", "utf8");
    expect(css).toMatch(new RegExp(`\\[data-floating-menu="search"\\] \\{\\s*--floating-menu-width: ${MENU_WIDTH_PX.search}px;`));
    expect(css).toMatch(new RegExp(`\\[data-floating-menu="action"\\] \\{\\s*--floating-menu-width: ${MENU_WIDTH_PX.action}px;`));
  });
});

describe("the shadow's field", () => {
  // The reach of one CSS shadow layer past its box on each side: the offset,
  // the spread and the blur radius, as the blur fades out over it.
  function reach(layer: string) {
    const [x, y, blur, spread] = (layer.trim().match(/-?\d+(?:\.\d+)?px|\b0\b/g) ?? []).map((value) => Number.parseFloat(value));
    const out = (offset: number) => Math.max(0, offset + (spread ?? 0) + (blur ?? 0));
    return { top: out(-(y ?? 0)), bottom: out(y ?? 0), left: out(-(x ?? 0)), right: out(x ?? 0) };
  }

  it("holds the menu's shadow whole on every side", () => {
    const theme = readFileSync("node_modules/tailwindcss/theme.css", "utf8");
    const token = /--shadow-md:\s*([^;]+);/.exec(theme)?.[1];
    expect(token).toBeTruthy();
    const layers = (token ?? "").split(/,(?![^(]*\))/).map(reach);
    const widest = Math.max(...layers.flatMap((side) => [side.top, side.bottom, side.left, side.right]));
    expect(widest).toBe(9);
    expect(widest).toBeLessThanOrEqual(MENU_SHADOW_FIELD_PX);
    // The menu's surface is the one that draws it, on the page and in the panel.
    expect(readFileSync("src/components/ui/dropdown-menu.tsx", "utf8")).toMatch(/rounded-1 border p-surface shadow-md/);
  });
});
