/**
 * Whether the pointer itself has moved since content last changed under it
 * (SPEC_CARD_STATES.md, С7.5).
 *
 * Content that changes under a resting pointer reaches the page as pointer
 * events: WebKit fires `mouseenter` on what now stands there and repeats
 * `pointermove` at the same point. Only a report at another point is the
 * pointer's own doing, and `movementX` cannot tell: WebKit reports 0 for a real
 * step too. The first report after the pointer entered the surface has nothing
 * to compare with, so it only sets the point.
 */
export class RestingPointer {
  private point: { x: number; y: number } | null = null;
  private still = true;
  private stepped = false;

  /**
   * The pointer is over the surface at (x, y). Answers whether this report is
   * the pointer's own step: a report at the same point never is, whatever
   * content did under it.
   */
  move(x: number, y: number): boolean {
    const last = this.point;
    this.point = { x, y };
    const elsewhere = last !== null && (last.x !== x || last.y !== y);
    if (elsewhere) this.still = false;
    this.stepped = !this.still && (elsewhere || last === null);
    return this.stepped;
  }

  /** Whether the latest report was the pointer's own step. */
  lastReportStepped(): boolean {
    return this.stepped;
  }

  /** The pointer left the surface: where it comes back says nothing yet. */
  leave(): void {
    this.point = null;
  }

  /** Content changed under the pointer. */
  displace(): void {
    this.still = true;
    this.stepped = false;
  }

  /** Nothing should answer: content changed and the pointer has not moved. */
  isStill(): boolean {
    return this.still;
  }
}
