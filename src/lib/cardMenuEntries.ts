// What the card menu holds, as data: the one description the menu on the page
// and the menu in the panel draw (`MenuSpec`, src/components/MenuSpecView.tsx;
// SPEC_MENU_WINDOW.md, МО16), and the one place an item's command runs, in
// the tab the card is in. Groups by what they act on: the card's
// collections, its link, its file, the card itself (user's decision of
// 12.11.2026). A card without a link has no link group and no line of its
// own for it.

import type { MenuEntry, MenuSpec, MenuWidget, TagCount } from "@/types";
import { COPY_LINK_FAILED_TITLE, COPY_PATH_FAILED_TITLE, copyTextToClipboard } from "./clipboard";
import { collectionRefLabel } from "./collections";
import type { EditorTableMenuCommand } from "./editorTableMenu";
import { menuItem, menuSubmenu } from "./menuSpec";
import { openLinkInBrowser, revealInFinder } from "./systemActions";

const ITEM_IDS = ["source", "copy-link", "reveal", "copy-path", "rename", "disconnect", "delete"] as const;

export type CardMenuItemId = (typeof ITEM_IDS)[number];

/** The item of the card menu `id` names, or null for another entry's. */
export function cardMenuItemId(id: string): CardMenuItemId | null {
  return ITEM_IDS.find((item) => item === id) ?? null;
}

/** Connect's submenu and the picker in it. */
export const CARD_MENU_CONNECT_ID = "connect";
export const CARD_MENU_PICKER_ID = "connect.picker";
/** The submenu of the table active in the card's editor. */
export const CARD_MENU_TABLE_ID = "table";
const TABLE_COMMAND_PREFIX = "table:";

/** The table command an entry's `id` names, or null for another entry's. */
export function cardMenuTableCommand(id: string): string | null {
  return id.startsWith(TABLE_COMMAND_PREFIX) ? id.slice(TABLE_COMMAND_PREFIX.length) : null;
}

/** A command of the table active in the card's editor, as plain data. */
export type CardMenuTableCommand = EditorTableMenuCommand;

/** What Connect's picker shows: the card, its collections, and every one. */
export interface CardMenuPicker {
  card: string;
  selected: readonly string[];
  tags: readonly TagCount[];
  currentTag: string | null;
}

/** The picker of the card's collections, as the menu's widget. */
export function cardPickerWidget({ card, selected, tags, currentTag }: CardMenuPicker): MenuWidget {
  return {
    kind: "collection_picker",
    card,
    selected: [...selected],
    collections: tags.map(({ tag, count }) => ({ name: tag, count })),
    current: currentTag,
  };
}

export interface CardMenuSpecInput {
  hasUrl: boolean;
  /** The collection the feed stands on, when the card is in it: the menu
   *  offers to disconnect it. */
  disconnectFrom: string | null;
  /** The commands of the table active in the card's editor (SPEC_EDITING.md,
   *  Л9.8, Л16). */
  tableCommands: readonly CardMenuTableCommand[];
  picker: CardMenuPicker;
}

function item(id: CardMenuItemId, label: string, more: Parameters<typeof menuItem>[2] = {}): MenuEntry {
  return menuItem(id, label, more);
}

/** The card menu: `More`, the right click and ⌘K show this one menu. */
export function cardMenuSpec({ hasUrl, disconnectFrom, tableCommands, picker }: CardMenuSpecInput): MenuSpec {
  const entries: MenuEntry[] = [
    menuSubmenu(CARD_MENU_CONNECT_ID, "Connect", cardConnectSpec(picker), { icon: "plus" }),
  ];
  if (tableCommands.length > 0) {
    entries.push(menuSubmenu(CARD_MENU_TABLE_ID, "Table", {
      role: "action",
      entries: tableCommands.flatMap((command): MenuEntry[] => [
        ...(command.separatorBefore ? [{ kind: "separator" } as const] : []),
        menuItem(`${TABLE_COMMAND_PREFIX}${command.id}`, command.label, { variant: command.destructive ? "destructive" : "default" }),
      ]),
    }));
  }
  if (hasUrl) {
    entries.push(
      { kind: "separator" },
      item("source", "Source", { icon: "external" }),
      // The card's link, beside the item that opens it (user's decision of
      // 11.11.2026).
      item("copy-link", "Copy Link"),
    );
  }
  entries.push(
    { kind: "separator" },
    item("reveal", "Reveal in Finder"),
    item("copy-path", "Copy Path"),
    { kind: "separator" },
    item("rename", "Rename…"),
  );
  if (disconnectFrom !== null) {
    entries.push(item("disconnect", `Disconnect from “${collectionRefLabel(disconnectFrom)}”`, { icon: "unlink", variant: "detach", truncate: true }));
  }
  entries.push(item("delete", "Delete", { icon: "trash", variant: "destructive" }));
  return { role: "action", entries };
}

/** Connect alone, the card's `+`: the picker of its collections as a menu. */
export function cardConnectSpec(picker: CardMenuPicker): MenuSpec {
  return { role: "search", entries: [{ kind: "widget", id: CARD_MENU_PICKER_ID, widget: cardPickerWidget(picker) }] };
}

/** What an item's command needs from the tab the card is in. */
export interface CardMenuCommandContext<TBlock> {
  block: TBlock;
  url: string | null;
  filePath: string;
  currentTag: string | undefined;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onRequestRename: (block: TBlock) => void;
  onRequestDelete: (slug: string) => void;
}

/** Carry out the item `id` of the card menu. */
export function runCardMenuItem<TBlock extends { slug: string }>(id: CardMenuItemId, context: CardMenuCommandContext<TBlock>): void {
  const { block, url, filePath, currentTag } = context;
  switch (id) {
    case "source":
      if (url !== null) openLinkInBrowser(url);
      return;
    case "copy-link":
      if (url !== null) void copyTextToClipboard(url, COPY_LINK_FAILED_TITLE);
      return;
    case "reveal":
      revealInFinder(filePath);
      return;
    case "copy-path":
      void copyTextToClipboard(filePath, COPY_PATH_FAILED_TITLE);
      return;
    case "rename":
      context.onRequestRename(block);
      return;
    case "disconnect":
      if (currentTag !== undefined) context.onToggleTag(block.slug, currentTag, true);
      return;
    case "delete":
      context.onRequestDelete(block.slug);
      return;
  }
}
