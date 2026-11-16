import { useCallback, useLayoutEffect, useRef, type RefCallback } from "react";

/**
 * Prepares a card's picture as soon as its element is mounted
 * (SPEC_FEED_SCROLL_PERFORMANCE.md, «Подготовка картинки карточки»): asks the
 * engine to load and decode it now, with the standard
 * `HTMLImageElement.decode()`.
 *
 * WebKit paints a card's layer for the first time at the edge of the visible
 * area, and a picture it has never painted is decoded asynchronously in that
 * paint: the layer comes out without the picture and is painted again once
 * the picture is decoded. A picture decoded beforehand is in the first paint.
 * The decoding runs off the main thread.
 *
 * Returns the ref of the `<img>` that shows `src`. The picture is prepared
 * again when `src` changes on the same element. `decode()` does not start a
 * load: a lazy picture is decoded once the engine has loaded it. Where the
 * method is missing (jsdom) nothing is asked, as in Detail's picture.
 *
 * A rejection is told apart by the element's state:
 * - the element is gone or shows another source: the card went away or the
 *   picture was replaced, and the new source is prepared on its own;
 * - the picture did not load: the element fires `error` after the rejection,
 *   which is the caller's `onError` and its retries;
 * - the picture's bytes arrived and the engine cannot decode them: the
 *   element fires no `error` for that, so `onUndecodable` takes the picture
 *   into the caller's failure path.
 */
export function usePreparedPicture(
  src: string | null,
  onUndecodable: () => void,
): RefCallback<HTMLImageElement> {
  // Kept in the commit itself: a rejection can settle before a passive effect
  // of the same commit has run, and must reach this render's handler.
  const onUndecodableRef = useRef(onUndecodable);
  useLayoutEffect(() => {
    onUndecodableRef.current = onUndecodable;
  }, [onUndecodable]);

  return useCallback((image: HTMLImageElement | null) => {
    if (!image || src === null || typeof image.decode !== "function") return;
    image.decode().catch(() => {
      if (!image.isConnected || image.getAttribute("src") !== src) return;
      if (!image.complete || image.naturalWidth === 0) return;
      onUndecodableRef.current();
    });
  }, [src]);
}
