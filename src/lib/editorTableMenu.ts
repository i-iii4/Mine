// The `Table` submenu of the open card's menu (SPEC_EDITING.md, Л9.8, Л16):
// while a table of the card's note is active in the editor, the menu offers
// the commands of its row and column. The editor is its own part of the
// bundle (Л0.6), so the menu, in the first screen, hears it through this
// small store of plain data and never imports it.

/** A command of the active table, as the menu shows it. */
export interface EditorTableMenuCommand {
  id: string;
  label: string;
  destructive: boolean;
  /** The menu draws a line before it. */
  separatorBefore: boolean;
}

/** What the editor offers the menu of one card. */
export interface EditorTableMenu {
  /** The card whose note's table is active. */
  slug: string;
  commands: readonly EditorTableMenuCommand[];
  /** Runs a command; the editor takes the focus back after it. */
  run(id: string): void;
}

let current: EditorTableMenu | null = null;
const listeners = new Set<() => void>();

function publish(next: EditorTableMenu | null) {
  current = next;
  for (const listener of listeners) listener();
}

/** The editor's active table offers these commands. */
export function offerEditorTableMenu(menu: EditorTableMenu): void {
  publish(menu);
}

/** The editor's table of `slug` is no longer active. */
export function withdrawEditorTableMenu(slug: string): void {
  if (current?.slug === slug) publish(null);
}

/** Hear the offers. */
export function subscribeEditorTableMenu(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** What is offered now. */
export function editorTableMenu(): EditorTableMenu | null {
  return current;
}
