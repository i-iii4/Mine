import type { IndexedBlock, LightBlock } from "@/types";

type AnyBlock = LightBlock | IndexedBlock;

export function getFallbackLabel(block: AnyBlock): string {
  return block.fallback_label?.trim() || block.slug;
}

export function getDisplayTitle(block: AnyBlock): string | null {
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

export function getNavigationLabel(block: AnyBlock): string {
  return getDisplayTitle(block) ?? getFallbackLabel(block);
}
