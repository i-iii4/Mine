// What the menus of an open card's content hold, as data: a media file's
// menu (its ellipsis and its right click), the picker of a new card's
// collection (a media file's Create Element and the selected text's), and
// an embedded video's menu. One description each, drawn on the page and in
// the menu panel alike (`MenuSpec`, src/components/MenuSpecView.tsx;
// SPEC_MENU_WINDOW.md, МО16, group В; SPEC_MEDIA_ASSET_ACTIONS.md;
// SPEC_TEXT_SELECTION_EXTRACTION.md).

import type { MenuEntry, MenuSpec, MenuWidget, TagCount } from "@/types";
import { menuItem, menuSubmenu } from "./menuSpec";

/** The picker of a new card's collection, in every menu that holds it. */
export const NEW_CARD_PICKER_ID = "create.picker";

/** The picker of a new card's collection, as a menu's widget: every
 *  collection of the space in its own order, the one the feed stands on
 *  named for the picker to list first. */
export function newCardPickerWidget(tags: readonly TagCount[], currentTag: string | null): MenuWidget {
  return { kind: "new_card_picker", collections: tags.map(({ tag }) => tag), current: currentTag };
}

/** Create Element of a selected text: the picker as the whole menu. */
export function newCardSpec(tags: readonly TagCount[], currentTag: string | null): MenuSpec {
  return { role: "search", entries: [{ kind: "widget", id: NEW_CARD_PICKER_ID, widget: newCardPickerWidget(tags, currentTag) }] };
}

const MEDIA_ITEM_IDS = ["reveal", "copy-path", "copy-media", "rename", "remove", "delete"] as const;

export type MediaMenuItemId = (typeof MEDIA_ITEM_IDS)[number];

/** The item of a media file's menu `id` names, or null for another entry's. */
export function mediaMenuItemId(id: string): MediaMenuItemId | null {
  return MEDIA_ITEM_IDS.find((item) => item === id) ?? null;
}

/** Create Element's submenu of a media file's menu. */
export const MEDIA_MENU_CREATE_ID = "create";

export interface MediaMenuSpecInput {
  tags: readonly TagCount[];
  currentTag: string | null;
  /** Why the file could not be copied, or null. */
  copyError: string | null;
}

/**
 * A media file's menu: the ellipsis on a picture and the right click on a
 * picture or a video show this one menu. Groups by what they act on: a new
 * card of the file, the file where it is, the file itself. Copy Media keeps
 * the menu open, and why it failed stands under its row.
 */
export function mediaAssetSpec({ tags, currentTag, copyError }: MediaMenuSpecInput): MenuSpec {
  const item = (id: MediaMenuItemId, label: string, more: Parameters<typeof menuItem>[2] = {}) => menuItem(id, label, more);
  const entries: MenuEntry[] = [
    menuSubmenu(MEDIA_MENU_CREATE_ID, "Create Element", newCardSpec(tags, currentTag), { icon: "plus" }),
    { kind: "separator" },
    item("reveal", "Reveal in Finder"),
    item("copy-path", "Copy Path"),
    item("copy-media", "Copy Media", { stays_open: true }),
  ];
  if (copyError !== null) entries.push({ kind: "note", text: copyError, tone: "error" });
  entries.push(
    { kind: "separator" },
    item("rename", "Rename Media..."),
    item("remove", "Remove from Element", { icon: "unlink", variant: "detach" }),
    item("delete", "Delete Media", { icon: "trash", variant: "destructive" }),
  );
  return { role: "action", entries };
}

const SOURCE_VIDEO_ITEM_IDS = ["open-original", "copy-link", "download", "delete-embed"] as const;

export type SourceVideoMenuItemId = (typeof SOURCE_VIDEO_ITEM_IDS)[number];

/** The item of an embedded video's menu `id` names, or null. */
export function sourceVideoMenuItemId(id: string): SourceVideoMenuItemId | null {
  return SOURCE_VIDEO_ITEM_IDS.find((item) => item === id) ?? null;
}

/** An embedded video's menu, with only the actions a link supports.
 *  Download Media cannot be chosen while a download of the video runs. */
export function sourceVideoSpec({ downloading }: { downloading: boolean }): MenuSpec {
  const item = (id: SourceVideoMenuItemId, label: string, more: Parameters<typeof menuItem>[2] = {}) => menuItem(id, label, more);
  return {
    role: "action",
    entries: [
      item("open-original", "Open Original"),
      item("copy-link", "Copy Link"),
      item("download", "Download Media", { disabled: downloading }),
      { kind: "separator" },
      item("delete-embed", "Delete Embed", { icon: "trash", variant: "destructive" }),
    ],
  };
}
