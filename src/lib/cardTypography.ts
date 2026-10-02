export const CONTENT_CARD_PREVIEW_LINE_HEIGHT_PX = 20;

/**
 * Card title typography, shared by every surface that shows a card's title:
 * feed cards, read-only hover and search previews, and search result rows.
 * The title has the size and weight of the card text and differs from it by
 * color alone (DESIGN_SYSTEM.md, «Цвет текста»: hierarchy through brightness,
 * not through size). Callers add only layout utilities (`truncate`,
 * `line-clamp-*`); a weight utility here would break the font-metrics contract
 * below.
 */
export const CONTENT_CARD_TITLE_CLASSES = "text-sm text-foreground";

/**
 * Weight the font-metrics pipeline measures card titles with. It is the
 * weight the render paints: `CONTENT_CARD_TITLE_CLASSES` sets none, so a title
 * inherits the regular body weight, and word wrap computed from these widths
 * matches the rendered lines.
 */
export const CONTENT_CARD_TITLE_FONT_WEIGHT = 400;

/** Card text size: `text-sm` in the theme. */
export const CONTENT_CARD_FONT_SIZE_PX = 12;

/** Line box of a card's single-line text: titles, authors, domains. */
export const CONTENT_CARD_SINGLE_LINE_HEIGHT_PX = 16;

/** The kinds of line a post card's text stack holds, top to bottom. */
export type CardTextLine = "title" | "preview" | "author";

const LINE_HEIGHT_PX: Record<CardTextLine, number> = {
  title: CONTENT_CARD_SINGLE_LINE_HEIGHT_PX,
  preview: CONTENT_CARD_PREVIEW_LINE_HEIGHT_PX,
  author: CONTENT_CARD_SINGLE_LINE_HEIGHT_PX,
};

/**
 * The air a line box adds above and below its letters: half of what its line
 * height exceeds the type size. A gap the eye reads runs from letter to
 * letter, so it is the box gap plus the half-leading on both sides.
 */
export function halfLeading(line: CardTextLine): number {
  return (LINE_HEIGHT_PX[line] - CONTENT_CARD_FONT_SIZE_PX) / 2;
}

/**
 * Edge to edge, the vertical gaps of a post card's text read as 12px from
 * letter to letter: from the media to the first line, between the title, the
 * text and the author, and from the last line to the frame's bottom edge
 * (SPEC_FEED_DISPLAY.md, Д25). Lines inside a paragraph sit 8px apart, so the
 * larger gap keeps the groups apart. The boxes are spaced by the gap less the
 * half-leading of the lines that meet there. Inset keeps its box gaps.
 */
export const EDGE_VISUAL_GAP_PX = 12;

/** Where a post card's text sits: edge to edge under the media, or inset. */
export type CardTextPlacement = "inset" | "edge";

/** Box gap between two adjacent lines of a post card's text stack. */
export function cardTextGap(placement: CardTextPlacement, above: CardTextLine, below: CardTextLine): number {
  if (placement === "edge") {
    return EDGE_VISUAL_GAP_PX - halfLeading(above) - halfLeading(below);
  }
  // Inset: the title's text follows at 6px (mt-1.5), the author at 8px (mt-2).
  return below === "preview" ? 6 : 8;
}

/** Edge to edge: box space from the media to the stack's first line. */
export function edgeTextTop(first: CardTextLine): number {
  return EDGE_VISUAL_GAP_PX - halfLeading(first);
}

/** Edge to edge: box space from the stack's last line to the frame's edge. */
export function edgeTextBottom(last: CardTextLine): number {
  return EDGE_VISUAL_GAP_PX - halfLeading(last);
}

/** Edge to edge: the text's inset at the frame's sides, tighter than the
 *  vertical gaps because the media above runs to the edges. */
export const EDGE_TEXT_SIDE_PX = 8;

/** Height of a text stack: its lines and the gaps between them. */
export function cardTextStackHeight(
  placement: CardTextPlacement,
  lines: ReadonlyArray<{ line: CardTextLine; height: number }>,
): number {
  let height = 0;
  lines.forEach(({ line, height: lineBox }, index) => {
    height += lineBox;
    const previous = lines[index - 1];
    if (previous) height += cardTextGap(placement, previous.line, line);
  });
  return height;
}
