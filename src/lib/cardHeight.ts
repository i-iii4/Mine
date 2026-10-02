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
import {
  CONTENT_CARD_PREVIEW_LINE_HEIGHT_PX,
  CONTENT_CARD_SINGLE_LINE_HEIGHT_PX,
  EDGE_TEXT_SIDE_PX,
  cardTextStackHeight,
  edgeTextBottom,
  edgeTextTop,
  type CardTextLine,
} from "./cardTypography";
import { domainFromUrl } from "./assets";
import { CARD_COLLECTION_PILLS_HEIGHT_PX, shownCollections } from "./cardCollections";
import { PROVISIONAL_MEDIA_ASPECT, clampCardAspect } from "./cardAspect";
import type { FeedShow } from "./feedDisplay";

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

/** Image-card minimum follows the column while preserving hover controls. */
const IMAGE_MIN_HEIGHT_MAX = 120;
const IMAGE_MIN_HEIGHT_COLUMN_RATIO = 0.4;

/** Aspect for the link thumbnail area (16:9). */
const THUMBNAIL_ASPECT = 9 / 16;

/** A video card's surface: the poster's shape, or the provisional envelope
 *  while the poster is not made yet (SPEC_CARD_MEDIA_GEOMETRY.md). */
function videoSurfaceHeight(width: number, aspectRatio: number | null): number {
  return Math.round(width / Math.max(aspectRatio ?? PROVISIONAL_MEDIA_ASPECT, 0.01));
}

/**
 * Height of the text footer below a link thumbnail, as LinkCard paints it:
 * 12px padding above and below (p-3), the title line, and the domain line 2px
 * under it (mt-0.5) when the link has one.
 */
function linkFooterHeight(block: LightBlock): number {
  const domain = block.url ? domainFromUrl(block.url) : "";
  return 12 + CONTENT_CARD_SINGLE_LINE_HEIGHT_PX + (domain ? 2 + CONTENT_CARD_SINGLE_LINE_HEIGHT_PX : 0)
    + collectionPillsHeight(block, 8) + 12;
}

/** The collection pill row under a card's text and the gap above it, or
 *  nothing for a card in no collection (SPEC_CARD_STATES.md, С9). */
function collectionPillsHeight(block: LightBlock, gapAbove: number): number {
  return shownCollections(block).length > 0 ? gapAbove + CARD_COLLECTION_PILLS_HEIGHT_PX : 0;
}

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

// ─── Post card body constants (must match PostCardBody in Card.tsx) ───────
//
// Posts, articles, collections, X and Instagram posts and pictures `Cards`
// frames as posts share one body: media on top, the text stack under it.

/**
 * The text stack's inset at the frame's sides; above and below it the gaps
 * read as 14px from letter to letter (`edgeTextTop`, `edgeTextBottom` in
 * cardTypography.ts; SPEC_FEED_DISPLAY.md, Д20, Д25).
 */
const POST_TEXT_PADDING = EDGE_TEXT_SIDE_PX;

const SOCIAL_PREVIEW_LINE_HEIGHT = CONTENT_CARD_PREVIEW_LINE_HEIGHT_PX;
const SOCIAL_AUTHOR_LINE_HEIGHT = 16;
const SOCIAL_PREVIEW_MAX_LINES = 3;

// ─── Article card constants (must match Card.tsx ArticleCard template) ─────

/**
 * Line height of the title paragraph: text-sm in our theme has a 16px line
 * height. The title has the preview's size and regular weight and differs
 * from it by color alone; its line box stays 16px.
 */
const ARTICLE_TITLE_LINE_HEIGHT = 16;

/**
 * Line height of the preview text. `leading-relaxed` forces line-height:
 * 1.625 relative. At 12px font-size: ceil(12 * 1.625) = 20px.
 */
const ARTICLE_PREVIEW_LINE_HEIGHT = CONTENT_CARD_PREVIEW_LINE_HEIGHT_PX;

/** Height of the author line (text-sm plain, 16px line-height). */
const ARTICLE_AUTHOR_LINE_HEIGHT = 16;


/** Maximum title lines (clamped via line-clamp-2 in CSS). */
const ARTICLE_TITLE_MAX_LINES = 2;

/** Maximum preview lines when an image is present (line-clamp-3). */
const ARTICLE_PREVIEW_MAX_LINES_WITH_IMAGE = 3;

/** Maximum preview lines without image (line-clamp-8). */
const ARTICLE_PREVIEW_MAX_LINES_NO_IMAGE = 8;

// ─── Image-card fallback when no width/height metadata ──────────────────────

/// Shape an image card is laid out at, or `null` while its artifact does not
/// exist yet.
///
/// Reads exactly one thing: the geometry of the preview the feed paints, written
/// by the generator that produced it. The clamp is applied here too, so the
/// reserved height and the painted ratio are the same number by construction.
/// Contract: `SPEC_CARD_MEDIA_GEOMETRY.md`.
export function explicitImageAspectRatio(block: LightBlock): number | null {
  const previewManifest = parsePreviewManifest(block);
  const artifactAspect =
    previewManifest?.previewWidth &&
    previewManifest.previewHeight &&
    previewManifest.previewWidth > 0 &&
    previewManifest.previewHeight > 0
      ? previewManifest.previewWidth / previewManifest.previewHeight
      : null;
  return artifactAspect === null ? null : clampCardAspect(artifactAspect);
}

function computeImageMinimumHeight(columnWidth: number): number {
  const interactiveFloor = CARD_HOVER_ACTION_MIN_HEIGHT - CARD_BORDER_HEIGHT;
  return Math.min(
    IMAGE_MIN_HEIGHT_MAX,
    Math.max(
      interactiveFloor,
      Math.round(innerWidth(columnWidth) * IMAGE_MIN_HEIGHT_COLUMN_RATIO),
    ),
  );
}

export function imageCardNeedsGeometryRefresh(block: LightBlock): boolean {
  const descriptor = deriveCardLayoutDescriptor(block);
  return (
    getRuntimeCardKind(block) === "media" &&
    descriptor.variant === "image" &&
    explicitImageAspectRatio(block) === null
  );
}


/// A `Media` card's surface fills the card: the media's shape, never shorter
/// than a picture card, the provisional envelope while its preview is not
/// made yet (SPEC_FEED_DISPLAY.md, Д13, Д15).
function mediaOnlySurfaceHeight(columnWidth: number, aspectRatio: number | null): number {
  return Math.max(
    computeImageMinimumHeight(columnWidth),
    Math.round(innerWidth(columnWidth) / Math.max(aspectRatio ?? PROVISIONAL_MEDIA_ASPECT, 0.01)),
  );
}

function computeImageHeight(block: LightBlock, columnWidth: number): number {
  const iw = innerWidth(columnWidth);
  const aspectRatio = explicitImageAspectRatio(block);
  if (aspectRatio) {
    return (
      Math.max(computeImageMinimumHeight(columnWidth), Math.round(iw / aspectRatio)) +
      CARD_BORDER_HEIGHT
    );
  }
  // No metadata. Conservative fallback — a stable default. A one-time backend
  // task extracts width/height at indexing time and fills the metadata; see
  // SPEC_GRID out-of-scope section.
  return DEFAULT_CARD_HEIGHT;
}

// ─── Post card body ─────────────────────────────────────────────────────────

/** Top of a post card's media inside the card's outer box: the frame's top
 *  edge, across its inner width (SPEC_FEED_DISPLAY.md, Д20). */
const POST_MEDIA_TOP = CARD_BORDER_TOP;

/** Height of a post card's media surface at the shape the descriptor gives
 *  it: one picture, one video or a whole gallery alike, across the frame's
 *  inner width. */
function postMediaHeight(iw: number, aspectRatio: number | null): number {
  return Math.round(iw / Math.max(aspectRatio ?? PROVISIONAL_MEDIA_ASPECT, 0.01));
}

/**
 * Width of a post card's text column, the width its lines wrap at: inside the
 * text stack's 8px side padding (SPEC_FEED_DISPLAY.md, Д20). Word widths are
 * per word and serve any width.
 */
function postTextWidth(iw: number): number {
  return Math.max(1, iw - POST_TEXT_PADDING * 2);
}

/**
 * Outer height of a post card's body: media on top, the text stack under it.
 * The media starts at the frame's top edge and spans its inner width; the
 * text stack under it is padded 8px at its sides, and its first and last
 * lines stand 14px from the media and from the bottom edge, letter to letter.
 * Media with no text under it is the whole body; a text post's stack stands
 * 14px from both edges. `textStackH` is the stack's own height, its inner gaps
 * included, wrapped at `postTextWidth`.
 */
function postCardHeight(
  mediaH: number,
  lines: ReadonlyArray<{ line: CardTextLine; height: number }>,
): number {
  const first = lines[0];
  const last = lines[lines.length - 1];
  return (
    CARD_BORDER_HEIGHT +
    mediaH +
    (first && last ? edgeTextTop(first.line) + cardTextStackHeight(lines) + edgeTextBottom(last.line) : 0)
  );
}

// ─── Article-card computation ───────────────────────────────────────────────

function computeArticleHeight(
  block: LightBlock,
  columnWidth: number,
  wordWidths: WordWidths | null,
  show: FeedShow = "mixed",
): number {
  const descriptor = deriveCardLayoutDescriptor(block, show);
  const slots = deriveContentCardSlots(descriptor);
  const iw = innerWidth(columnWidth);
  const hasImage = descriptor.variant === "article-media";
  const imageH = hasImage
    ? postMediaHeight(iw, descriptor.primaryAspectRatio)
    : 0;
  const contentWidth = postTextWidth(iw);
  const previewMax = hasImage
    ? ARTICLE_PREVIEW_MAX_LINES_WITH_IMAGE
    : ARTICLE_PREVIEW_MAX_LINES_NO_IMAGE;

  // Known word widths give the exact line count. Without them the card
  // reserves the worst clamped geometry of its template, so visible cards
  // never overlap while exact font metrics are still loading.
  const titleLines = !descriptor.titleText
    ? 0
    : wordWidths
      ? Math.min(
          ARTICLE_TITLE_MAX_LINES,
          Math.max(1, countLines(wordWidths.title, wordWidths.titleSpace, contentWidth, wordWidths.titleNoSpaceBefore)),
        )
      : ARTICLE_TITLE_MAX_LINES;
  const previewLines = !descriptor.previewText
    ? 0
    : wordWidths
      ? Math.min(
          previewMax,
          Math.max(0, countLines(wordWidths.preview, wordWidths.previewSpace, contentWidth, wordWidths.previewNoSpaceBefore)),
        )
      : previewMax;

  const titleH = titleLines * ARTICLE_TITLE_LINE_HEIGHT;
  const previewH = previewLines * ARTICLE_PREVIEW_LINE_HEIGHT;
  const authorH = descriptor.authorText ? ARTICLE_AUTHOR_LINE_HEIGHT : 0;

  // The lines Card.tsx paints, in order; the gaps between them and around
  // them come from cardTypography.ts, the same numbers the render uses. A
  // line that is absent takes no gap with it.
  const hasBottomMeta = authorH > 0 && (slots?.hasBottomMeta ?? false);
  const lines: Array<{ line: CardTextLine; height: number }> = [];
  if (titleH > 0) lines.push({ line: "title", height: titleH });
  if (previewH > 0) lines.push({ line: "preview", height: previewH });
  if (hasBottomMeta) lines.push({ line: "author", height: authorH });
  if (shownCollections(block).length > 0) lines.push({ line: "pills", height: CARD_COLLECTION_PILLS_HEIGHT_PX });

  return postCardHeight(imageH, lines);
}

function computeSocialHeight(
  block: LightBlock,
  columnWidth: number,
  wordWidths: WordWidths | null,
  show: FeedShow = "mixed",
): number {
  const descriptor = deriveCardLayoutDescriptor(block, show);
  const slots = deriveContentCardSlots(descriptor);
  const iw = innerWidth(columnWidth);

  // One picture or video, or the gallery: either way one surface of the
  // descriptor's shape across the media width, as Card.tsx paints it. The
  // gallery's tiles and their 1px seams are laid out inside that surface and
  // add no height of their own.
  const mediaH = descriptor.variant === "social-single-media" || descriptor.variant === "social-media-grid"
    ? postMediaHeight(iw, descriptor.primaryAspectRatio)
    : 0;
  const contentWidth = postTextWidth(iw);

  const previewLines = wordWidths
    ? (descriptor.previewText
        ? Math.min(
            SOCIAL_PREVIEW_MAX_LINES,
            Math.max(0, countLines(wordWidths.preview, wordWidths.previewSpace, contentWidth, wordWidths.previewNoSpaceBefore)),
          )
        : 0)
    : (descriptor.previewText ? SOCIAL_PREVIEW_MAX_LINES : 0);

  const previewH = previewLines * SOCIAL_PREVIEW_LINE_HEIGHT;
  const authorH = descriptor.authorText ? SOCIAL_AUTHOR_LINE_HEIGHT : 0;

  const hasPreviewText = previewH > 0 && (slots?.hasTopContent ?? false);
  const hasBottomMeta = authorH > 0 && (slots?.hasBottomMeta ?? false);
  const lines: Array<{ line: CardTextLine; height: number }> = [];
  if (hasPreviewText) lines.push({ line: "preview", height: previewH });
  if (hasBottomMeta) lines.push({ line: "author", height: authorH });
  if (shownCollections(block).length > 0) lines.push({ line: "pills", height: CARD_COLLECTION_PILLS_HEIGHT_PX });

  return postCardHeight(mediaH, lines);
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
  show: FeedShow = "mixed",
): FeedPlaybackSurfaceEnvelope | null {
  const descriptor = deriveCardLayoutDescriptor(block, show);
  const iw = innerWidth(columnWidth);
  const primaryMedia = descriptor.mediaItems[0];
  const singleVideo = descriptor.mediaItems.length === 1 && primaryMedia?.isVideo === true;

  switch (descriptor.variant) {
    case "video":
      return {
        topOffsetPx: CARD_BORDER_TOP,
        heightPx: videoSurfaceHeight(iw, descriptor.primaryAspectRatio),
      };

    case "media-only":
      return singleVideo
        ? {
            topOffsetPx: CARD_BORDER_TOP,
            heightPx: mediaOnlySurfaceHeight(columnWidth, descriptor.primaryAspectRatio),
          }
        : null;

    case "article-media":
    case "social-single-media":
      return singleVideo
        ? {
            topOffsetPx: POST_MEDIA_TOP,
            heightPx: postMediaHeight(iw, descriptor.primaryAspectRatio),
          }
        : null;

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
 * @param show        The feed's presentation (SPEC_FEED_DISPLAY.md, Д10).
 * @returns Integer pixel height, always positive.
 */
export function computeCardHeight(
  block: LightBlock,
  columnWidth: number,
  wordWidths: WordWidths | null,
  show: FeedShow = "mixed",
): number {
  const descriptor = deriveCardLayoutDescriptor(block, show);
  const cardKind = getRuntimeCardKind(block);
  const rawHeight = (() => {
    // The presentation decides the card's shape before its kind does
    // (SPEC_FEED_DISPLAY.md, Д15).
    if (descriptor.variant === "media-only") {
      return mediaOnlySurfaceHeight(columnWidth, descriptor.primaryAspectRatio) + CARD_BORDER_HEIGHT;
    }
    switch (cardKind) {
      case "media":
        switch (descriptor.variant) {
          case "article-media":
            // `Cards`: a picture or video laid out as a post card.
            return computeArticleHeight(block, columnWidth, wordWidths, show);
          case "image":
            return computeImageHeight(block, columnWidth);
          case "video":
            return (
              videoSurfaceHeight(innerWidth(columnWidth), descriptor.primaryAspectRatio)
              + CARD_BORDER_HEIGHT
            );
          case "link":
            return (
              Math.round(innerWidth(columnWidth) * THUMBNAIL_ASPECT) +
              linkFooterHeight(block) +
              CARD_BORDER_HEIGHT
            );
          case "file":
            return FILE_CARD_HEIGHT + CARD_BORDER_HEIGHT;
          default:
            return DEFAULT_CARD_HEIGHT;
        }
      case "article":
        if (descriptor.variant.startsWith("social")) {
          return computeSocialHeight(block, columnWidth, wordWidths, show);
        }
        return computeArticleHeight(block, columnWidth, wordWidths, show);

      case "link":
        return descriptor.primaryAspectRatio !== null
          ? Math.round(innerWidth(columnWidth) * THUMBNAIL_ASPECT)
            + linkFooterHeight(block)
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
