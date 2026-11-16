import type { LightBlock } from "@/types";
import {
  normalizeFeedPreviewManifest,
  type NormalizedFeedPreviewManifest,
  type NormalizedFeedPreviewTile,
} from "@/lib/feedPreview";
import { getDisplayTitle, getMediaOwnTitle } from "@/lib/displayTitle";
import type { FeedShow } from "@/lib/feedDisplay";
import { clampCardAspect } from "@/lib/cardAspect";
import { parseYoutubeSource } from "@/lib/youtubeSource";

// One card (SPEC_CARD_UNIFIED.md). What a card shows is decided by its content
// alone: its media and its text (Е3). The kind of record the content comes
// from decides only how each part is read from the record's data (a picture's
// title is only a real heading, an X post has none); the card's look never
// reads it (Е1).

/// The kind of record a card's content is read from (Е3). The feed card does
/// not look at it; the open card (Detail) does, to play a video or show a
/// link's page.
export type CardSourceKind = "image" | "video" | "file" | "link" | "article" | "social" | "channel";

export interface CardLayoutMediaItem {
  sourcePath: string;
  previewPath: string | null;
  aspectRatio: number | null;
  isVideo: boolean;
  isVideoPoster: boolean;
}

/// What a media slot paints: one picture from the card's whole preview (a
/// picture, a link's page picture), one picture from its own tile (a post's
/// picture), one video (playing or its poster), or several media as a gallery
/// (Д21). The shape the slot is laid out at always comes from the artifact it
/// paints (SPEC_CARD_MEDIA_GEOMETRY.md).
export type CardMediaPaint =
  | { kind: "preview" }
  | { kind: "tile"; item: CardLayoutMediaItem | null }
  | { kind: "video" }
  | { kind: "gallery" };

/// A card's media (Е3).
export interface CardLayoutMedia {
  items: CardLayoutMediaItem[];
  /// The painted artifact's shape clamped from 1:2 to 2:1, the gallery's
  /// shape, or null while the artifact is not measured: the slot then takes
  /// the provisional envelope (`provisionalMediaAspect`).
  aspectRatio: number | null;
  /// The shape the card's row declares for its own picture or video
  /// (`width`, `height`), the envelope's shape while `aspectRatio` is null;
  /// null for media the row's size does not describe.
  declaredAspectRatio: number | null;
  visibleCount: number;
  totalCount: number;
  paint: CardMediaPaint;
}

/// A card's text (Е3); an empty string where the part is absent.
export interface CardLayoutText {
  title: string;
  text: string;
  author: string;
}

/// A card's content, read from its record (Е3).
export interface CardContent {
  source: CardSourceKind;
  media: CardLayoutMedia | null;
  text: CardLayoutText;
}

/// How the feed shows a card (Е2, Е11): one layout for every card, media on
/// top when shown and the text part under it.
export interface CardLayoutDescriptor {
  /// With content, or without (Е8): an empty card is the frame alone.
  mode: "content" | "empty";
  /// The media the card shows, or null.
  media: CardLayoutMedia | null;
  /// The card's text, whether the text part or the lift caption shows it.
  text: CardLayoutText;
  /// `always`: in the text part under the media (`cards`, and every card
  /// without media). `on-lift`: only as the caption a lift brings up (`media`
  /// with media, Е12). `never`: nowhere (`media-only` with media,
  /// SPEC_FEED_DISPLAY.md, Д31).
  textShown: CardTextShown;
  /// The text part stands under the shown media (Д20): the media then closes
  /// with its outline, the frame's ring mirrored under it.
  textUnderMedia: boolean;
  /// The card rises on hover and under keyboard focus, bringing up its row of
  /// collections (SPEC_CARD_STATES.md, С8). In `media-only` no card does:
  /// hover brings up its top buttons alone (SPEC_FEED_DISPLAY.md, Д31).
  lifts: boolean;
}

/// Where a card shows its text (`CardLayoutDescriptor.textShown`).
export type CardTextShown = "always" | "on-lift" | "never";

export type CardLayoutBlock = Omit<LightBlock, "search_match" | "collections"> & {
  search_match?: LightBlock["search_match"];
};

export function getRuntimeCardKind(block: CardLayoutBlock): LightBlock["card_kind"] {
  const maybeKind = (block as Partial<LightBlock>).card_kind;
  if (
    maybeKind === "article"
    || maybeKind === "media"
    || maybeKind === "link"
    || maybeKind === "channel"
  ) {
    return maybeKind;
  }
  if (block.block_type === "channel") {
    return "channel";
  }
  if (block.body.trim()) {
    return "article";
  }
  if (
    block.media_file
    || block.block_type === "image"
    || block.block_type === "video"
    || block.block_type === "file"
  ) {
    return "media";
  }
  return block.url || block.block_type === "link" ? "link" : "article";
}

/// The steps of `stripMarkdown`, in order, each a global replace.
const MARKDOWN_STEPS: readonly (readonly [RegExp, string])[] = [
  [/^#{1,6}\s+/gm, ""],
  [/\*\*(.+?)\*\*/g, "$1"],
  [/\*(.+?)\*/g, "$1"],
  [/`([^`]+)`/g, "$1"],
  // Obsidian wikilink embeds (Phase 18.H.1): strip entirely — they are
  // media references, not prose.
  [/!\[\[[^\]]*\]\]/g, ""],
  [/!\[[^\]]*\]\([^)]*\)/g, ""],
  // Obsidian wikilink text links (no leading `!`): keep the display
  // name if present after `|`, otherwise the target name.
  [/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2"],
  [/\[\[([^\]]+)\]\]/g, "$1"],
  [/\[(.+?)\]\(.*?\)/g, "$1"],
  [/^[-*+]\s+/gm, ""],
  [/^>\s+/gm, ""],
  [/^---+$/gm, ""],
  [/\n{3,}/g, "\n\n"],
];

function stripMarkdown(text: string): string {
  return MARKDOWN_STEPS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text).trim();
}

/// Longest body slice a card previews when the index carries no preview text.
const BODY_PREVIEW_MAX_CHARS = 400;

/// The body without its first heading, the card's title: the same cut the
/// index makes before it builds a preview (`strip_first_markdown_h1` in
/// mine-core), so the text never repeats the title above it.
function stripFirstMarkdownH1(body: string): string {
  const out: string[] = [];
  let inFence = false;
  let stripped = false;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence && !stripped && trimmed.startsWith("# ")) {
      stripped = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n").trimStart();
}

/// Whether a step of `stripMarkdown` found everything it matches in `text`,
/// a start of the text it would see in the whole body, the same as in the
/// whole: whether no attempt of it read up to the end of `text`, where the
/// whole body goes on (`boundedBodyPreview`). `lastEnd` is where its last
/// match in `text` ends. Only the steps whose classes run to a closing
/// character can read that far; the others stop at the end of a line or at
/// the letter the whole body has there.
function stepStaysInside(step: number, text: string, lastEnd: number): boolean {
  switch (step) {
    case 3: {
      // `[^`]+` runs to the next backtick: the last one must be matched.
      return text.lastIndexOf("`") < lastEnd;
    }
    case 4: {
      const open = text.lastIndexOf("![[");
      return open < lastEnd || text.indexOf("]", open + 3) !== -1;
    }
    case 5: {
      for (let open = text.indexOf("![", lastEnd); open !== -1; open = text.indexOf("![", open + 1)) {
        const close = text.indexOf("]", open + 2);
        if (close === -1) return false;
        if (text[close + 1] === "(" && text.indexOf(")", close + 2) === -1) return false;
      }
      return true;
    }
    case 6:
    case 7: {
      const open = text.lastIndexOf("[[");
      return open < lastEnd || text.indexOf("]", open + 2) !== -1;
    }
    default:
      return true;
  }
}

/// `stripMarkdown` of `text`, a start of a longer text cut where
/// `boundedBodyPreview` cuts, before its final trim; null when a step might
/// match past the cut in the whole text.
function stripMarkdownStart(text: string): string | null {
  let current = text;
  for (const [index, [pattern, replacement]] of MARKDOWN_STEPS.entries()) {
    // Where the step's last match in what it is given ends, found as its
    // replace finds them: left to right, each after the one before.
    let lastEnd = 0;
    pattern.lastIndex = 0;
    for (let match = pattern.exec(current); match !== null; match = pattern.exec(current)) {
      lastEnd = match.index + match[0].length;
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
    if (!stepStaysInside(index, current, lastEnd)) return null;
    current = current.replace(pattern, replacement);
  }
  return current;
}

/// How much of the body the preview reads first, and grows by doubling: a
/// few times the preview, so a body of ordinary prose is read once.
const BODY_PREVIEW_FIRST_READ_CHARS = 4 * BODY_PREVIEW_MAX_CHARS;

/// The first line start at or after `from` whose line begins with a letter
/// or a digit; the body's end when there is none. There no step of
/// `stripMarkdown` can match across the cut: a match that reaches it stops
/// at that letter in the whole body as at the end of the cut start, and no
/// match begins with a letter.
function previewCutAfter(body: string, from: number): number {
  for (let newline = body.indexOf("\n", Math.max(0, from - 1)); newline !== -1; newline = body.indexOf("\n", newline + 1)) {
    const cut = newline + 1;
    if (cut < body.length && /[\p{L}\p{N}]/u.test(body[cut]!)) return cut;
  }
  return body.length;
}

/// `stripMarkdown(stripFirstMarkdownH1(body)).slice(0, BODY_PREVIEW_MAX_CHARS).trim()`,
/// the same for every body, worked out from as short a start of the body as
/// gives it (user's decision of 15.11.2026). Cleaning a body of megabytes
/// for 400 signs kept the whole cleaned text alive under the slice. The
/// start ends at a line beginning with a letter (`previewCutAfter`); it is
/// enough once its cleaned text is longer than the preview and no step
/// matched past it (`stripMarkdownStart`); else a start twice as long is
/// read, up to the whole body.
function boundedBodyPreview(body: string): string {
  for (let from = BODY_PREVIEW_FIRST_READ_CHARS; ; from *= 2) {
    const cut = previewCutAfter(body, from);
    if (cut >= body.length) return stripMarkdown(stripFirstMarkdownH1(body)).slice(0, BODY_PREVIEW_MAX_CHARS).trim();
    const head = stripFirstMarkdownH1(body.slice(0, cut));
    // A start that is all space leaves the whole body's trim to read on.
    if (head.length === 0) continue;
    const cleaned = stripMarkdownStart(head);
    if (cleaned === null) continue;
    const text = cleaned.trim();
    if (text.length >= BODY_PREVIEW_MAX_CHARS) return text.slice(0, BODY_PREVIEW_MAX_CHARS).trim();
  }
}

/// A card's text under its title: the indexed preview, or the body's own words
/// after its title when the index has none. One rule for every record whose
/// body is its text.
function contentPreviewText(block: CardLayoutBlock, indexedPreviewText: string): string {
  return indexedPreviewText || boundedBodyPreview(block.body);
}

function isTwitterUrl(url: string): boolean {
  const lc = url.toLowerCase();
  return (lc.includes("twitter.com/") || lc.includes("x.com/")) && lc.includes("/status/");
}

function isInstagramUrl(url: string): boolean {
  const lc = url.toLowerCase();
  return lc.includes("instagram.com/p/") || lc.includes("instagram.com/reel/") || lc.includes("instagram.com/stories/");
}

function isSocialUrl(url: string | null): boolean {
  if (!url) return false;
  return isTwitterUrl(url) || isInstagramUrl(url);
}

function isVideoFile(src: string): boolean {
  return /\.mp4(\?|$)|\.webm(\?|$)|\.m4v(\?|$)|\.mov(\?|$)/i.test(src);
}

function isLocalImageFile(src: string): boolean {
  return !/^https?:\/\//i.test(src) && /\.(jpg|jpeg|png|gif|webp|bmp|tiff|tif|heic|heif|avif)(\?|$)/i.test(src);
}

/// What is read from a card's row, kept by the row (SPEC_GRID.md, «Кэш при
/// карточке и продолжение раскладки»). A row is a value: a card that changes
/// arrives as a new object (`reconcileBlocks`) and no row is written to after
/// it is made, so what was read from an object stays true of it for as long as
/// it lives. What is kept is shared by every reader and is not written to
/// either.
interface CardRowMemo {
  /// The parsed preview manifest; undefined until it is read.
  manifest?: NormalizedFeedPreviewManifest | null;
  content?: CardContent;
  descriptors?: Partial<Record<FeedShow, CardLayoutDescriptor>>;
}

const rowMemos = new WeakMap<object, CardRowMemo>();

function rowMemo(row: object): CardRowMemo {
  let memo = rowMemos.get(row);
  if (memo === undefined) {
    memo = {};
    rowMemos.set(row, memo);
  }
  return memo;
}

/// The row's preview manifest, parsed once for the row object.
export function parsePreviewManifest(
  block: Pick<CardLayoutBlock, "preview_manifest">,
): NormalizedFeedPreviewManifest | null {
  const memo = rowMemo(block);
  if (memo.manifest === undefined) {
    memo.manifest = normalizeFeedPreviewManifest(block.preview_manifest);
  }
  return memo.manifest;
}

function aspectRatioFromDimensions(width: number | null | undefined, height: number | null | undefined): number | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  return width / height;
}

function mediaItemsFromManifestTiles(
  tiles: NormalizedFeedPreviewTile[],
): CardLayoutMediaItem[] {
  return tiles.map((tile) => ({
    sourcePath: tile.sourcePath,
    previewPath: tile.previewPath,
    // The artifact the card paints, never the source file. A preview may be
    // downscaled or clamped to a different shape than its original, and laying
    // out from the original then crops what is actually drawn. Null stays null:
    // an unmeasured tile is a state, not a shape.
    // See SPEC_CARD_MEDIA_GEOMETRY.md.
    aspectRatio: aspectRatioFromDimensions(tile.previewWidth, tile.previewHeight),
    isVideo: tile.isVideo,
    isVideoPoster: tile.isVideoPoster,
  }));
}

function galleryAspectRatio(itemCount: number): number {
  return itemCount === 2 ? 2 : 1;
}

function isEmbeddableVideoUrl(url: string | null): boolean {
  return parseYoutubeSource(url) !== null;
}

/// Ratio an image card renders its graphic at.
///
/// One source: the geometry of the artifact the feed actually paints, written
/// by the generator that produced it. No fallback chain — a card whose artifact
/// geometry is unknown is in a state of its own (see
/// `previewGeometryState`), not a card with an invented square.
/// Contract: `SPEC_CARD_MEDIA_GEOMETRY.md`.
function imageSurfaceAspectRatio(
  previewManifest: ReturnType<typeof parsePreviewManifest>,
): number | null {
  return aspectRatioFromDimensions(
    previewManifest?.previewWidth,
    previewManifest?.previewHeight,
  );
}

/// Shape a card's single painted artifact gives it: the preview's own geometry
/// (the whole preview, else its one tile), clamped into the card range, or null
/// while that artifact is not measured. Source dimensions are never read.
/// Shared by videos, a post's or an article's one video, and a link's page
/// picture. Contract: `SPEC_CARD_MEDIA_GEOMETRY.md`.
function singleArtifactAspectRatio(
  previewManifest: ReturnType<typeof parsePreviewManifest>,
  mediaItems: readonly CardLayoutMediaItem[],
): number | null {
  const artifactAspect = imageSurfaceAspectRatio(previewManifest) ?? mediaItems[0]?.aspectRatio ?? null;
  return artifactAspect === null ? null : clampCardAspect(artifactAspect);
}

/// Shape of the one media a post or an article paints, read from the image it
/// paints and clamped into the card range; null while that image is not
/// measured (SPEC_CARD_MEDIA_GEOMETRY.md; SPEC_AUDIT_FIXES.md, Д1.2, Д1.6).
/// A picture paints its own tile (`GalleryTileImage`), never the card's whole
/// preview: that one is built from `file`, then `thumbnail`, then the body, so
/// a page picture or a video poster kept in `thumbnail` has its own shape. A
/// video paints its poster, the whole preview first
/// (`buildFeedVideoPosterCandidates`), so it keeps that preview's shape.
function singleMediaAspectRatio(
  previewManifest: ReturnType<typeof parsePreviewManifest>,
  item: CardLayoutMediaItem,
): number | null {
  if (item.isVideo) return singleArtifactAspectRatio(previewManifest, [item]);
  return item.aspectRatio === null ? null : clampCardAspect(item.aspectRatio);
}


function hasVideoMediaSignal(
  block: CardLayoutBlock,
  previewManifest: ReturnType<typeof parsePreviewManifest>,
  mediaItems: CardLayoutMediaItem[],
): boolean {
  return (
    isEmbeddableVideoUrl(block.url) ||
    (block.media_file ? isVideoFile(block.media_file) : false) ||
    previewManifest?.kind === "video_poster" ||
    mediaItems.some((item) => item.isVideo || item.isVideoPoster)
  );
}

function hasImageMediaSignal(
  block: CardLayoutBlock,
  previewManifest: ReturnType<typeof parsePreviewManifest>,
): boolean {
  return (
    (block.media_file ? isLocalImageFile(block.media_file) : false) ||
    ((previewManifest?.kind === "image" || previewManifest?.kind === "composite") && !block.url) ||
    (block.width != null && block.height != null && block.width > 0 && block.height > 0 && !block.url) ||
    (!!previewManifest?.primaryPreviewPath && !block.url) ||
    (!!block.thumbnail && !block.url)
  );
}

/// A page picture or any other single picture the card's whole preview
/// holds: its own shape, clamped like every media (Е6), the tiles it was made
/// from as its items.
function previewPictureMedia(
  previewManifest: NonNullable<ReturnType<typeof parsePreviewManifest>>,
): CardLayoutMedia {
  const items = mediaItemsFromManifestTiles(previewManifest.tiles);
  return {
    items,
    aspectRatio: singleArtifactAspectRatio(previewManifest, items),
    declaredAspectRatio: null,
    visibleCount: items.length,
    totalCount: items.length + previewManifest.overflowCount,
    paint: { kind: "preview" },
  };
}

/// A record whose main file is a picture, a video or another file. Its title
/// is only a real heading: a legacy `frontmatter.title` on such a record
/// mirrors the file's name or the page it came from (SPEC_DISPLAY_TITLE.md).
function mediaRecordContent(
  block: CardLayoutBlock,
  previewManifest: ReturnType<typeof parsePreviewManifest>,
  indexedPreviewText: string,
): CardContent {
  const text: CardLayoutText = {
    title: getMediaOwnTitle(block) ?? "",
    text: contentPreviewText(block, indexedPreviewText),
    author: block.author ?? "",
  };
  const items = previewManifest ? mediaItemsFromManifestTiles(previewManifest.tiles) : [];

  if (hasVideoMediaSignal(block, previewManifest, items)) {
    // The poster's shape, clamped like any media; the artifact, or nothing:
    // the source file's size is never read (SPEC_CARD_MEDIA_GEOMETRY.md).
    return {
      source: "video",
      media: {
        items,
        aspectRatio: singleArtifactAspectRatio(previewManifest, items),
        declaredAspectRatio: aspectRatioFromDimensions(block.width, block.height),
        visibleCount: items.length,
        totalCount: items.length,
        paint: { kind: "video" },
      },
      text,
    };
  }

  if (hasImageMediaSignal(block, previewManifest)) {
    const artifactAspect = imageSurfaceAspectRatio(previewManifest);
    return {
      source: "image",
      media: {
        items,
        // Null means the artifact has not been produced yet, and stays null:
        // the provisional envelope is the consumer's, not invented here.
        aspectRatio: artifactAspect === null ? null : clampCardAspect(artifactAspect),
        declaredAspectRatio: aspectRatioFromDimensions(block.width, block.height),
        visibleCount: items.length,
        totalCount: items.length,
        paint: { kind: "preview" },
      },
      text,
    };
  }

  if (block.media_file) {
    // A file the preview generator made no picture of.
    return { source: "file", media: null, text };
  }

  if (block.url) {
    return {
      source: "link",
      media: previewManifest?.primaryPreviewPath && previewManifest.kind !== "text"
        ? previewPictureMedia(previewManifest)
        : null,
      text: { ...text, title: getDisplayTitle(block) ?? "" },
    };
  }

  return { source: "file", media: null, text };
}

/// A saved page: its page picture, its title and its description.
function linkContent(
  block: CardLayoutBlock,
  previewManifest: ReturnType<typeof parsePreviewManifest>,
  indexedPreviewText: string,
): CardContent {
  const hasPagePicture = previewManifest !== null
    && previewManifest.kind !== "text"
    && previewManifest.primaryPreviewPath !== null;
  return {
    source: "link",
    media: hasPagePicture ? previewPictureMedia(previewManifest) : null,
    text: {
      title: getDisplayTitle(block) ?? "",
      text: indexedPreviewText,
      author: block.author ?? "",
    },
  };
}

/// An X or Instagram post: no title of its own (a legacy title there is
/// synthetic), its text, its author and its pictures or videos.
function socialContent(
  block: CardLayoutBlock,
  previewManifest: ReturnType<typeof parsePreviewManifest>,
  indexedPreviewText: string,
): CardContent {
  const text: CardLayoutText = {
    title: "",
    text: indexedPreviewText || stripMarkdown((block.body.split(/^---+$/m)[0] ?? block.body).trim()),
    author: block.author ?? "",
  };
  const items = previewManifest ? mediaItemsFromManifestTiles(previewManifest.tiles) : [];
  if (items.length === 0) {
    return { source: "social", media: null, text };
  }
  if (items.length === 1) {
    const item = items[0]!;
    return {
      source: "social",
      media: {
        items,
        // The shape of the image the card paints, clamped like every single
        // media (Г4.5, Д1.2); null while that image is not measured.
        aspectRatio: singleMediaAspectRatio(previewManifest, item),
        declaredAspectRatio: null,
        visibleCount: 1,
        totalCount: 1,
        paint: item.isVideo ? { kind: "video" } : { kind: "tile", item },
      },
      text,
    };
  }
  const totalCount = items.length + (previewManifest?.overflowCount ?? 0);
  return {
    source: "social",
    media: {
      items,
      aspectRatio: galleryAspectRatio(Math.min(4, totalCount)),
      declaredAspectRatio: null,
      visibleCount: Math.min(4, totalCount),
      totalCount,
      paint: { kind: "gallery" },
    },
    text,
  };
}

/// A post or an article: its title, its text, its author and the media its
/// preview was made from.
function articleContent(
  block: CardLayoutBlock,
  previewManifest: ReturnType<typeof parsePreviewManifest>,
  indexedPreviewText: string,
): CardContent {
  const text: CardLayoutText = {
    title: getDisplayTitle(block) ?? "",
    text: contentPreviewText(block, indexedPreviewText),
    author: block.author ?? "",
  };
  const hasVisualPreview = previewManifest !== null && previewManifest.kind !== "text";
  if (!hasVisualPreview) {
    return { source: "article", media: null, text };
  }
  const items = mediaItemsFromManifestTiles(previewManifest.tiles);
  const totalCount = items.length + previewManifest.overflowCount;
  // Collages keep their own arrangement; a single media is shaped by the image
  // that is painted, and by nothing else (Д1.6). Null when that image has not
  // been measured: the consumer picks a provisional envelope rather than this
  // function inventing one from the source file.
  const single = totalCount === 1 ? items[0] : undefined;
  const aspectRatio = previewManifest.kind === "composite"
    ? galleryAspectRatio(Math.min(4, totalCount))
    : single
      ? singleMediaAspectRatio(previewManifest, single)
      : singleArtifactAspectRatio(previewManifest, items);
  const paint: CardMediaPaint = totalCount > 1
    ? { kind: "gallery" }
    : items.length === 1 && items[0]!.isVideo
      ? { kind: "video" }
      : { kind: "tile", item: items[0] ?? null };
  return {
    source: "article",
    media: { items, aspectRatio, declaredAspectRatio: null, visibleCount: items.length, totalCount, paint },
    text,
  };
}

/// A card's content, read from its record by that record's own data rules
/// (Е3). The same for every presentation, and read once for the row object.
export function deriveCardContent(block: CardLayoutBlock): CardContent {
  const memo = rowMemo(block);
  memo.content ??= readCardContent(block);
  return memo.content;
}

function readCardContent(block: CardLayoutBlock): CardContent {
  const previewManifest = parsePreviewManifest(block);
  const indexedPreviewText = block.preview_text?.trim() ?? "";
  const cardKind = getRuntimeCardKind(block);
  switch (cardKind) {
    case "media":
      return mediaRecordContent(block, previewManifest, indexedPreviewText);
    case "link":
      return linkContent(block, previewManifest, indexedPreviewText);
    case "channel":
      return {
        source: "channel",
        media: null,
        text: {
          title: getDisplayTitle(block) ?? "",
          text: contentPreviewText(block, indexedPreviewText),
          author: "",
        },
      };
    case "article":
      return isSocialUrl(block.url)
        ? socialContent(block, previewManifest, indexedPreviewText)
        : articleContent(block, previewManifest, indexedPreviewText);
  }
  const _never: never = cardKind;
  return _never;
}

/// Whether a card has any text of its own (Е3).
export function hasCardText(text: CardLayoutText): boolean {
  return Boolean(text.title || text.text || text.author);
}

/// Where a card with media shows its text in each presentation; a card without
/// media shows it in its text part in every one (Е11).
function textShownWithMedia(show: FeedShow): CardTextShown {
  switch (show) {
    case "cards":
      return "always";
    case "media":
      return "on-lift";
    case "media-only":
      return "never";
  }
  const _never: never = show;
  return _never;
}

/// The card in the feed's presentation (Е2, Е11). Every card follows the same
/// rules: what it has, it shows. `media` shows a card's media alone and keeps
/// its text for the lift's caption; `media-only` shows the same at rest, keeps
/// the text for nothing and lifts no card (SPEC_FEED_DISPLAY.md, Д31); a card
/// without media shows its text as in `cards`.
export function deriveCardLayoutDescriptor(
  block: CardLayoutBlock,
  show: FeedShow = "cards",
): CardLayoutDescriptor {
  const memo = rowMemo(block);
  const descriptors = (memo.descriptors ??= {});
  return (descriptors[show] ??= describeCardLayout(block, show));
}

function describeCardLayout(block: CardLayoutBlock, show: FeedShow): CardLayoutDescriptor {
  const { media, text } = deriveCardContent(block);
  const textShown = media !== null ? textShownWithMedia(show) : "always";
  const textPartShown = textShown === "always" && hasCardText(text);
  return {
    mode: media !== null || hasCardText(text) ? "content" : "empty",
    media,
    text,
    textShown,
    textUnderMedia: media !== null && textPartShown,
    lifts: show !== "media-only",
  };
}
