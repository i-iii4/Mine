import { collectionRefLabel } from "@/lib/collections";
import { SYSTEM_SANS_STACK } from "@/lib/fontChoice";
import { parsePreviewManifest } from "@/lib/cardLayout";
import {
  graphFullThumbnailUrl,
  graphThumbLevelFor,
  graphThumbnailUrl,
} from "./interaction";
import {
  CARD_THUMBNAIL_SIZE,
  COLLECTION_FONT_SIZE,
  COLLECTION_HEIGHT,
  COLLECTION_PAD_X,
  GRAPH_CARD_RADIUS_MAX_PX,
  GRAPH_CARD_RADIUS_RATIO,
  GRAPH_PALETTE,
  type GraphCanvasNode,
  type GraphCanvasTheme,
  type PositionedGraphCanvasNode,
} from "./contracts";

/**
 * The decoded picture a card node draws, if any. Levels in order of
 * preference for this size, then whatever else is already decoded. Falling
 * back down a level is free; falling back to the full thumbnail is the last
 * resort, and it exists because a card whose levels are missing entirely used
 * to draw as a dark square. Chosen from where the size is heading, not from
 * where it is: an animated size crosses the level threshold on its way, and
 * picking by the current value would swap the picture back and forth during
 * the transition. The open card's window reads the same picture to grow out
 * of the node (SPEC_CARD_PEEK.md, О10).
 */
export function cardNodeImage(
  node: GraphCanvasNode,
  options: {
    imageCache: Map<string, HTMLImageElement>;
    thumbsRootPath: string;
    thumbVersion: number;
    renderThumbnail: boolean;
    targetScreenSize: number;
  },
): HTMLImageElement | null {
  const level = graphThumbLevelFor(options.targetScreenSize);
  const candidates = node.slug && options.renderThumbnail
    ? [
      graphThumbnailUrl(options.thumbsRootPath, node.slug, options.thumbVersion, level),
      ...(level === "zoom"
        ? [graphThumbnailUrl(options.thumbsRootPath, node.slug, options.thumbVersion, "micro")]
        : []),
      graphFullThumbnailUrl(options.thumbsRootPath, node.slug, options.thumbVersion),
    ]
    : [];
  for (const candidate of candidates) {
    const found = options.imageCache.get(candidate);
    if (found) return found;
  }
  return null;
}

export function paintCardNode(
  ctx: CanvasRenderingContext2D,
  node: PositionedGraphCanvasNode,
  options: {
    globalScale: number;
    canvasTheme: GraphCanvasTheme;
    imageCache: Map<string, HTMLImageElement>;
    thumbsRootPath: string;
    thumbVersion: number;
    renderThumbnail: boolean;
    selected: boolean;
    hovered: boolean;
    /// Screen size of the node, from `graphNodeScreenSize`. Passed in rather
    /// than computed here so that painting, the pointer hit area, the card menu
    /// and the hover preview cannot disagree about where a node ends.
    screenSize: number;
    /// Where that size is heading. Only the thumbnail level reads it.
    targetScreenSize: number;
    /// 1, or less while a hovered collection dims this card
    /// (`graphElementOpacity`).
    opacity: number;
  },
) {
  const size = options.screenSize / options.globalScale;
  const x = node.x - size / 2;
  const y = node.y - size / 2;

  const image = cardNodeImage(node, options);

  // Corners round as the card grows. At 32 pixels a radius is noise; at the
  // ceiling a square corner reads as sharp against everything else in the
  // interface, which is rounded.
  const radius = cardCornerRadius(options.screenSize) / options.globalScale;
  const textPreview = image !== null && isTextPreview(node);
  roundedRectPath(ctx, x, y, size, size, radius);
  dimFootprint(ctx, options.canvasTheme, options.opacity);
  if (image && !textPreview) {
    ctx.save();
    ctx.clip();
    drawImageCover(ctx, image, x, y, size, size);
    ctx.restore();
  } else {
    // A text thumbnail and a card with no picture stand on the second level
    // of the chrome, `--chrome`, the plane of the page row under the tab bar
    // (user's decision of 09.10.2026). The text is the foreground: the glyphs
    // of the thumbnail take `--foreground` (`tintedTextPreview`).
    ctx.fillStyle = options.canvasTheme.chromeFill;
    ctx.fill();
    if (image) {
      ctx.save();
      ctx.clip();
      drawImageCover(ctx, tintedTextPreview(image, options.canvasTheme.foregroundText), x, y, size, size);
      ctx.restore();
    }
  }

  // The buttons' edge on every card, a picture too (user's decision of
  // 22.10.2026, the sidebar's thumbnails alike; it was the secondary
  // button's 1px frame of 09.10.2026): 0.5px inside the card's outline, a
  // step off the face at rest, off the face with the state layer under the
  // pointer and while selected.
  const highlighted = options.selected || options.hovered;
  const edge = 0.5 / options.globalScale;
  roundedRectPath(ctx, x + edge / 2, y + edge / 2, size - edge, size - edge, Math.max(0, radius - edge / 2));
  ctx.lineWidth = edge;
  ctx.strokeStyle = highlighted ? options.canvasTheme.cardHoverOutline : options.canvasTheme.cardOutline;
  ctx.stroke();
}

/// A dimmed node is the node seen through the canvas veil, not a translucent
/// node: its footprint, the current path, is first covered with the canvas,
/// so the lines that end under a pill or pass under a card do not show
/// through it; then everything the node paints is drawn at `opacity`
/// (SPEC_GRAPH_VIEW.md, «Приглушение при наведении на коллекцию»). The caller
/// restores the context.
function dimFootprint(
  ctx: CanvasRenderingContext2D,
  theme: GraphCanvasTheme,
  opacity: number,
) {
  if (opacity >= 1) return;
  ctx.fillStyle = theme.canvasFill;
  ctx.fill();
  ctx.globalAlpha *= opacity;
}

/// Text thumbnails tinted with the text colour, one canvas per picture and
/// colour. The picture carries the glyphs as its alpha channel (thumbnails.rs
/// draws them on a transparent ground); `source-in` lays the colour over that
/// coverage, so the text is `--foreground` exactly in both themes. The grey
/// baked into the picture and inverted for the dark theme read as a muted
/// step (around 204 and 175 for title and text).
const tintedTextPreviews = new WeakMap<HTMLImageElement, { color: string; canvas: HTMLCanvasElement }>();

function tintedTextPreview(image: HTMLImageElement, color: string): HTMLImageElement | HTMLCanvasElement {
  const cached = tintedTextPreviews.get(image);
  if (cached && cached.color === color) return cached.canvas;
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (typeof document === "undefined" || width <= 0 || height <= 0) return image;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return image;
  context.drawImage(image, 0, 0);
  context.globalCompositeOperation = "source-in";
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  tintedTextPreviews.set(image, { color, canvas });
  return canvas;
}

/// Corner radius for a card drawn at this on-screen size, in screen pixels.
///
/// Measured from the floor size, not from zero: a card at 32 pixels takes a
/// square corner, because a radius there is three physical pixels on a retina
/// screen and reads as a blur rather than as rounding. Growth from that point
/// is proportional and capped at the radius the rest of the interface uses, so
/// the corner arrives gradually instead of appearing at a threshold.
export function cardCornerRadius(screenSize: number): number {
  const grown = Math.max(0, screenSize - CARD_THUMBNAIL_SIZE);
  return Math.min(GRAPH_CARD_RADIUS_MAX_PX, grown * GRAPH_CARD_RADIUS_RATIO);
}

export function paintCollectionNode(
  ctx: CanvasRenderingContext2D,
  node: PositionedGraphCanvasNode,
  options: {
    globalScale: number;
    theme: GraphCanvasTheme;
    // One highlight, not two. Hover, keyboard selection and the opened
    // collection are the same state to the eye — a pill that stands out — and
    // giving the opened one its own heavier outline invented a third look
    // nobody asked for.
    highlighted: boolean;
    /// 1, or less while another collection is hovered
    /// (`graphElementOpacity`).
    opacity: number;
  },
) {
  const label = collectionLabel(node);
  const width = measureCollectionLabelWidth(label);
  const x = -width / 2;
  const y = -COLLECTION_HEIGHT / 2;

  ctx.save();
  ctx.translate(node.x, node.y);
  ctx.scale(1 / options.globalScale, 1 / options.globalScale);
  roundedRectPath(ctx, x, y, width, COLLECTION_HEIGHT, COLLECTION_HEIGHT / 2);
  dimFootprint(ctx, options.theme, options.opacity);
  ctx.fillStyle = options.theme.chromeFill;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = options.highlighted ? options.theme.hoverOutline : options.theme.border;
  ctx.stroke();

  ctx.font = `400 ${COLLECTION_FONT_SIZE}px ${SYSTEM_SANS_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = options.highlighted ? options.theme.foregroundText : options.theme.mutedText;
  ctx.fillText(label, 0, 0, width - COLLECTION_PAD_X * 2);
  ctx.restore();
}

export function collectionPillBox(
  node: PositionedGraphCanvasNode,
  globalScale: number,
) {
  const height = COLLECTION_HEIGHT / globalScale;
  const width = measureCollectionLabelWidth(collectionLabel(node)) / globalScale;
  return {
    x: node.x - width / 2,
    y: node.y - height / 2,
    width,
    height,
    radius: height / 2,
  };
}

export function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function measureCollectionLabelWidth(label: string): number {
  if (typeof document === "undefined") {
    return Math.ceil(label.length * 7.5 + COLLECTION_PAD_X * 2 + 2);
  }

  const canvas = measureCollectionLabelWidth.canvas ?? document.createElement("canvas");
  measureCollectionLabelWidth.canvas = canvas;
  const context = canvas.getContext("2d");
  if (!context) {
    return Math.ceil(label.length * 7.5 + COLLECTION_PAD_X * 2 + 2);
  }

  context.font = `400 ${COLLECTION_FONT_SIZE}px ${SYSTEM_SANS_STACK}`;
  return Math.ceil(context.measureText(label).width + COLLECTION_PAD_X * 2 + 2);
}

measureCollectionLabelWidth.canvas = null as HTMLCanvasElement | null;

function collectionLabel(node: GraphCanvasNode): string {
  return collectionRefLabel(node.collection_ref ?? node.label);
}

/** Whether a card node's picture is a text thumbnail, drawn tinted on the
 *  chrome's plane rather than as a picture. */
export function isTextPreview(node: GraphCanvasNode): boolean {
  const manifest = parsePreviewManifest({ preview_manifest: node.preview_manifest });
  return manifest ? manifest.kind === "text" : false;
}

function drawImageCover(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement | HTMLCanvasElement,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const imageWidth = image instanceof HTMLImageElement ? image.naturalWidth || image.width : image.width;
  const imageHeight = image instanceof HTMLImageElement ? image.naturalHeight || image.height : image.height;
  if (imageWidth <= 0 || imageHeight <= 0) return;

  const scale = Math.max(width / imageWidth, height / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  ctx.drawImage(
    image,
    x + (width - drawWidth) / 2,
    y + (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

export function readGraphTheme(): "light" | "dark" {
  if (typeof document === "undefined" || typeof window === "undefined") return "dark";
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "dark" || explicit === "light") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function readGraphCanvasTheme(mode: "light" | "dark"): GraphCanvasTheme {
  const fallback = graphCanvasThemeFallback(mode);
  if (typeof document === "undefined" || !document.body) return fallback;

  const probe = document.createElement("span");
  probe.className = "bg-chrome";
  probe.style.position = "absolute";
  probe.style.pointerEvents = "none";
  probe.style.width = "0";
  probe.style.height = "0";
  probe.style.overflow = "hidden";
  probe.style.borderColor = "var(--border)";
  probe.style.borderStyle = "solid";
  probe.style.borderWidth = "1px";
  probe.style.outlineColor = "var(--component-fill-hover)";
  probe.style.outlineStyle = "solid";
  probe.style.outlineWidth = "1px";
  // The cards' edge, the buttons' (К10), off the card's face `--chrome`.
  probe.style.textDecorationColor =
    "oklch(from var(--chrome) clamp(0, calc(l + var(--macos-outline-step)), 1) 0 0)";
  probe.style.columnRuleColor =
    "oklch(from color-mix(in srgb, var(--chrome), var(--foreground) var(--active-alpha)) clamp(0, calc(l + var(--macos-outline-step)), 1) 0 0)";
  // The canvas paints labels itself and needs the muted step as an opaque
  // colour: its composite over the chrome surface (global.css, surface-fills).
  probe.style.color = "var(--muted-foreground-opaque)";
  document.body.appendChild(probe);

  const mutedStyle = getComputedStyle(probe);
  const chromeFill = resolvedCanvasColor(mutedStyle.backgroundColor, fallback.chromeFill);
  const border = resolvedCanvasColor(mutedStyle.borderTopColor, fallback.border);
  const mutedText = resolvedCanvasColor(mutedStyle.color, fallback.mutedText);
  const hoverOutline = resolvedCanvasColor(mutedStyle.outlineColor, fallback.hoverOutline);
  const cardOutline = resolvedCanvasColor(mutedStyle.textDecorationColor, fallback.cardOutline);
  const cardHoverOutline = resolvedCanvasColor(mutedStyle.columnRuleColor, fallback.cardHoverOutline);

  probe.style.color = "var(--foreground)";
  const foregroundText = resolvedCanvasColor(
    getComputedStyle(probe).color,
    fallback.foregroundText,
  );
  // Read after the chrome fill above: the inline background replaces the
  // class's for the rest of the probe's life.
  probe.style.backgroundColor = "var(--background)";
  const canvasFill = resolvedCanvasColor(getComputedStyle(probe).backgroundColor, fallback.canvasFill);
  probe.remove();

  return {
    ...GRAPH_PALETTE[mode],
    // The graph's links are the interface's lines (user's decision of
    // 07.10.2026): `--border`, not a colour of their own.
    linkDefault: border,
    chromeFill,
    border,
    mutedText,
    foregroundText,
    hoverOutline,
    cardOutline,
    cardHoverOutline,
    canvasFill,
  };
}

function graphCanvasThemeFallback(mode: "light" | "dark"): GraphCanvasTheme {
  return mode === "dark"
    ? {
        ...GRAPH_PALETTE.dark,
        chromeFill: "#1a1a1a",
        border: "#2a2a2a",
        linkDefault: "#2a2a2a",
        mutedText: "#9a9a9a",
        foregroundText: "#fafafa",
        hoverOutline: "#343434",
        cardOutline: "#2b2b2b",
        cardHoverOutline: "#363636",
        canvasFill: "#090909",
      }
    : {
        ...GRAPH_PALETTE.light,
        chromeFill: "#fcfcfc",
        border: "#eeeeee",
        linkDefault: "#eeeeee",
        mutedText: "#777777",
        foregroundText: "#0a0a0a",
        hoverOutline: "#e7e7e7",
        cardOutline: "#ececec",
        cardHoverOutline: "#e2e2e2",
        canvasFill: "#ffffff",
      };
}

function resolvedCanvasColor(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "rgba(0, 0, 0, 0)" || trimmed === "transparent") {
    return fallback;
  }
  return trimmed;
}
