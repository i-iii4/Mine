import type { LightBlock } from "@/types";

type DisplayTitleBlock = Pick<
  LightBlock,
  "slug" | "fallback_label" | "content_heading" | "display_title" | "title"
>;

export function getFallbackLabel(block: DisplayTitleBlock): string {
  return block.fallback_label?.trim() || block.slug;
}

export function getDisplayTitle(block: DisplayTitleBlock): string | null {
  const contentHeading = block.content_heading?.trim();
  if (contentHeading) {
    return contentHeading;
  }
  const displayTitle = block.display_title?.trim();
  if (displayTitle) {
    return displayTitle;
  }
  const legacyTitle = block.title?.trim();
  return legacyTitle || null;
}

export function getNavigationLabel(block: DisplayTitleBlock): string {
  return getDisplayTitle(block) ?? getFallbackLabel(block);
}
