import type { ContextMenuData, PageMetadata } from "./messaging";

function durableImageSourceUrl(srcUrl: string | undefined): string {
  const value = srcUrl?.trim() ?? "";
  return /^https?:\/\//i.test(value) ? value : "";
}

/**
 * What "Save link" on page A captures for link B: the address of B and
 * nothing read from A. B is not loaded anywhere, so it has no title, cover,
 * description or author here; A's are never attached to it
 * (SPEC_AUDIT_FIXES.md, Ф5, Ф6, В4.2). B is also the capture's document: a
 * screenshot, crop or extraction of the tab, which shows A, is refused by the
 * same address check that guards every capture.
 */
export function linkTargetMetadata(linkUrl: string): PageMetadata {
  return {
    documentUrl: linkUrl,
    url: linkUrl,
    title: "",
    description: "",
    image: null,
    author: null,
    ogType: null,
    favicon: null,
    selection: "",
    detectedType: "link",
    isArticle: false,
  };
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
