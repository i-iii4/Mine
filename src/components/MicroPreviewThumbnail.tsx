import type { ComponentPropsWithoutRef } from "react";
import { thumbnailUrl } from "@/lib/assets";
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
    url: `${thumbnailUrl(thumbsRootPath, block.slug)}${mtime}`,
    // Text-thumb detection drives dark:invert. preview_manifest is stable
    // across the indexing→thumb-generation window; thumb_format is briefly null
    // right after a fresh clip, which would mis-flag a text thumb as media.
    // Fall back to thumb_format only for legacy blocks without a manifest.
    text: manifest ? manifest.kind === "text" : block.thumb_format === "png",
    // The thumbnail pipeline guarantees a thumb file per block, so always
    // attempt the image (matches microPreviewFromLightBlock). thumb_format
    // being momentarily null must not hide an already-present thumbnail; the
    // consumer's onError handles the rare brand-new-block-with-no-file case.
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
    url: thumbnailUrl(thumbsRootPath, block.slug),
    text,
    hasThumb: true,
  };
}

export function MicroPreviewThumbnail({
  preview,
  className,
  ...imgProps
}: Omit<ComponentPropsWithoutRef<"img">, "src"> & {
  preview: MicroPreviewModel;
}) {
  if (!preview.hasThumb) {
    return null;
  }

  return (
    <img
      {...imgProps}
      src={preview.url}
      className={cn(
        "size-8 object-cover",
        preview.text ? "dark:invert" : "rounded-none",
        className,
      )}
    />
  );
}
