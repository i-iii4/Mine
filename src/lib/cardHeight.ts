// Deterministic card height computation.
//
// This module contains the single source of truth for how tall a card
// will render at a given column width. It is a pure function of the block
// data and pre-computed font metrics — no DOM access, no measurement.
//
// One formula for every card (SPEC_CARD_UNIFIED.md, Е13): the frame's line
// above and below, the shown media, the text part under it. It must agree
// with what Card.tsx renders; if the template changes (padding, line height,
// font size, aspect ratio), the constants below change with it, otherwise
// computed heights drift from rendered ones.
//
// See SPEC_GRID.md for the architectural rationale.

import type { LightBlock } from "@/types";
import type { WordWidths } from "@/types/fontMetrics";
import { countLines } from "./wordWrap";
import { deriveCardLayoutDescriptor, type CardLayoutDescriptor } from "./cardLayout";
import {
  CONTENT_CARD_PREVIEW_LINE_HEIGHT_PX,
  CONTENT_CARD_SINGLE_LINE_HEIGHT_PX,
  EDGE_TEXT_SIDE_PX,
  cardTextStackHeight,
  edgeTextBottom,
  edgeTextTop,
  type CardTextLine,
} from "./cardTypography";
import { CARD_COLLECTION_PILLS_HEIGHT_PX, shownCollections } from "./cardCollections";
import { PROVISIONAL_MEDIA_ASPECT } from "./cardAspect";
import type { FeedShow } from "./feedDisplay";

export interface FeedPlaybackSurfaceEnvelope {
  topOffsetPx: number;
  heightPx: number;
}

/**
 * The frame's line, 1px on each edge: the card's content box lies 1px in from
 * every edge (DESIGN_SYSTEM.md, «Линия рамки поверх содержимого»).
 */
const CARD_BORDER_HEIGHT = 2;
const CARD_BORDER_TOP = 1;

/**
 * Width inside the frame's line, the width the media and the text part
 * render in: any height derived from a shape uses it, not the column width.
 */
function innerWidth(columnWidth: number): number {
  return Math.max(1, columnWidth - CARD_BORDER_HEIGHT);
}

/**
 * Minimum card height, the only one (SPEC_CARD_UNIFIED.md, Е9).
 *
 * Hover actions are absolutely positioned:
 *   top offset 8px + icon button 32px + safe gap 8px +
 *   bottom action button 32px + bottom offset 8px = 88px
 *
 * With the frame's 1px line on both edges the masonry envelope reserves
 * 90px, so the top-right menu and the bottom row never overlap on hover.
 */
export const CARD_HOVER_ACTION_MIN_HEIGHT = 90;

/** The text part's lines (Д25): the title and the author on 16px lines, the
 *  text on 20px lines. */
const TITLE_LINE_HEIGHT = CONTENT_CARD_SINGLE_LINE_HEIGHT_PX;
const TEXT_LINE_HEIGHT = CONTENT_CARD_PREVIEW_LINE_HEIGHT_PX;
const AUTHOR_LINE_HEIGHT = CONTENT_CARD_SINGLE_LINE_HEIGHT_PX;

/** Title up to two lines (`line-clamp-2`). */
const TITLE_MAX_LINES = 2;
/** Text up to three lines under media (`line-clamp-3`), up to eight without
 *  (`line-clamp-8`), SPEC_CARD_UNIFIED.md, Е5. */
const TEXT_MAX_LINES_UNDER_MEDIA = 3;
const TEXT_MAX_LINES_ALONE = 8;

/**
 * Height of a media slot across the frame's inner width at the shape the
 * descriptor gives it: one picture, one video or a whole gallery alike. A
 * shape not measured yet takes the provisional envelope.
 */
function mediaHeight(iw: number, aspectRatio: number | null): number {
  return Math.round(iw / Math.max(aspectRatio ?? PROVISIONAL_MEDIA_ASPECT, 0.01));
}

/** Width the text part's lines wrap at: inside its 8px sides (Д25). */
function textWidth(iw: number): number {
  return Math.max(1, iw - EDGE_TEXT_SIDE_PX * 2);
}

/**
 * The lines the text part paints, top to bottom, with their heights, or none
 * when the presentation keeps the text for the lift's caption. Known word
 * widths give the exact line count; without them the card reserves the worst
 * clamped geometry, so visible cards never overlap while font metrics load.
 */
function textPartLines(
  block: LightBlock,
  descriptor: CardLayoutDescriptor,
  iw: number,
  wordWidths: WordWidths | null,
): Array<{ line: CardTextLine; height: number }> {
  if (descriptor.textShown !== "always") return [];
  const { title, text, author } = descriptor.text;
  const width = textWidth(iw);
  const textMax = descriptor.media ? TEXT_MAX_LINES_UNDER_MEDIA : TEXT_MAX_LINES_ALONE;
  const titleLines = !title
    ? 0
    : wordWidths
      ? Math.min(
          TITLE_MAX_LINES,
          Math.max(1, countLines(wordWidths.title, wordWidths.titleSpace, width, wordWidths.titleNoSpaceBefore)),
        )
      : TITLE_MAX_LINES;
  const textLines = !text
    ? 0
    : wordWidths
      ? Math.min(
          textMax,
          Math.max(0, countLines(wordWidths.preview, wordWidths.previewSpace, width, wordWidths.previewNoSpaceBefore)),
        )
      : textMax;

  const lines: Array<{ line: CardTextLine; height: number }> = [];
  if (titleLines > 0) lines.push({ line: "title", height: titleLines * TITLE_LINE_HEIGHT });
  if (textLines > 0) lines.push({ line: "preview", height: textLines * TEXT_LINE_HEIGHT });
  if (author) lines.push({ line: "author", height: AUTHOR_LINE_HEIGHT });
  if (shownCollections(block).length > 0) lines.push({ line: "pills", height: CARD_COLLECTION_PILLS_HEIGHT_PX });
  return lines;
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
  show: FeedShow = "cards",
): FeedPlaybackSurfaceEnvelope | null {
  const descriptor = deriveCardLayoutDescriptor(block, show);
  const media = descriptor.media;
  if (!media || media.paint.kind !== "video") return null;
  const iw = innerWidth(columnWidth);
  const height = mediaHeight(iw, media.aspectRatio);
  return {
    topOffsetPx: CARD_BORDER_TOP,
    // Media without a text part under it fills the card, which is never
    // shorter than the hover minimum.
    heightPx: descriptor.textUnderMedia
      ? height
      : Math.max(CARD_HOVER_ACTION_MIN_HEIGHT - CARD_BORDER_HEIGHT, height),
  };
}

/**
 * Compute the exact rendered height of a card at a given column width
 * (SPEC_CARD_UNIFIED.md, Е13): the frame's line above and below, the shown
 * media across the inner width, the text part under it with its gaps read
 * from letter to letter (Д25), and never less than the hover minimum. A card
 * without content is the frame at that minimum (Е8).
 *
 * Pure function: same inputs always produce the same output. No DOM
 * access, no side effects. Suitable for use in useMemo, in workers,
 * and in unit tests without jsdom.
 *
 * @param block       Block metadata from LightBlock.
 * @param columnWidth Column width in pixels (derived from layout engine).
 * @param wordWidths  Pre-computed word widths for this block, or null if
 *                    not yet computed. When null, reserves the worst clamped
 *                    geometry so the card envelope remains overlap-safe while
 *                    exact metrics are still loading.
 * @param show        The feed's presentation (SPEC_FEED_DISPLAY.md, Д10).
 * @returns Integer pixel height, always positive.
 */
export function computeCardHeight(
  block: LightBlock,
  columnWidth: number,
  wordWidths: WordWidths | null,
  show: FeedShow = "cards",
): number {
  const descriptor = deriveCardLayoutDescriptor(block, show);
  const iw = innerWidth(columnWidth);
  const media = descriptor.media ? mediaHeight(iw, descriptor.media.aspectRatio) : 0;
  const lines = textPartLines(block, descriptor, iw, wordWidths);
  const first = lines[0];
  const last = lines[lines.length - 1];
  const text = first && last
    ? edgeTextTop(first.line) + cardTextStackHeight(lines) + edgeTextBottom(last.line)
    : 0;
  return Math.max(CARD_HOVER_ACTION_MIN_HEIGHT, CARD_BORDER_HEIGHT + media + text);
}
