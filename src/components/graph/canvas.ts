import { collectionRefLabel } from "@/lib/collections";
import { parsePreviewManifest } from "@/lib/cardLayout";
import {
  graphFullThumbnailUrl,
  graphThumbLevelFor,
  graphThumbnailUrl,
} from "./interaction";
import {
  COLLECTION_FONT_SIZE,
  COLLECTION_HEIGHT,
  COLLECTION_PAD_X,
  GRAPH_PALETTE,
  type GraphCanvasNode,
  type GraphCanvasTheme,
  type PositionedGraphCanvasNode,
} from "./contracts";

export function paintCardNode(
  ctx: CanvasRenderingContext2D,
  node: PositionedGraphCanvasNode,
  options: {
    globalScale: number;
    theme: "light" | "dark";
    canvasTheme: GraphCanvasTheme;
    imageCache: Map<string, HTMLImageElement>;
    thumbsRootPath: string;
    thumbVersion: number;
    renderThumbnail: boolean;
    selected: boolean;
    /// Screen size of the node, from `graphNodeScreenSize`. Passed in rather
    /// than computed here so that painting, the pointer hit area, the card menu
    /// and the hover preview cannot disagree about where a node ends.
    screenSize: number;
    /// Where that size is heading. Only the thumbnail level reads it.
    targetScreenSize: number;
  },
) {
  const palette = GRAPH_PALETTE[options.theme];
  const size = options.screenSize / options.globalScale;
  const x = node.x - size / 2;
  const y = node.y - size / 2;

  // Levels in order of preference for this size, then whatever else is
  // already decoded. Falling back down a level is free; falling back to the
  // full thumbnail is the last resort, and it exists because a card whose
  // levels are missing entirely used to draw as a dark square.
  // Chosen from where the size is heading, not from where it is: an animated
  // size crosses the level threshold on its way, and picking by the current
  // value would swap the picture back and forth during the transition.
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
  let image: HTMLImageElement | null = null;
  for (const candidate of candidates) {
    const found = options.imageCache.get(candidate);
    if (found) {
      image = found;
      break;
    }
  }

  ctx.beginPath();
  ctx.rect(x, y, size, size);
  if (image) {
    ctx.save();
    ctx.clip();
    if (isTextPreview(node) && options.theme === "dark") {
      ctx.filter = "invert(1)";
    }
    drawImageCover(ctx, image, x, y, size, size);
    ctx.restore();
    ctx.filter = "none";
  } else {
    ctx.fillStyle = palette.cardFill;
    ctx.fillRect(x, y, size, size);
  }

  if (options.selected) {
    ctx.lineWidth = 2 / options.globalScale;
    ctx.strokeStyle = options.canvasTheme.hoverOutline;
    ctx.strokeRect(x, y, size, size);
  }
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
  ctx.fillStyle = options.theme.chromeFill;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = options.highlighted ? options.theme.hoverOutline : options.theme.border;
  ctx.stroke();

  ctx.font = `400 ${COLLECTION_FONT_SIZE}px system-ui, -apple-system, BlinkMacSystemFont, sans-serif`;
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

  context.font = `400 ${COLLECTION_FONT_SIZE}px system-ui, -apple-system, BlinkMacSystemFont, sans-serif`;
  return Math.ceil(context.measureText(label).width + COLLECTION_PAD_X * 2 + 2);
}

measureCollectionLabelWidth.canvas = null as HTMLCanvasElement | null;

function collectionLabel(node: GraphCanvasNode): string {
  return collectionRefLabel(node.collection_ref ?? node.label);
}

function isTextPreview(node: GraphCanvasNode): boolean {
  const manifest = parsePreviewManifest({ preview_manifest: node.preview_manifest });
  return manifest ? manifest.kind === "text" : false;
}

function drawImageCover(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const imageWidth = image.naturalWidth || image.width;
  const imageHeight = image.naturalHeight || image.height;
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
  probe.style.color = "var(--muted-foreground)";
  document.body.appendChild(probe);

  const mutedStyle = getComputedStyle(probe);
  const chromeFill = resolvedCanvasColor(mutedStyle.backgroundColor, fallback.chromeFill);
  const border = resolvedCanvasColor(mutedStyle.borderTopColor, fallback.border);
  const mutedText = resolvedCanvasColor(mutedStyle.color, fallback.mutedText);
  const hoverOutline = resolvedCanvasColor(mutedStyle.outlineColor, fallback.hoverOutline);

  probe.style.color = "var(--foreground)";
  const foregroundText = resolvedCanvasColor(
    getComputedStyle(probe).color,
    fallback.foregroundText,
  );
  probe.remove();

  return {
    ...GRAPH_PALETTE[mode],
    chromeFill,
    border,
    mutedText,
    foregroundText,
    hoverOutline,
  };
}

function graphCanvasThemeFallback(mode: "light" | "dark"): GraphCanvasTheme {
  return mode === "dark"
    ? {
        ...GRAPH_PALETTE.dark,
        chromeFill: "#1a1a1a",
        border: "#2a2a2a",
        mutedText: "#9a9a9a",
        foregroundText: "#fafafa",
        hoverOutline: "#343434",
      }
    : {
        ...GRAPH_PALETTE.light,
        chromeFill: "#fcfcfc",
        border: "#eeeeee",
        mutedText: "#777777",
        foregroundText: "#0a0a0a",
        hoverOutline: "#e7e7e7",
      };
}

function resolvedCanvasColor(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "rgba(0, 0, 0, 0)" || trimmed === "transparent") {
    return fallback;
  }
  return trimmed;
}
