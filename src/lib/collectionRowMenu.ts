// What the menu of a collection's row in the sidebar holds, as data: the
// one description the right click draws, on the page and in the menu panel
// (`MenuSpec`, src/components/MenuSpecView.tsx; SPEC_MENU_WINDOW.md, МО16,
// Г4).

import type { MenuAction, MenuSpec } from "@/types";
import { menuItem } from "./menuSpec";

const ITEM_IDS = ["rename", "reveal", "delete"] as const;

export type CollectionRowMenuItemId = (typeof ITEM_IDS)[number];

/** The item of the row's menu `action` chooses, or null. */
export function collectionRowMenuItemId(action: MenuAction): CollectionRowMenuItemId | null {
  return action.kind === "run" ? ITEM_IDS.find((item) => item === action.id) ?? null : null;
}

/**
 * The row's menu. The collection is a page in the folder: Reveal in Finder
 * opens it where the cards' own opens theirs. Its page is looked up as the
 * menu opens, and the command cannot be chosen until the page is found
 * (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К10).
 */
export function collectionRowSpec({ pageFound }: { pageFound: boolean }): MenuSpec {
  return {
    role: "action",
    entries: [
      menuItem("rename", "Rename", { icon: "pencil" }),
      menuItem("reveal", "Reveal in Finder", { icon: "folder", disabled: !pageFound }),
      menuItem("delete", "Delete", { icon: "trash", variant: "destructive" }),
    ],
  };
}
