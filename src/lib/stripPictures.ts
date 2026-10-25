// The page's cache of the sidebar strips' pictures (SPEC_SIDEBAR_STRIP.md,
// ЛМ4). A tile taken off by a narrowing and shown again by a widening asks
// for the same address; the engine reuses a picture it still holds and asks
// the file again for one it let go, and it lets go of the pictures no element
// shows once its own memory cache prunes them. So every strip picture that
// has loaded stays held here, by its address, while its card is in a list the
// page read: a strip widened again draws it from memory and reads no file.

const held = new Map<string, HTMLImageElement>();

/** Holds the picture at `src`, which a strip's tile has just loaded. */
export function holdStripPicture(src: string): void {
  if (held.has(src)) return;
  const picture = new Image();
  picture.decoding = "async";
  picture.src = src;
  held.set(src, picture);
}

/** The retry mark `withRetry` puts after an address. */
const RETRY_MARK = /[?&]retry=\d+$/;

/** Lets go of every held picture whose card is not at one of `addresses`:
 *  the card left the space, or its picture changed. A held address may carry
 *  a retry mark after its base address (assets.ts, `withRetry`). */
export function releaseStripPicturesExcept(addresses: ReadonlySet<string>): void {
  for (const src of held.keys()) {
    if (!addresses.has(src.replace(RETRY_MARK, ""))) held.delete(src);
  }
}
