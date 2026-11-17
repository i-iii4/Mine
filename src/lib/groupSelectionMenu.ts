// What the menu of a selection of cards holds, as data: the one description
// its three entry points draw, the commands row's Connect, the ⌘K menu on a
// card and the right click's, on the page and in the menu panel
// (`MenuSpec`, src/components/MenuSpecView.tsx; SPEC_MENU_WINDOW.md, МО16;
// SPEC_GROUP_SELECTION.md, «Точки входа»).
//
// Every command acts on the whole selection, so the single-card commands are
// absent by construction rather than disabled: `Reveal in Finder`,
// `Copy Path` and `Rename…` address one file, and `Source` opens one URL.

import type { MenuEntry, MenuSpec, MenuWidget, TagCount } from "@/types";
import { selectedElementCountLabel } from "./groupSelection";
import { menuItem, menuSubmenu } from "./menuSpec";

const ITEM_IDS = ["disconnect", "merge", "delete"] as const;

export type GroupMenuItemId = (typeof ITEM_IDS)[number];

/** The item of the selection's menu `id` names, or null for another entry's. */
export function groupMenuItemId(id: string): GroupMenuItemId | null {
  return ITEM_IDS.find((item) => item === id) ?? null;
}

/** Connect's submenu and the picker in it. */
export const GROUP_MENU_CONNECT_ID = "connect";
export const GROUP_MENU_PICKER_ID = "connect.picker";

/** What Connect's picker shows: the selected cards, the collections each is
 *  in as far as they are read, and every collection of the space. */
export interface GroupMenuPicker {
  cards: readonly string[];
  tags: readonly TagCount[];
  lookup: ReadonlyMap<string, readonly string[]>;
}

/** The picker of a selection's collections, as the menu's widget: a
 *  collection is ticked when every selected card is in it. */
export function groupPickerWidget({ cards, tags, lookup }: GroupMenuPicker): MenuWidget {
  const inAll = tags
    .map(({ tag }) => tag)
    .filter((tag) => cards.length > 0 && cards.every((card) => lookup.get(card)?.includes(tag) === true));
  return {
    kind: "batch_collection_picker",
    cards: [...cards],
    in_all: inAll,
    collections: tags.map(({ tag, count }) => ({ name: tag, count })),
  };
}

function item(id: GroupMenuItemId, label: string, more: Parameters<typeof menuItem>[2] = {}): MenuEntry {
  return menuItem(id, label, more);
}

export interface GroupMenuSpecInput {
  /** How many cards are selected. */
  count: number;
  /** The feed stands on a collection: the menu offers to disconnect the
   *  selection from it. */
  inCollection: boolean;
  /** Why the selection's collections could not be read, or null. */
  error: string | null;
  picker: GroupMenuPicker;
}

/** The selection's menu: ⌘K on a selected card and the right click show it. */
export function groupSelectionSpec({ count, inCollection, error, picker }: GroupMenuSpecInput): MenuSpec {
  const entries: MenuEntry[] = [
    { kind: "caption", text: selectedElementCountLabel(count) },
    { kind: "separator" },
    menuSubmenu(GROUP_MENU_CONNECT_ID, "Connect", groupConnectSpec(picker), { icon: "plus" }),
  ];
  if (inCollection) {
    entries.push(item("disconnect", "Disconnect", { icon: "unlink", variant: "detach" }));
  }
  // One card has nothing to merge with.
  if (count >= 2) {
    entries.push(item("merge", "Merge"));
  }
  entries.push(item("delete", "Delete", { icon: "trash", variant: "destructive" }));
  if (error !== null) {
    entries.push({ kind: "separator" }, { kind: "note", text: error, tone: "error" });
  }
  return { role: "action", entries };
}

/** Connect alone, the commands row's button: the picker as a menu. */
export function groupConnectSpec(picker: GroupMenuPicker): MenuSpec {
  return { role: "search", entries: [{ kind: "widget", id: GROUP_MENU_PICKER_ID, widget: groupPickerWidget(picker) }] };
}
