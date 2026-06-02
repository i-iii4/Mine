import type { ContextMenuData, PageMetadata } from "./messaging";

function durableImageSourceUrl(srcUrl: string | undefined): string {
  const value = srcUrl?.trim() ?? "";
  return /^https?:\/\//i.test(value) ? value : "";
}

export function applySaveImageContextMenu(
  ctx: Pick<ContextMenuData, "srcUrl">,
  meta: PageMetadata,
): void {
  const imageUrl = ctx.srcUrl?.trim() || undefined;

  meta.detectedType = "image";
  meta.imageToSave = imageUrl;
  meta.url = durableImageSourceUrl(imageUrl);
}
