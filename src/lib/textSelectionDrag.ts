export type MineTextSelectionDragPayload = {
  type: "text_selection";
  sourceSlug: string;
  selectedText: string;
  firstBlockStart: number;
  firstBlockEnd: number;
  sourceBodyHash: string;
  /** A selection of the editor: its exact byte range of the body, which the
   *  backend takes as written (SPEC_EDITING.md, Л11.2). */
  sourceRange?: { start: number; end: number };
};

let activeMineTextSelectionDragPayload: MineTextSelectionDragPayload | null = null;

export function setActiveMineTextSelectionDragPayload(payload: MineTextSelectionDragPayload): void {
  activeMineTextSelectionDragPayload = payload;
}

export function getActiveMineTextSelectionDragPayload(): MineTextSelectionDragPayload | null {
  return activeMineTextSelectionDragPayload;
}

export function clearActiveMineTextSelectionDragPayload(): void {
  activeMineTextSelectionDragPayload = null;
}
