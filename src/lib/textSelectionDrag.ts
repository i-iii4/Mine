export const MINE_TEXT_SELECTION_DRAG_TYPE = "application/x-mine-text-selection";

export type MineTextSelectionDragPayload = {
  type: "text_selection";
  sourceSlug: string;
  selectedText: string;
  firstBlockStart: number;
  firstBlockEnd: number;
  sourceBodyHash: string;
  title: string | null;
};

export function writeMineTextSelectionDragData(
  dataTransfer: DataTransfer | null,
  payload: MineTextSelectionDragPayload,
): boolean {
  if (!dataTransfer) return false;
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(MINE_TEXT_SELECTION_DRAG_TYPE, JSON.stringify(payload));
  dataTransfer.setData("text/plain", payload.selectedText);
  return true;
}

export function hasMineTextSelectionDragData(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types).includes(MINE_TEXT_SELECTION_DRAG_TYPE);
}

export function readMineTextSelectionDragData(
  dataTransfer: DataTransfer | null,
): MineTextSelectionDragPayload | null {
  if (!dataTransfer) return null;
  const raw = dataTransfer.getData(MINE_TEXT_SELECTION_DRAG_TYPE);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<MineTextSelectionDragPayload>;
    if (value.type !== "text_selection") return null;
    if (typeof value.sourceSlug !== "string" || !value.sourceSlug) return null;
    if (typeof value.selectedText !== "string" || !value.selectedText.trim()) return null;
    if (typeof value.firstBlockStart !== "number" || !Number.isFinite(value.firstBlockStart)) return null;
    if (typeof value.firstBlockEnd !== "number" || !Number.isFinite(value.firstBlockEnd)) return null;
    if (typeof value.sourceBodyHash !== "string" || !value.sourceBodyHash) return null;
    return {
      type: "text_selection",
      sourceSlug: value.sourceSlug,
      selectedText: value.selectedText,
      firstBlockStart: value.firstBlockStart,
      firstBlockEnd: value.firstBlockEnd,
      sourceBodyHash: value.sourceBodyHash,
      title: typeof value.title === "string" ? value.title : null,
    };
  } catch {
    return null;
  }
}
