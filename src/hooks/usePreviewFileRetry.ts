// A preview file that is not there yet (a card saved a moment ago, a preview
// still being built) is not a broken picture (SPEC_THUMBNAILS.md, «Нет файла
// миниатюры»). Every surface that draws a card's preview file owns the same
// case: on a failed load the picture is hidden and the slot keeps its loading
// fill instead of the browser's broken-image icon, and the file is asked again
// once this card's preview is ready (`thumb:updated`).

import { useEffect, useState } from "react";
import { withRetry } from "@/lib/assets";
import { listenPage } from "@/lib/pageEvents";

/** `thumb:updated` payload; only the slug matters here. */
interface ThumbUpdatedPayload {
  slug: string;
}

export interface PreviewFileRetry {
  /// The address to load: the caller's URL, with a retry mark after a failure.
  src: string;
  /// Whether the file at `src` failed to load. The caller hides its picture
  /// and keeps the fill it shows while loading.
  missing: boolean;
  /// Record a failed load of `src`; wire it to the image's `onError`.
  markMissing: () => void;
}

/// Load `url`, and after a failure wait for the preview of `slug` to be ready.
///
/// A caller that cache-busts its URL on that event (the sidebar) gets a new
/// address, which clears the failure by itself. Without a slug there is no
/// event to wait for and the slot simply keeps its fill.
export function usePreviewFileRetry(url: string, slug: string | null | undefined): PreviewFileRetry {
  const [retry, setRetry] = useState(0);
  const src = withRetry(url, retry);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const missing = failedSrc === src;

  useEffect(() => {
    if (!missing || !slug) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listenPage<ThumbUpdatedPayload>("thumb:updated", (event) => {
      if (event.payload.slug === slug) setRetry((count) => count + 1);
    }).then(
      (stop) => {
        if (disposed) stop();
        else unlisten = stop;
      },
      // Outside a Tauri page (a dev browser route) there is no event to wait
      // for; the slot simply keeps its fill.
      () => {},
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [missing, slug]);

  return { src, missing, markMissing: () => setFailedSrc(src) };
}
