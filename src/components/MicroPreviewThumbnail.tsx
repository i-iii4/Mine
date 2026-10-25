import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type RefObject,
} from "react";
import { usePreviewFileRetry } from "@/hooks/usePreviewFileRetry";
import { thumbnailLevelUrl } from "@/lib/assets";
import { parsePreviewManifest } from "@/lib/cardLayout";
import { cn } from "@/lib/utils";
import type { IndexedBlock, LightBlock, PreviewCard } from "@/types";

export interface MicroPreviewModel {
  slug?: string;
  url: string;
  text: boolean;
  hasThumb: boolean;
}

export function microPreviewFromPreviewCard(card: PreviewCard): MicroPreviewModel {
  return card;
}

export function microPreviewFromIndexedBlock(
  block: Pick<IndexedBlock, "slug" | "thumb_format" | "thumb_mtime" | "preview_manifest">,
  thumbsRootPath: string,
): MicroPreviewModel {
  const mtime = block.thumb_mtime > 0 ? `?m=${block.thumb_mtime}` : "";
  const manifest = parsePreviewManifest(block);
  return {
    slug: block.slug,
    // The strip draws 32 logical pixels; the micro level is exactly that at
    // double density, where the full thumbnail is 640 on its long side.
    url: `${thumbnailLevelUrl(thumbsRootPath, block.slug, "micro")}${mtime}`,
    // Text-thumb detection drives dark:invert. preview_manifest is stable
    // across the indexing→thumb-generation window; thumb_format is briefly null
    // right after a fresh clip, which would mis-flag a text thumb as media.
    // Fall back to thumb_format only for legacy blocks without a manifest.
    text: manifest ? manifest.kind === "text" : block.thumb_format === "png",
    // Always attempt the image (matches microPreviewFromLightBlock):
    // thumb_format being momentarily null must not hide an already-present
    // thumbnail. A file that is not there yet is MicroPreviewThumbnail's own
    // case: it shows the loading fill and asks again once the preview is ready.
    hasThumb: true,
  };
}

/**
 * LightBlock carries no thumb metadata (`thumb_format`/`thumb_mtime`), but the
 * thumbnail pipeline guarantees a thumb file per block (SPEC_THUMBNAILS Phase
 * 1) and the preview manifest tells text apart from media: `kind: "text"`
 * thumbs are dark-ink PNGs that need `dark:invert`. Legacy blocks without a
 * manifest fall back to "no media signals → text".
 */
export function microPreviewFromLightBlock(
  block: LightBlock,
  thumbsRootPath: string,
): MicroPreviewModel {
  const manifest = parsePreviewManifest(block);
  const text = manifest
    ? manifest.kind === "text"
    : !(block.media_file || block.thumbnail || block.first_image || block.media_urls);
  return {
    slug: block.slug,
    url: thumbnailLevelUrl(thumbsRootPath, block.slug, "micro"),
    text,
    hasThumb: true,
  };
}

/// The addresses this page has loaded a picture from. A thumbnail mounted
/// again at one of them (a sidebar strip widened after a narrowing) starts
/// loaded, as its picture is in the page's cache: without a second render to
/// learn it (SPEC_SIDEBAR_STRIP.md, ЛМ5).
const loadedSources = new Set<string>();

/** What a preview's picture shows now, and how its image reports: the
 *  address to load (with a retry mark after a failure), whether the picture
 *  is in or missing, and the handlers its image takes. */
export interface MicroPreviewPicture {
  src: string;
  loaded: boolean;
  missing: boolean;
  /** `data-micro-preview-state` of the box the picture stands in. */
  state: "loading" | "loaded" | "missing";
  imageRef: RefObject<HTMLImageElement | null>;
  onLoaded: () => void;
  onFailed: () => void;
}

/** A preview's picture, for a box of the caller's: MicroPreviewThumbnail
 *  wraps it in its own, a sidebar strip's tile stands it in the tile itself
 *  (Sidebar.tsx), one element fewer per tile. */
export function useMicroPreviewPicture(preview: MicroPreviewModel): MicroPreviewPicture {
  const imageRef = useRef<HTMLImageElement>(null);
  // A thumbnail file that is not there yet keeps the slot's loading fill and
  // is asked again when this card's preview is ready.
  const { src, missing, markMissing } = usePreviewFileRetry(preview.url, preview.slug);
  // Whether the picture is in. Stays true when the URL is cache-busted: the
  // browser keeps painting the old picture until the new one has loaded.
  const [loaded, setLoaded] = useState(() => loadedSources.has(src));

  // A picture already in the memory cache can be complete before the first
  // paint; reading that here keeps such a tile from flashing the slot fill.
  useLayoutEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) {
      setLoaded(true);
    }
  }, []);

  return {
    src,
    loaded,
    missing,
    state: missing ? "missing" : loaded ? "loaded" : "loading",
    imageRef,
    onLoaded: () => {
      loadedSources.add(src);
      setLoaded(true);
    },
    onFailed: () => {
      setLoaded(false);
      markMissing();
    },
  };
}

/** The classes of a preview's image: the box's size, cropped to it; a text
 *  thumb inverts in the dark theme. */
export function microPreviewImageClass(preview: MicroPreviewModel, fill: boolean, className?: string): string {
  return cn(
    fill ? "size-full object-cover" : "size-8 object-cover",
    preview.text ? "dark:invert" : "rounded-none",
    className,
  );
}

export function MicroPreviewThumbnail({
  preview,
  fill = false,
  className,
  onLoad,
  onError,
  ...imgProps
}: Omit<ComponentPropsWithoutRef<"img">, "src"> & {
  preview: MicroPreviewModel;
  /** Fill the slot instead of the strip's 32px: a stack's card, which the
   *  trial's large stack makes 40 (PLAN 50.38). */
  fill?: boolean;
}) {
  const picture = useMicroPreviewPicture(preview);

  if (!preview.hasThumb) {
    return null;
  }

  // Text thumbs are dark-ink PNGs on a transparent background, so whatever
  // sits behind them shows through. That background belongs here rather than
  // to each caller: every consumer used to pick its own, and they drifted
  // apart. A text thumb reads as a small feed card, so it gets the feed's
  // `bg-card`. The fill lives on the wrapper, not on the image, because
  // `dark:invert` applies to the element it is on — a fill on the image would
  // invert along with the ink and turn white.
  //
  // The card fill arrives with its ink, not before it. Until the picture has
  // decoded the slot shows the caller's own fill (the sidebar's placeholder
  // tile, a result row's component fill), the same as a media thumb that is
  // still on the way; an early card fill would read as a blank tile.
  return (
    <span
      className={cn("block overflow-hidden", fill ? "size-full" : "size-8", preview.text && picture.loaded && "bg-card")}
      data-micro-preview-state={picture.state}
    >
      {!picture.missing && (
        <img
          {...imgProps}
          ref={picture.imageRef}
          onLoad={(event) => {
            picture.onLoaded();
            onLoad?.(event);
          }}
          onError={(event) => {
            picture.onFailed();
            onError?.(event);
          }}
          src={picture.src}
          className={microPreviewImageClass(preview, fill, className)}
        />
      )}
    </span>
  );
}
