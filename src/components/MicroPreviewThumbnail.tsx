import type { ComponentPropsWithoutRef } from "react";
import { thumbnailUrl } from "@/lib/assets";
import { cn } from "@/lib/utils";
import type { IndexedBlock, PreviewCard } from "@/types";

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
  block: Pick<IndexedBlock, "slug" | "thumb_format" | "thumb_mtime">,
  thumbsRootPath: string,
): MicroPreviewModel {
  const mtime = block.thumb_mtime > 0 ? `?m=${block.thumb_mtime}` : "";
  return {
    slug: block.slug,
    url: `${thumbnailUrl(thumbsRootPath, block.slug)}${mtime}`,
    text: block.thumb_format === "png",
    hasThumb: block.thumb_format != null,
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
