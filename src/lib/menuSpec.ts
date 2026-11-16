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
import type { MenuEntry, MenuPanelSize, MenuSpec, MenuWidget, MenuWidthRole, SubmenuSize } from "@/types";

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

/** The collection picker at its tallest: the search field and a list of the
 *  most rows a menu's list shows, with the list's own inset. A typed name's
 *  refusal shows over a list of one row, and is lower than this. */
export const COLLECTION_PICKER_MAX_HEIGHT_PX =
  MENU_SEARCH_FIELD_HEIGHT_PX + MENU_MAX_VISIBLE_ROWS * MENU_ROW_HEIGHT_PX + MENU_LIST_PADDING_Y_PX.compact;

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
      return COLLECTION_PICKER_MAX_HEIGHT_PX;
  }
}

function entryHeight(entry: MenuEntry): number {
  switch (entry.kind) {
    case "item":
    case "submenu":
      return MENU_ROW_HEIGHT_PX;
    case "separator":
      return MENU_SEPARATOR_HEIGHT_PX;
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
