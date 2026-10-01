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
