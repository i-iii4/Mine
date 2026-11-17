// What a menu described as data measures (SPEC_MENU_WINDOW.md, МО28).
//
// A menu opened in the menu panel is placed by the backend the moment a page
// asks (src-tauri/src/menu_panel/geometry.rs): it needs the menu's size
// then, before the panel's page has drawn the menu. The size follows from
// the description alone (`MenuSpec`, src-tauri/src/menu_panel/spec.rs), as
// the menu's surface lays its entries out: every row 32 px, every separator
// 9 px, the surface's inset and border round them, the width the role's. A
// widget whose height changes while the menu is open counts at its largest:
// the panel's frame is set once for an opening and must hold the menu
// whatever it grows to. The browser check of the panel's page holds the
// count to the menu drawn (scripts/menu-panel-audit.mjs), and the constants
// the backend shares are held to its file by the tests.

import { MENU_LIST_PADDING_Y_PX, MENU_MAX_VISIBLE_ROWS, MENU_ROW_HEIGHT_PX as MENU_ROW_HEIGHTS_PX } from "@/components/QuantizedMenuScrollArea";
import type { MenuAction, MenuEntry, MenuPanelSize, MenuSpec, MenuWidget, MenuWidthRole, SubmenuSize } from "@/types";

/** A menu's width by its role (global.css, `[data-floating-menu]`). */
export const MENU_WIDTH_PX: Record<MenuWidthRole, number> = { action: 240, search: 300 };

/** A menu row: `min-h-row`, `--spacing-row`. */
export const MENU_ROW_HEIGHT_PX = MENU_ROW_HEIGHTS_PX.default;
/** A separator: one pixel and `my-surface` above and below it. */
export const MENU_SEPARATOR_HEIGHT_PX = 1 + 2 * 4;
/** The surface's inset (`p-surface`) and border round the rows. */
export const MENU_SURFACE_INSET_PX = 4;
export const MENU_BORDER_PX = 1;

/** The field of a menu's search (`SearchMenuInput`): the field 32 px, the
 *  surface's inset above and below it, the line under it. */
export const MENU_SEARCH_FIELD_HEIGHT_PX = 2 * MENU_SURFACE_INSET_PX + 32 + 1;

/** A command's row with a second line of text: two lines of `text-base`,
 *  20 px each (global.css, `--text-base--line-height`), taller than the
 *  row's least height. */
export const MENU_DETAIL_ROW_HEIGHT_PX = 2 * 20;

/** A caption or a line of text with no action: one line of `text-sm`, 16 px,
 *  with `py-1.5` above and below it. A text too long for one line wraps, and
 *  the menu then scrolls inside its counted height. */
export const MENU_TEXT_LINE_HEIGHT_PX = 16 + 2 * 6;

/** A collection picker at its tallest: the search field and a list of the
 *  most rows a menu's list shows, with the list's own inset. A typed name's
 *  refusal shows over a list of one row, and is lower than this; the words
 *  of a card that could not be made stand under the list, which gives them
 *  its rows (`QuantizedMenuScrollArea` counts what stands beside it). */
export const COLLECTION_PICKER_MAX_HEIGHT_PX =
  MENU_SEARCH_FIELD_HEIGHT_PX + MENU_MAX_VISIBLE_ROWS * MENU_ROW_HEIGHT_PX + MENU_LIST_PADDING_Y_PX.compact;

/** The list of spaces at its tallest: the search field, a list of the most
 *  rows a menu's list shows with its own inset (`default`, 8 px), and under
 *  a line the two pinned actions inside the surface's inset. */
export const SPACE_LIST_MAX_HEIGHT_PX =
  MENU_SEARCH_FIELD_HEIGHT_PX
  + MENU_MAX_VISIBLE_ROWS * MENU_ROW_HEIGHT_PX + MENU_LIST_PADDING_Y_PX.default
  + 1 + 2 * MENU_SURFACE_INSET_PX + 2 * MENU_ROW_HEIGHT_PX;

/**
 * The clear field the panel keeps round the menu and its submenu: the page
 * draws the menu's shadow (`shadow-md`, the menu's own on a page), and the
 * panel's edge must not cut it. The shadow reaches 9 px below a surface, 5 px
 * to its sides and 1 px above it (Tailwind's `--shadow-md`, its widest layer
 * `0 4px 6px -1px`); the test reads the token and holds the field to it.
 * Radix in the panel keeps this far from the panel's edges.
 */
export const MENU_SHADOW_FIELD_PX = 12;

/** The height of a widget at its largest. */
function widgetHeight(widget: MenuWidget): number {
  switch (widget.kind) {
    case "collection_picker":
    case "batch_collection_picker":
    case "new_card_picker":
      return COLLECTION_PICKER_MAX_HEIGHT_PX;
    case "space_list":
      return SPACE_LIST_MAX_HEIGHT_PX;
  }
}

function entryHeight(entry: MenuEntry): number {
  switch (entry.kind) {
    case "item":
      return entry.detail === null ? MENU_ROW_HEIGHT_PX : MENU_DETAIL_ROW_HEIGHT_PX;
    case "submenu":
    case "checkbox":
      return MENU_ROW_HEIGHT_PX;
    case "radio":
      return entry.options.length * MENU_ROW_HEIGHT_PX;
    case "separator":
      return MENU_SEPARATOR_HEIGHT_PX;
    case "caption":
    case "note":
      return MENU_TEXT_LINE_HEIGHT_PX;
    case "widget":
      return widgetHeight(entry.widget);
  }
}

/** What stands between a surface's edge and its entries: the border, and
 *  the surface's inset round a menu of commands. A list under a search field
 *  fills its surface to the border. */
function surfaceInset(role: MenuWidthRole): number {
  return role === "search" ? MENU_BORDER_PX : MENU_BORDER_PX + MENU_SURFACE_INSET_PX;
}

type MenuItemEntry = Extract<MenuEntry, { kind: "item" }>;

/** A command's row: an ordinary one that closes its menu, but for what
 *  `more` says of it. */
export function menuItem(
  id: string,
  label: string,
  more: Partial<Pick<MenuItemEntry, "icon" | "variant" | "truncate" | "disabled" | "stays_open" | "plain" | "detail">> = {},
): MenuItemEntry {
  return {
    kind: "item",
    id,
    label,
    icon: more.icon ?? null,
    variant: more.variant ?? "default",
    truncate: more.truncate ?? false,
    disabled: more.disabled ?? false,
    stays_open: more.stays_open ?? false,
    plain: more.plain ?? false,
    detail: more.detail ?? null,
  };
}

type MenuSubmenuEntry = Extract<MenuEntry, { kind: "submenu" }>;

/** A row that opens `content` beside it: with an empty leading slot, but
 *  for what `more` says of it. */
export function menuSubmenu(
  id: string,
  label: string,
  content: MenuSpec,
  more: Partial<Pick<MenuSubmenuEntry, "icon" | "plain">> = {},
): MenuSubmenuEntry {
  return { kind: "submenu", id, label, icon: more.icon ?? null, plain: more.plain ?? false, content };
}

/** The entry `id` of `spec` or of a submenu of it, or null. */
function entryOf(spec: MenuSpec, id: string): MenuEntry | null {
  for (const entry of spec.entries) {
    if ("id" in entry && entry.id === id) return entry;
    if (entry.kind === "submenu") {
      const inner = entryOf(entry.content, id);
      if (inner !== null) return inner;
    }
  }
  return null;
}

/**
 * Whether the choice `action` made in the menu `spec` closes the menu
 * (SPEC_MENU_WINDOW.md, МО24): a command does unless its row keeps the menu
 * open, a choice of a value does when its group says so, a switch never
 * does, and a widget's asking does where the asking itself ends the menu.
 */
export function menuActionCloses(spec: MenuSpec, action: MenuAction): boolean {
  if (action.kind === "run") {
    const entry = entryOf(spec, action.id);
    return !(entry?.kind === "item" && entry.stays_open);
  }
  if (action.kind === "choose") {
    const entry = entryOf(spec, action.id);
    return entry?.kind === "radio" && entry.closes;
  }
  if (action.kind === "widget") {
    // The list of spaces: going to a space, the question about taking one
    // off the list and the two pinned actions end the menu; showing a
    // space's folder leaves it for the next folder.
    switch (action.action.kind) {
      case "switch_space":
      case "forget_space":
      case "reveal_current_space":
      case "add_space":
        return true;
      default:
        return false;
    }
  }
  return false;
}

export interface MenuSpecSize {
  /** The menu at its largest. */
  size: MenuPanelSize;
  /** Each of its submenus at its largest, and how far below the menu's top
   *  the row it opens off starts. */
  submenus: SubmenuSize[];
}

/** The size of the menu `spec` describes, as its surface lays it out. */
export function menuSpecSize(spec: MenuSpec): MenuSpecSize {
  const inset = surfaceInset(spec.role);
  const submenus: SubmenuSize[] = [];
  let top = inset;
  for (const entry of spec.entries) {
    if (entry.kind === "submenu") {
      const { size } = menuSpecSize(entry.content);
      submenus.push({ row_top: top, width: size.width, height: size.height });
    }
    top += entryHeight(entry);
  }
  return { size: { width: MENU_WIDTH_PX[spec.role], height: top + inset }, submenus };
}
