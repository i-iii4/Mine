// What the card menu holds, as data: the one list the menu on the page and the
// menu in the panel draw (CardHoverMenu.tsx, src/menuPanel), and the one place
// an item's command runs, in the tab the card is in. Groups by what they act
// on: the card's collections, its link, its file, the card itself (user's
// decision of 12.11.2026). A card without a link has no link group and no
// line of its own for it.

import { COPY_LINK_FAILED_TITLE, COPY_PATH_FAILED_TITLE, copyTextToClipboard } from "./clipboard";
import { collectionRefLabel } from "./collections";
import type { EditorTableMenuCommand } from "./editorTableMenu";
import { openLinkInBrowser, revealInFinder } from "./systemActions";

export type CardMenuItemId = "source" | "copy-link" | "reveal" | "copy-path" | "rename" | "disconnect" | "delete";

export type CardMenuIcon = "external" | "unlink" | "trash" | null;

/** A command of the table active in the card's editor, as plain data. */
export type CardMenuTableCommand = EditorTableMenuCommand;

export type CardMenuEntry =
  | { kind: "connect" }
  | { kind: "table"; commands: readonly CardMenuTableCommand[] }
  | { kind: "separator"; key: string }
  | {
    kind: "item";
    id: CardMenuItemId;
    label: string;
    icon: CardMenuIcon;
    variant: "default" | "detach" | "destructive";
    /** The label may be longer than the row: cut with an ellipsis. */
    truncate: boolean;
  };

export interface CardMenuEntriesInput {
  hasUrl: boolean;
  /** The collection the feed stands on, when the card is in it: the menu
   *  offers to disconnect it. */
  disconnectFrom: string | null;
  /** The commands of the table active in the card's editor (SPEC_EDITING.md,
   *  Л9.8, Л16). */
  tableCommands: readonly CardMenuTableCommand[];
}

export function cardMenuEntries({ hasUrl, disconnectFrom, tableCommands }: CardMenuEntriesInput): CardMenuEntry[] {
  const entries: CardMenuEntry[] = [{ kind: "connect" }];
  if (tableCommands.length > 0) entries.push({ kind: "table", commands: tableCommands });
  if (hasUrl) {
    entries.push(
      { kind: "separator", key: "link" },
      { kind: "item", id: "source", label: "Source", icon: "external", variant: "default", truncate: false },
      // The card's link, beside the item that opens it (user's decision of
      // 11.11.2026).
      { kind: "item", id: "copy-link", label: "Copy Link", icon: null, variant: "default", truncate: false },
    );
  }
  entries.push(
    { kind: "separator", key: "file" },
    { kind: "item", id: "reveal", label: "Reveal in Finder", icon: null, variant: "default", truncate: false },
    { kind: "item", id: "copy-path", label: "Copy Path", icon: null, variant: "default", truncate: false },
    { kind: "separator", key: "card" },
    { kind: "item", id: "rename", label: "Rename…", icon: null, variant: "default", truncate: false },
  );
  if (disconnectFrom !== null) {
    entries.push({
      kind: "item",
      id: "disconnect",
      label: `Disconnect from “${collectionRefLabel(disconnectFrom)}”`,
      icon: "unlink",
      variant: "detach",
      truncate: true,
    });
  }
  entries.push({ kind: "item", id: "delete", label: "Delete", icon: "trash", variant: "destructive", truncate: false });
  return entries;
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
