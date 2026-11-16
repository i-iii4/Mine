import { useMemo } from "react";
import { Grid } from "@/components/Grid";
import type { LightBlock } from "@/types";

/// The feed of `bun run test:feed-images` (scripts/feed-images-audit.mjs;
/// SPEC_FEED_SCROLL_PERFORMANCE.md, «Проверка картинок при прокрутке»): the
/// real Grid over cards whose every picture has an address of its own, as in
/// a space. The engine keeps a picture by its address, so a feed of six
/// shared pictures (the route of test:feed-scroll) prepares each of them once
/// and can never show a picture that is late.
///
/// The audit's server answers every `/thumbs/c<card>_<shape>.jpg` with the one
/// bright JPEG of that shape (scripts/fixtures/feed-images), so a slot without
/// its picture is told from a slot with one by its brightness in the dark
/// theme.

const AUDIT_BLOCK_COUNT = 800;
const AUDIT_VAULT_PATH = "/tmp/mine-feed-images-audit";
/// Not empty, so the feed works as it does in the app: an empty root turns
/// off whatever the feed does with the previews' folder.
const AUDIT_THUMBS_ROOT = "/thumbs";
const AUDIT_SAVED_AT = "2026-05-24T00:00:00.000Z";

/// The shapes of a 640 px preview: the name of the fixture, its size.
const PREVIEW_SHAPES = [
  ["wide", 640, 360],
  ["land", 640, 480],
  ["square", 640, 640],
  ["port", 480, 640],
  ["tall", 426, 640],
] as const;

const AUDIT_BODIES = [
  "A compact article card with enough text to exercise normal feed wrapping.",
  "A taller research note. It uses repeated prose, different word lengths and predictable text so the route produces real masonry height variation.",
  "Short reference.",
] as const;

/// The address of a source. Nothing serves it: the feed paints previews only.
function forbiddenSource(index: number): string {
  return `/__mine_forbidden_source__/original-${index}.png`;
}

function baseBlock(index: number): LightBlock {
  return {
    id: 100_000 + index,
    slug: `feed-images-audit-${index}`,
    card_kind: "article",
    block_type: "article",
    title: `Card ${index + 1}`,
    content_heading: null,
    display_title: null,
    fallback_label: `Card ${index + 1}`,
    url: `https://example.test/feed-images-audit/${index}`,
    media_file: null,
    thumbnail: null,
    saved_at: AUDIT_SAVED_AT,
    width: null,
    height: null,
    author: null,
    body: "",
    preview_text: null,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
    search_match: null,
    collections: [],
  };
}

function pictureCard(index: number): LightBlock {
  const [shape, width, height] = PREVIEW_SHAPES[index % PREVIEW_SHAPES.length]!;
  return {
    ...baseBlock(index),
    card_kind: "media",
    block_type: "image",
    title: null,
    fallback_label: `Picture ${index + 1}`,
    url: null,
    media_file: forbiddenSource(index),
    width: width * 2,
    height: height * 2,
    preview_manifest: JSON.stringify({
      kind: "media",
      primary_preview_path: `c${index}_${shape}.jpg`,
      width: width * 2,
      height: height * 2,
      preview_width: width,
      preview_height: height,
      tiles: [],
      overflow_count: 0,
    }),
  };
}

function articleWithPicture(index: number): LightBlock {
  const [shape, width, height] = PREVIEW_SHAPES[index % 2]!;
  const previewPath = `c${index}_${shape}.jpg`;
  const source = forbiddenSource(index);
  const body = AUDIT_BODIES[index % AUDIT_BODIES.length]!;
  return {
    ...baseBlock(index),
    body,
    preview_text: body,
    first_image: source,
    media_urls: JSON.stringify([source]),
    media_dimensions: JSON.stringify({ [source]: [width * 2, height * 2] }),
    preview_manifest: JSON.stringify({
      kind: "image",
      primary_preview_path: previewPath,
      width: width * 2,
      height: height * 2,
      preview_width: width,
      preview_height: height,
      tiles: [{
        source_path: source,
        preview_path: previewPath,
        width: width * 2,
        height: height * 2,
        preview_width: width,
        preview_height: height,
        is_video: false,
        is_video_poster: false,
      }],
      overflow_count: 0,
    }),
  };
}

function articleWithTiles(index: number): LightBlock {
  const body = AUDIT_BODIES[index % AUDIT_BODIES.length]!;
  const tiles = Array.from({ length: 4 }, (_, tile) => ({
    source_path: forbiddenSource(index * 10 + tile),
    preview_path: `c${index}_tile.preview-${tile}.jpg`,
    width: 960,
    height: 960,
    preview_width: 320,
    preview_height: 320,
    is_video: false,
    is_video_poster: false,
  }));
  return {
    ...baseBlock(index),
    body,
    preview_text: body,
    first_image: tiles[0]!.source_path,
    media_urls: JSON.stringify(tiles.map((tile) => tile.source_path)),
    media_dimensions: JSON.stringify(
      Object.fromEntries(tiles.map((tile) => [tile.source_path, [960, 960]])),
    ),
    preview_manifest: JSON.stringify({
      kind: "composite",
      primary_preview_path: tiles[0]!.preview_path,
      width: 960,
      height: 960,
      preview_width: 640,
      preview_height: 640,
      tiles,
      overflow_count: 0,
    }),
  };
}

function textCard(index: number): LightBlock {
  const body = Array.from(
    { length: 1 + (index % 4) },
    () => AUDIT_BODIES[index % AUDIT_BODIES.length]!,
  ).join(" ");
  return { ...baseBlock(index), body, preview_text: body };
}

/// Six picture cards, two articles with a picture, one with four tiles and
/// one of text in every ten.
function makeAuditBlock(index: number): LightBlock {
  const kind = index % 10;
  if (kind <= 5) return pictureCard(index);
  if (kind <= 7) return articleWithPicture(index);
  if (kind === 8) return articleWithTiles(index);
  return textCard(index);
}

function noop() {
  return undefined;
}

export function FeedImagesAuditRoute() {
  const blocks = useMemo(
    () => Array.from({ length: AUDIT_BLOCK_COUNT }, (_, index) => makeAuditBlock(index)),
    [],
  );

  return (
    <main
      className="h-screen w-screen overflow-hidden bg-background text-foreground"
      data-feed-images-audit-route=""
      data-feed-images-audit-block-count={blocks.length}
    >
      <Grid
        blocks={blocks}
        vaultPath={AUDIT_VAULT_PATH}
        thumbsRootPath={AUDIT_THUMBS_ROOT}
        tags={[]}
        currentTag={undefined}
        scrollToTop={0}
        keyboardNavigationDisabled
        onBlockClick={noop}
        onToggleTag={noop}
        onCreateAndAssign={noop}
        onLoadBlockTags={async () => new Map()}
        onBatchSetTag={noop}
        onCreateAndAssignBatch={noop}
        onPrepareDeleteSelectedBlocks={async (slugs) => ({ slugs, markdown_files: [], unused_media: [], shared_media: [] })}
        onDeleteSelectedBlocks={async () => undefined}
        onMergeSelectedBlocks={noop}
        onRequestRename={noop}
        onRequestDelete={noop}
      />
    </main>
  );
}
