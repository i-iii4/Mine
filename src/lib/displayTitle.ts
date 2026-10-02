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

/**
 * A media card's title: only a real heading, the first `# …` in its note's
 * body (SPEC_DISPLAY_TITLE.md). A legacy `frontmatter.title` (the clipper
 * once wrote the page's title onto image clips) and the file's name are not
 * shown: the open card does not show them over its content either (user's
 * decision of 02.10.2026). Both stay the card's accessible name.
 */
export function getMediaOwnTitle(block: Pick<LightBlock, "content_heading">): string | null {
  return block.content_heading?.trim() || null;
}

