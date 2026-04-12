// Deterministic card height computation.
//
// This module contains the single source of truth for how tall a card
// will render at a given column width. It is a pure function of the block
// data and pre-computed font metrics — no DOM access, no measurement.
//
// Every branch must agree with what Card.tsx actually renders. If the
// visual template changes (padding, line-height, font-size, aspect ratio),
// the constants below must change to match, otherwise computed heights
// will drift from rendered heights.
//
// See SPEC_GRID.md for the architectural rationale.

import type { LightBlock } from "@/types";
import type { WordWidths } from "@/types/fontMetrics";
import { countLines } from "./wordWrap";

// ─── Layout constants (must match Card.tsx) ─────────────────────────────────
//
// All values are derived from the project theme in src/styles/global.css:
//   --text-sm: 12px
//   --text-sm--line-height: 16px
//
// Tailwind spacing scale: 1 unit = 4px. p-4 = 16px, mt-1.5 = 6px, mt-2 = 8px,
// mt-3 = 12px. leading-relaxed = line-height: 1.625 (relative).

/** Fallback height when a block has no useful size signal. */
export const DEFAULT_CARD_HEIGHT = 240;

/**
 * Card root wrapper border: `border` class = 1px all sides. In border-box
 * sizing (Tailwind default) this adds 2px to the outer height. The border
 * consumes space on both the top and bottom edges of the card, so every
 * type's final height includes this adjustment.
 */
const CARD_BORDER_HEIGHT = 2;

/**
 * Width inside the border. Card body (article padding, image element, etc.)
 * renders in this width, so any height derived from aspect ratio must use
 * this and not the raw columnWidth.
 */
function innerWidth(columnWidth: number): number {
  return Math.max(1, columnWidth - CARD_BORDER_HEIGHT);
}

// ─── Image/video/link card constants ────────────────────────────────────────

/** Minimum enforced height for image cards even on extremely tall ratios. */
const IMAGE_MIN_HEIGHT = 120;

/** Aspect for video/link thumbnail area (16:9). */
const THUMBNAIL_ASPECT = 9 / 16;

/** Height of the text footer below link thumbnails (padding + title + domain). */
const LINK_FOOTER_HEIGHT = 76;

/** Fixed file card height. */
const FILE_CARD_HEIGHT = 88;

// ─── Article card constants (must match Card.tsx ArticleCard template) ─────

/** Horizontal padding on each side of the article card (p-4). */
const ARTICLE_PADDING_X = 16;

/** Vertical padding at top of article card (p-4). */
const ARTICLE_PADDING_TOP = 16;

/** Vertical padding at bottom of article card (p-4). */
const ARTICLE_PADDING_BOTTOM = 16;

/**
 * Line height of the title paragraph. text-sm in our theme has 16px line
 * height — font-semibold doesn't change that.
 */
const ARTICLE_TITLE_LINE_HEIGHT = 16;

/**
 * Line height of the preview text. `leading-relaxed` forces line-height:
 * 1.625 relative. At 12px font-size: ceil(12 * 1.625) = 20px.
 */
const ARTICLE_PREVIEW_LINE_HEIGHT = 20;

/** Height of the author line (text-sm plain, 16px line-height). */
const ARTICLE_AUTHOR_LINE_HEIGHT = 16;

/** Margin between title and preview (mt-1.5 = 6px). */
const ARTICLE_GAP_TITLE_TO_PREVIEW = 6;

/** Margin from previous block to first_image (mt-3 = 12px). */
const ARTICLE_GAP_BEFORE_IMAGE = 12;

/** Margin from previous block to author (mt-2 = 8px). */
const ARTICLE_GAP_BEFORE_AUTHOR = 8;

/** Maximum title lines (clamped via line-clamp-2 in CSS). */
const ARTICLE_TITLE_MAX_LINES = 2;

/** Maximum preview lines when an image is present (line-clamp-3). */
const ARTICLE_PREVIEW_MAX_LINES_WITH_IMAGE = 3;

/** Maximum preview lines without image (line-clamp-8). */
const ARTICLE_PREVIEW_MAX_LINES_NO_IMAGE = 8;

/**
 * Fixed aspect ratio for article first_image. Card.tsx forces aspect-video
 * (16:9) on the image so height is deterministic without metadata.
 */
const ARTICLE_IMAGE_ASPECT = 9 / 16;

// ─── Image-card fallback when no width/height metadata ──────────────────────

function computeImageHeight(block: LightBlock, columnWidth: number): number {
  const iw = innerWidth(columnWidth);
  if (block.width && block.height && block.width > 0) {
    return (
      Math.max(IMAGE_MIN_HEIGHT, Math.round(iw * (block.height / block.width))) +
      CARD_BORDER_HEIGHT
    );
  }
  // No metadata. Conservative fallback — a stable default. A one-time backend
  // task extracts width/height at indexing time and fills the metadata; see
  // SPEC_GRID out-of-scope section.
  return DEFAULT_CARD_HEIGHT;
}

// ─── Article-card computation ───────────────────────────────────────────────

function computeArticleHeight(
  block: LightBlock,
  columnWidth: number,
  wordWidths: WordWidths | null,
): number {
  // Width inside the card border. Article padding is applied inside this.
  const iw = innerWidth(columnWidth);
  const contentWidth = Math.max(1, iw - ARTICLE_PADDING_X * 2);

  if (wordWidths) {
    // Precise path: known word widths, exact line count.
    const titleLines = Math.min(
      ARTICLE_TITLE_MAX_LINES,
      Math.max(1, countLines(wordWidths.title, wordWidths.titleSpace, contentWidth)),
    );
    const previewMax = block.first_image
      ? ARTICLE_PREVIEW_MAX_LINES_WITH_IMAGE
      : ARTICLE_PREVIEW_MAX_LINES_NO_IMAGE;
    const previewLines = Math.min(
      previewMax,
      Math.max(0, countLines(wordWidths.preview, wordWidths.previewSpace, contentWidth)),
    );

    const titleH = titleLines * ARTICLE_TITLE_LINE_HEIGHT;
    const previewH = previewLines * ARTICLE_PREVIEW_LINE_HEIGHT;
    // Image width = card inner width - article padding on both sides.
    // Height = that width × aspect-video ratio (9/16).
    const imageH = block.first_image
      ? Math.round(contentWidth * ARTICLE_IMAGE_ASPECT)
      : 0;
    const authorH = block.author ? ARTICLE_AUTHOR_LINE_HEIGHT : 0;

    // Gap structure mirroring Card.tsx mt-* classes:
    //   title → preview: mt-1.5 (6px), only when preview exists
    //   (previous) → image: mt-3 (12px), only when image exists
    //   (previous) → author: mt-2 (8px), only when author exists
    const gaps =
      (previewLines > 0 ? ARTICLE_GAP_TITLE_TO_PREVIEW : 0) +
      (imageH > 0 ? ARTICLE_GAP_BEFORE_IMAGE : 0) +
      (authorH > 0 ? ARTICLE_GAP_BEFORE_AUTHOR : 0);

    return (
      CARD_BORDER_HEIGHT +
      ARTICLE_PADDING_TOP +
      titleH +
      previewH +
      imageH +
      authorH +
      gaps +
      ARTICLE_PADDING_BOTTOM
    );
  }

  // Fallback path: word widths not yet available (worker still running).
  //
  // Conservative strict lower bound: fallback MUST be ≤ any possible measured
  // height, so that corrections from fallback → measured always GROW totalHeight.
  // A growing totalHeight never causes scroll jumps — scrollTop remains valid,
  // content simply extends below the viewport. Shrinking would cause the browser
  // to clamp scrollTop and produce a visible jump.
  //
  // Minimum possible measured height for an article card:
  //   - titleLines = 1 (clamped minimum in precise path)
  //   - previewLines = 0 (empty preview is valid)
  //   - imageH = 0 (no image is valid)
  //   - authorH = 0 (no author is valid)
  //   - gaps = 0 (only title → no gaps)
  return (
    CARD_BORDER_HEIGHT +
    ARTICLE_PADDING_TOP +
    ARTICLE_TITLE_LINE_HEIGHT +
    ARTICLE_PADDING_BOTTOM
  );
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Compute the exact rendered height of a card at a given column width.
 *
 * Pure function: same inputs always produce the same output. No DOM
 * access, no side effects. Suitable for use in useMemo, in workers,
 * and in unit tests without jsdom.
 *
 * @param block       Block metadata from LightBlock.
 * @param columnWidth Column width in pixels (derived from layout engine).
 * @param wordWidths  Pre-computed word widths for this block, or null if
 *                    not yet computed. When null, uses a conservative
 *                    lower-bound fallback; real height (once word widths
 *                    arrive) is guaranteed to be >= fallback, so later
 *                    corrections only grow totalHeight — never shrink it,
 *                    never cause scroll jumps.
 * @returns Integer pixel height, always positive.
 */
export function computeCardHeight(
  block: LightBlock,
  columnWidth: number,
  wordWidths: WordWidths | null,
): number {
  switch (block.block_type) {
    case "image":
      return computeImageHeight(block, columnWidth);

    case "video":
      return (
        Math.round(innerWidth(columnWidth) * THUMBNAIL_ASPECT) + CARD_BORDER_HEIGHT
      );

    case "link":
      return (
        Math.round(innerWidth(columnWidth) * THUMBNAIL_ASPECT) +
        LINK_FOOTER_HEIGHT +
        CARD_BORDER_HEIGHT
      );

    case "file":
      return FILE_CARD_HEIGHT + CARD_BORDER_HEIGHT;

    case "article":
      return computeArticleHeight(block, columnWidth, wordWidths);

    default:
      return DEFAULT_CARD_HEIGHT;
  }
}
