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
import { deriveCardLayoutDescriptor, deriveContentCardSlots, getRuntimeCardKind, parsePreviewManifest } from "./cardLayout";
import { CONTENT_CARD_PREVIEW_LINE_HEIGHT_PX } from "./cardTypography";
import { parseMediaDimensions } from "./mediaDimensions";

export interface FeedPlaybackSurfaceEnvelope {
  topOffsetPx: number;
  heightPx: number;
}

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
const CARD_BORDER_TOP = 1;

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

/**
 * Minimum interactive card height.
 *
 * Hover actions are absolutely positioned:
 *   top offset 8px + icon button 32px + safe gap 8px +
 *   bottom action button 32px + bottom offset 8px = 88px
 *
 * CardFrame has a 1px border on both vertical edges, so the outer masonry
 * envelope must reserve 90px. This keeps an otherwise empty card from letting
 * the top-right menu and bottom action row overlap on hover.
 */
export const CARD_HOVER_ACTION_MIN_HEIGHT = 90;

/** Social cards use p-4 container. */
const SOCIAL_PADDING_X = 16;
const SOCIAL_PADDING_TOP = 16;
const SOCIAL_PADDING_BOTTOM = 16;
const SOCIAL_PREVIEW_LINE_HEIGHT = CONTENT_CARD_PREVIEW_LINE_HEIGHT_PX;
const SOCIAL_AUTHOR_LINE_HEIGHT = 16;
const SOCIAL_PREVIEW_MAX_LINES = 3;
const SOCIAL_GAP_BEFORE_TEXT_STACK = 12;
const SOCIAL_GAP_BEFORE_AUTHOR = 8;
const SOCIAL_GRID_GAP = 2;

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
const ARTICLE_PREVIEW_LINE_HEIGHT = CONTENT_CARD_PREVIEW_LINE_HEIGHT_PX;

/** Height of the author line (text-sm plain, 16px line-height). */
const ARTICLE_AUTHOR_LINE_HEIGHT = 16;

/** Margin between title and preview (mt-1.5 = 6px). */
const ARTICLE_GAP_TITLE_TO_PREVIEW = 6;

/** Margin between media and the following text stack (mt-3 = 12px). */
const ARTICLE_GAP_BEFORE_TEXT_STACK = 12;

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

function explicitImageAspectRatio(block: LightBlock): number | null {
  const dims = parseMediaDimensions(block);
  if (dims && block.media_file) {
    const entry = dims[block.media_file];
    if (entry) {
      const [width, height] = entry;
      if (width > 0 && height > 0) {
        return width / height;
      }
    }
  }

  const previewManifest = parsePreviewManifest(block);
  if (
    previewManifest?.width &&
    previewManifest.height &&
    previewManifest.width > 0 &&
    previewManifest.height > 0
  ) {
    return previewManifest.width / previewManifest.height;
  }

  if (block.width && block.height && block.width > 0 && block.height > 0) {
    return block.width / block.height;
  }

  return null;
}

function computeImageHeight(block: LightBlock, columnWidth: number): number {
  const iw = innerWidth(columnWidth);
  const aspectRatio = explicitImageAspectRatio(block);
  if (aspectRatio) {
    return (
      Math.max(IMAGE_MIN_HEIGHT, Math.round(iw / aspectRatio)) +
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
  const descriptor = deriveCardLayoutDescriptor(block);
  const slots = deriveContentCardSlots(descriptor);
  // Width inside the card border. Article padding is applied inside this.
  const iw = innerWidth(columnWidth);
  const contentWidth = Math.max(1, iw - ARTICLE_PADDING_X * 2);

  if (wordWidths) {
    // Precise path: known word widths, exact line count.
    const titleLines = descriptor.titleText
      ? Math.min(
          ARTICLE_TITLE_MAX_LINES,
          Math.max(1, countLines(wordWidths.title, wordWidths.titleSpace, contentWidth)),
        )
      : 0;
    const previewMax = descriptor.variant === "article-media"
      ? ARTICLE_PREVIEW_MAX_LINES_WITH_IMAGE
      : ARTICLE_PREVIEW_MAX_LINES_NO_IMAGE;
    const previewLines = descriptor.previewText
      ? Math.min(
          previewMax,
          Math.max(0, countLines(wordWidths.preview, wordWidths.previewSpace, contentWidth)),
        )
      : 0;

    const titleH = titleLines * ARTICLE_TITLE_LINE_HEIGHT;
    const previewH = previewLines * ARTICLE_PREVIEW_LINE_HEIGHT;
    // Image width = card inner width - article padding on both sides.
    // Height = that width × aspect-video ratio (9/16).
    const imageH = descriptor.variant === "article-media"
      ? Math.round(contentWidth / Math.max(descriptor.primaryAspectRatio ?? ARTICLE_IMAGE_ASPECT, 0.01))
      : 0;
    const authorH = descriptor.authorText ? ARTICLE_AUTHOR_LINE_HEIGHT : 0;

    // Gap structure mirroring Card.tsx mt-* classes:
    //   image → title: mt-3 (12px), only when image exists
    //   title → preview: mt-1.5 (6px), only when preview exists
    //   (previous) → author: mt-2 (8px), only when author exists
    const hasTitle = titleH > 0;
    const hasPreview = previewH > 0;
    const hasMedia = imageH > 0;
    const hasBottomMeta = authorH > 0;
    const gaps =
      (hasMedia && (hasTitle || hasPreview || hasBottomMeta) ? ARTICLE_GAP_BEFORE_TEXT_STACK : 0) +
      (hasTitle && hasPreview ? ARTICLE_GAP_TITLE_TO_PREVIEW : 0) +
      ((hasTitle || hasPreview || hasMedia) && hasBottomMeta ? ARTICLE_GAP_BEFORE_AUTHOR : 0);

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

  // Fallback path: reserve enough space for the worst clamped text/image
  // geometry of this template so visible cards never overlap while exact
  // font metrics are still loading.
  const titleLines = descriptor.titleText ? ARTICLE_TITLE_MAX_LINES : 0;
  const previewLines = descriptor.previewText
    ? (descriptor.variant === "article-media"
      ? ARTICLE_PREVIEW_MAX_LINES_WITH_IMAGE
      : ARTICLE_PREVIEW_MAX_LINES_NO_IMAGE)
    : 0;
  const imageH = descriptor.variant === "article-media"
    ? Math.round(contentWidth / Math.max(descriptor.primaryAspectRatio ?? ARTICLE_IMAGE_ASPECT, 0.01))
    : 0;
  const authorH = descriptor.authorText ? ARTICLE_AUTHOR_LINE_HEIGHT : 0;
  const hasTitle = descriptor.titleText.length > 0;
  const hasPreviewText = descriptor.previewText.length > 0 && previewLines > 0;
  const hasMedia = imageH > 0;
  const hasBottomMeta = authorH > 0 && (slots?.hasBottomMeta ?? false);
  const gaps =
    (hasMedia && (hasTitle || hasPreviewText || hasBottomMeta) ? ARTICLE_GAP_BEFORE_TEXT_STACK : 0) +
    (hasTitle && hasPreviewText ? ARTICLE_GAP_TITLE_TO_PREVIEW : 0) +
    ((hasTitle || hasPreviewText || hasMedia) && hasBottomMeta ? ARTICLE_GAP_BEFORE_AUTHOR : 0);

  return (
    CARD_BORDER_HEIGHT +
    ARTICLE_PADDING_TOP +
    titleLines * ARTICLE_TITLE_LINE_HEIGHT +
    previewLines * ARTICLE_PREVIEW_LINE_HEIGHT +
    imageH +
    authorH +
    gaps +
    ARTICLE_PADDING_BOTTOM
  );
}

function computeSocialHeight(
  block: LightBlock,
  columnWidth: number,
  wordWidths: WordWidths | null,
): number {
  const descriptor = deriveCardLayoutDescriptor(block);
  const slots = deriveContentCardSlots(descriptor);
  const iw = innerWidth(columnWidth);
  const contentWidth = Math.max(1, iw - SOCIAL_PADDING_X * 2);

  const previewLines = wordWidths
    ? (descriptor.previewText
        ? Math.min(
            SOCIAL_PREVIEW_MAX_LINES,
            Math.max(0, countLines(wordWidths.preview, wordWidths.previewSpace, contentWidth)),
          )
        : 0)
    : (descriptor.previewText ? SOCIAL_PREVIEW_MAX_LINES : 0);

  const previewH = previewLines * SOCIAL_PREVIEW_LINE_HEIGHT;
  const authorH = descriptor.authorText ? SOCIAL_AUTHOR_LINE_HEIGHT : 0;

  let mediaH = 0;
  if (descriptor.variant === "social-single-media") {
    mediaH = Math.round(contentWidth / Math.max(descriptor.primaryAspectRatio ?? 1, 0.01));
  } else if (descriptor.variant === "social-media-grid") {
    const rows = Math.ceil(descriptor.visibleMediaCount / 2);
    const cell = Math.max(1, Math.round((contentWidth - SOCIAL_GRID_GAP) / 2));
    mediaH = rows * cell + Math.max(0, rows - 1) * SOCIAL_GRID_GAP;
  }

  const hasPreviewText = previewH > 0 && (slots?.hasTopContent ?? false);
  const hasMedia = mediaH > 0;
  const hasBottomMeta = authorH > 0 && (slots?.hasBottomMeta ?? false);
  const gaps =
    (hasMedia && (hasPreviewText || hasBottomMeta) ? SOCIAL_GAP_BEFORE_TEXT_STACK : 0) +
    (hasPreviewText && hasBottomMeta ? SOCIAL_GAP_BEFORE_AUTHOR : 0);

  return (
    CARD_BORDER_HEIGHT +
    SOCIAL_PADDING_TOP +
    previewH +
    mediaH +
    authorH +
    gaps +
    SOCIAL_PADDING_BOTTOM
  );
}

/**
 * Returns the geometry of the autoplay-relevant video surface inside the
 * outer card envelope. Grid uses this to arbitrate single active autoplay
 * by the visible media surface, not by the visible fraction of the whole
 * card (which is wrong for cards with long text stacks under the video).
 */
export function computeFeedPlaybackSurfaceEnvelope(
  block: LightBlock,
  columnWidth: number,
): FeedPlaybackSurfaceEnvelope | null {
  const descriptor = deriveCardLayoutDescriptor(block);
  const iw = innerWidth(columnWidth);
  const cardKind = getRuntimeCardKind(block);

  switch (cardKind) {
    case "media":
      if (descriptor.variant !== "video") {
        return null;
      }
      return {
        topOffsetPx: CARD_BORDER_TOP,
        heightPx: Math.round(iw * THUMBNAIL_ASPECT),
      };

    case "article": {
      const primaryMedia = descriptor.mediaItems[0];
      const contentWidth = Math.max(1, iw - ARTICLE_PADDING_X * 2);

      if (
        descriptor.variant === "article-media" &&
        descriptor.mediaItems.length === 1 &&
        primaryMedia?.isVideo
      ) {
        return {
          topOffsetPx: CARD_BORDER_TOP + ARTICLE_PADDING_TOP,
          heightPx: Math.round(
            contentWidth /
              Math.max(descriptor.primaryAspectRatio ?? ARTICLE_IMAGE_ASPECT, 0.01),
          ),
        };
      }

      if (
        descriptor.variant === "social-single-media" &&
        descriptor.mediaItems.length === 1 &&
        primaryMedia?.isVideo
      ) {
        return {
          topOffsetPx: CARD_BORDER_TOP + SOCIAL_PADDING_TOP,
          heightPx: Math.round(
            contentWidth /
              Math.max(descriptor.primaryAspectRatio ?? 1, 0.01),
          ),
        };
      }

      return null;
    }

    case "link":
      return null;

    case "channel":
      return null;

    default:
      return null;
  }
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
 *                    not yet computed. When null, reserves the worst clamped
 *                    geometry for the template so the card envelope remains
 *                    overlap-safe while exact metrics are still loading.
 * @returns Integer pixel height, always positive.
 */
export function computeCardHeight(
  block: LightBlock,
  columnWidth: number,
  wordWidths: WordWidths | null,
): number {
  const descriptor = deriveCardLayoutDescriptor(block);
  const cardKind = getRuntimeCardKind(block);
  const rawHeight = (() => {
    switch (cardKind) {
      case "media":
        switch (descriptor.variant) {
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
          default:
            return DEFAULT_CARD_HEIGHT;
        }
      case "article":
        if (descriptor.variant.startsWith("social")) {
          return computeSocialHeight(block, columnWidth, wordWidths);
        }
        return computeArticleHeight(block, columnWidth, wordWidths);

      case "link":
        return descriptor.primaryAspectRatio !== null
          ? Math.round(innerWidth(columnWidth) * THUMBNAIL_ASPECT)
            + LINK_FOOTER_HEIGHT
            + CARD_BORDER_HEIGHT
          : CARD_HOVER_ACTION_MIN_HEIGHT;

      case "channel":
        return computeArticleHeight(block, columnWidth, wordWidths);

      default:
        return DEFAULT_CARD_HEIGHT;
    }
  })();

  return Math.max(CARD_HOVER_ACTION_MIN_HEIGHT, rawHeight);
}
