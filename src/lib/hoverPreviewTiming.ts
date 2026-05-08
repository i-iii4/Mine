export const HOVER_PREVIEW_COLD_OPEN_DELAY_MS = 500;
export const HOVER_PREVIEW_WARM_OPEN_DELAY_MS = 0;
export const HOVER_PREVIEW_WARM_WINDOW_MS = 800;

export function getHoverPreviewOpenDelay(lastOpenedAt: number | null, now = Date.now()) {
  if (lastOpenedAt === null) {
    return HOVER_PREVIEW_COLD_OPEN_DELAY_MS;
  }
  return now - lastOpenedAt <= HOVER_PREVIEW_WARM_WINDOW_MS
    ? HOVER_PREVIEW_WARM_OPEN_DELAY_MS
    : HOVER_PREVIEW_COLD_OPEN_DELAY_MS;
}
