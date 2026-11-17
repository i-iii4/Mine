// What the sidebar's preview window shows over a collection's name
// (SPEC_CARD_STATES.md, С7.12; user's decision of 15.11.2026): the window's
// second content, beside the card it shows over a thumbnail. Card-like: the
// preview's frame, 240 px wide; inside, a square grid of the collection's
// first cards, three to a row and three rows at most, tiles as the row's
// strip draws them; under it the collection's whole name and its number of
// elements, as a card's text. No buttons: it only shows.

import type { CSSProperties } from "react";
import { thumbnailUrlAtLevel } from "@/lib/assets";
import { SIDEBAR_PREVIEW_TILE_GAP_PX } from "@/lib/appLayout";
import {
  CONTENT_CARD_SINGLE_LINE_HEIGHT_PX,
  CONTENT_CARD_TITLE_CLASSES,
  EDGE_TEXT_SIDE_PX,
  cardTextGap,
  edgeTextBottom,
  edgeTextTop,
} from "@/lib/cardTypography";
import { cn } from "@/lib/utils";
import type { PreviewCard } from "@/types";
import { PreviewCardFrame } from "./Card";
import {
  microPreviewFromPreviewCard,
  microPreviewImageClass,
  useMicroPreviewPicture,
  type MicroPreviewModel,
  type MicroPreviewPicture,
} from "./MicroPreviewThumbnail";

/** Three tiles to a row, three rows at most (user's decision of 15.11.2026). */
export const COLLECTION_PREVIEW_COLUMNS = 3;
export const COLLECTION_PREVIEW_MAX_ROWS = 3;
export const COLLECTION_PREVIEW_MAX_CARDS = COLLECTION_PREVIEW_COLUMNS * COLLECTION_PREVIEW_MAX_ROWS;

/** A sidebar tile's face before its picture is in: the feed skeleton's fill. */
export const SIDEBAR_PREVIEW_TILE_FILL_CLASS = "bg-accent";

/** A sidebar tile's face: its fill until the picture is in, then a text
 *  thumb's card fill with its ink (MicroPreviewThumbnail.tsx). The strip's
 *  tile and the collection's grid draw it so. */
export function sidebarTileFaceClass(preview: MicroPreviewModel, picture: MicroPreviewPicture): string {
  return preview.text && picture.loaded ? "bg-card" : SIDEBAR_PREVIEW_TILE_FILL_CLASS;
}

/** The first `limit` cards of a row's list that have a thumbnail, in the
 *  list's order. The list holds every card of the collection; only what is
 *  shown is walked. */
export function firstThumbnails(cards: readonly PreviewCard[], limit: number): PreviewCard[] {
  const shown: PreviewCard[] = [];
  for (const card of cards) {
    if (shown.length >= limit) break;
    if (card.hasThumb) shown.push(card);
  }
  return shown;
}

/** A collection as the window shows it. */
export interface CollectionPreviewContent {
  kind: "collection";
  /** The row it stands for: `all` or `tag:<name>`. */
  rowKey: string;
  name: string;
  count: number;
  /** The first cards with a thumbnail, at most nine. */
  cards: PreviewCard[];
  /** Tiles still on the way after them, as the strip's placeholders. */
  placeholders: number;
}

/**
 * What the window shows over a row's name, from what the strip already
 * holds (SPEC_SIDEBAR_STRIP.md, ЛМ1: every card of the collection with a
 * thumbnail, in its order): the first nine, and while the read has not
 * answered for the row or the space's previews are being built, a
 * placeholder for each card of the count not shown yet, as the strip
 * (ЛМ3). `null`: nothing to show, an empty collection; the window does not
 * open.
 */
export function collectionPreviewContent({
  rowKey,
  name,
  count,
  cards,
  previewsPending,
}: {
  rowKey: string;
  name: string;
  count: number;
  cards: readonly PreviewCard[] | undefined;
  previewsPending: boolean;
}): CollectionPreviewContent | null {
  if (count <= 0) return null;
  const shown = cards ? firstThumbnails(cards, COLLECTION_PREVIEW_MAX_CARDS) : [];
  const placeholders = cards === undefined || previewsPending
    ? Math.max(0, Math.min(count, COLLECTION_PREVIEW_MAX_CARDS) - shown.length)
    : 0;
  if (shown.length + placeholders === 0) return null;
  return { kind: "collection", rowKey, name, count, cards: shown, placeholders };
}

/** How many rows the grid takes: the tiles, three to a row. */
export function collectionPreviewRows(content: Pick<CollectionPreviewContent, "cards" | "placeholders">): number {
  return Math.ceil((content.cards.length + content.placeholders) / COLLECTION_PREVIEW_COLUMNS);
}

/** "1 element", "12 elements": «Element» is the product's name for a card
 *  (Open element, Find elements). */
export function collectionCountLabel(count: number): string {
  return `${count} ${count === 1 ? "element" : "elements"}`;
}

/** A card's picture in the grid. The grid's tile is twice the strip's 32 px
 *  and more: `micro` covers 32 logical pixels at double density, `zoom` up
 *  to 100 (SPEC_THUMBNAILS.md, «Уровни миниатюр»), so the tile takes `zoom`,
 *  for nine cards at most (П2). Its address keeps the strip's version marks. */
function gridPreview(card: PreviewCard): MicroPreviewModel {
  const preview = microPreviewFromPreviewCard(card);
  return { ...preview, url: thumbnailUrlAtLevel(preview.url, "zoom") };
}

const TILE_CLASS = "relative aspect-square overflow-hidden";

function CollectionPreviewTile({ card }: { card: PreviewCard }) {
  const preview = gridPreview(card);
  const picture = useMicroPreviewPicture(preview);
  return (
    <div
      className={cn(TILE_CLASS, sidebarTileFaceClass(preview, picture))}
      data-collection-preview-tile="card"
      data-thumb-edge=""
      data-micro-preview-state={picture.state}
    >
      {!picture.missing && (
        <img
          ref={picture.imageRef}
          src={picture.src}
          alt=""
          className={microPreviewImageClass(preview, true)}
          // The window lays its next content out unseen and waits for its
          // pictures (HoverPreviewWindow.tsx): a lazy image there never loads.
          decoding="async"
          draggable={false}
          onLoad={picture.onLoaded}
          onError={picture.onFailed}
        />
      )}
    </div>
  );
}

const GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: `repeat(${COLLECTION_PREVIEW_COLUMNS}, minmax(0, 1fr))`,
  gap: SIDEBAR_PREVIEW_TILE_GAP_PX,
  padding: EDGE_TEXT_SIDE_PX,
  paddingBottom: 0,
};

const SINGLE_LINE_STYLE: CSSProperties = { lineHeight: `${CONTENT_CARD_SINGLE_LINE_HEIGHT_PX}px` };

/**
 * The collection's window content. The grid stands 8 px in from the frame,
 * as a card's text does (`EDGE_TEXT_SIDE_PX`), its tiles the strip's gap
 * apart (`SIDEBAR_PREVIEW_TILE_GAP_PX`); a short last row keeps to the left.
 * The name and the count are a card's title and its next line: the card's
 * type and colours, its gaps from the media above and to the frame's edge
 * (cardTypography.ts). The name is whole, on as many lines as it takes.
 */
export function CollectionHoverPreview({ content, width }: { content: CollectionPreviewContent; width: number }) {
  const placeholders = Array.from({ length: content.placeholders }, (_, index) => index);
  return (
    <PreviewCardFrame width={width} data-collection-preview={content.rowKey}>
      <div style={GRID_STYLE} data-collection-preview-grid="">
        {content.cards.map((card, index) => (
          <CollectionPreviewTile key={card.slug ?? `card-${index}`} card={card} />
        ))}
        {placeholders.map((index) => (
          <div
            key={`placeholder-${index}`}
            className={cn(TILE_CLASS, SIDEBAR_PREVIEW_TILE_FILL_CLASS)}
            data-collection-preview-tile="placeholder"
            data-thumb-edge=""
          />
        ))}
      </div>
      <div
        style={{
          paddingInline: EDGE_TEXT_SIDE_PX,
          paddingTop: edgeTextTop("title"),
          paddingBottom: edgeTextBottom("author"),
        }}
        data-collection-preview-caption=""
      >
        <p className={cn("break-words", CONTENT_CARD_TITLE_CLASSES)} style={SINGLE_LINE_STYLE} data-collection-preview-name="">
          {content.name}
        </p>
        <p
          className="text-sm text-muted-foreground"
          style={{ ...SINGLE_LINE_STYLE, marginTop: cardTextGap("title", "author") }}
          data-collection-preview-count=""
        >
          {collectionCountLabel(content.count)}
        </p>
      </div>
    </PreviewCardFrame>
  );
}
