export type MineTextSelectionDragPayload = {
  type: "text_selection";
  sourceSlug: string;
  selectedText: string;
  firstBlockStart: number;
  firstBlockEnd: number;
  sourceBodyHash: string;
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
