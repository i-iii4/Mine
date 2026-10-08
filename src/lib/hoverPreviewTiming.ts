import { HOVER_INTENT } from "@/lib/hoverIntent";

export const HOVER_PREVIEW_COLD_OPEN_DELAY_MS = 500;
export const HOVER_PREVIEW_WARM_OPEN_DELAY_MS = 0;
export const HOVER_PREVIEW_WARM_WINDOW_MS = 800;

/**
 * When a card's hover preview opens, for every surface that shows one
 * (SPEC_CARD_STATES.md, С7.10): after the cold delay, and only once the
 * pointer rests, so a pointer passing over the triggers opens nothing.
 * Within the warm window after a preview was last on screen the next trigger
 * answers a resting pointer at once, as tooltips do. The warm window runs
 * from the moment the preview left the screen, not from when it opened: a
 * preview read for a while still hands over to its neighbour at once.
 */
export class HoverPreviewOpener {
  private readonly isResting: () => boolean;
  private timer: number | null = null;
  private onScreen = false;
  private lastOnScreenAt: number | null = null;

  constructor(isResting: () => boolean) {
    this.isResting = isResting;
  }

  /**
   * The pointer came onto a trigger: `show` puts its preview on screen when
   * the time comes. Replaces a pending request; a preview still on screen
   * counts as gone from now.
   */
  request(show: () => void): void {
    this.hide();
    const delay = this.openDelay();
    if (delay <= 0) {
      this.showWhenResting(show);
      return;
    }
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.showWhenResting(show);
    }, delay);
  }

  /** Drops a pending request; a preview on screen stays. */
  cancel(): void {
    if (this.timer === null) return;
    window.clearTimeout(this.timer);
    this.timer = null;
  }

  /** The preview leaves the screen: the warm window starts now. */
  hide(): void {
    this.cancel();
    if (!this.onScreen) return;
    this.onScreen = false;
    this.lastOnScreenAt = Date.now();
  }

  dispose(): void {
    this.cancel();
  }

  /** Cold, or none within the warm window after a preview was on screen. */
  private openDelay(): number {
    if (this.lastOnScreenAt === null) return HOVER_PREVIEW_COLD_OPEN_DELAY_MS;
    return Date.now() - this.lastOnScreenAt <= HOVER_PREVIEW_WARM_WINDOW_MS
      ? HOVER_PREVIEW_WARM_OPEN_DELAY_MS
      : HOVER_PREVIEW_COLD_OPEN_DELAY_MS;
  }

  /** A pointer still crossing the trigger is checked again a moment later. */
  private showWhenResting(show: () => void): void {
    if (!this.isResting()) {
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.showWhenResting(show);
      }, HOVER_INTENT.velocityWindowMs);
      return;
    }
    this.onScreen = true;
    this.lastOnScreenAt = Date.now();
    show();
  }
}
