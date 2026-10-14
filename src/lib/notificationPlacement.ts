// Where the notification corner stands over the bottom bar (DESIGN_SYSTEM.md,
// «Уведомления», user's decision of 14.10.2026): 16 px above the bar's top
// edge, read from where the bar actually is in the layout, so whatever
// stands below it (the window's frame line) is counted too. Without a bar
// the corner keeps its inset from the window's edge (`--edge-rhythm`).

/** The gap between a notification and the bar's top edge. */
export const NOTIFICATION_GAP_OVER_BAR_PX = 16;

/** The property the anchor reads its distance from the bottom from. */
export const NOTIFICATION_BOTTOM_VAR = "--notification-bottom";

/** The anchor's distance from the bottom of its reference when the bar's top
 *  edge is at `barTop` and the reference ends at `referenceBottom`, both in
 *  the same coordinates. */
export function notificationBottomOverBar(barTop: number, referenceBottom: number): number {
  return Math.max(0, Math.round(referenceBottom - barTop)) + NOTIFICATION_GAP_OVER_BAR_PX;
}

/** Publish on `target` where the anchor stands for `bar`; no bar, no
 *  property, and the anchor falls back to the window inset. */
export function publishNotificationBottom(
  target: HTMLElement,
  bar: HTMLElement | null,
  referenceBottom: number,
): void {
  if (!bar) {
    target.style.removeProperty(NOTIFICATION_BOTTOM_VAR);
    return;
  }
  const bottom = notificationBottomOverBar(bar.getBoundingClientRect().top, referenceBottom);
  target.style.setProperty(NOTIFICATION_BOTTOM_VAR, `${bottom}px`);
}
