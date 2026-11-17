import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Grid } from "@/components/Grid";
import { reconcileBlocks } from "@/lib/blockIdentity";
import type { DeleteBlocksPlan, LightBlock, TagCount } from "@/types";

/// The feed of `bun run test:feed-growth` (scripts/feed-growth-audit.mjs;
/// SPEC_FEED_SCROLL_PERFORMANCE.md, «Проверка роста ленты»): the real Grid
/// over a list the audit grows and changes the way the app does, and the time
/// the page works on each change without a break.
///
/// The list changes by the app's own two updates (src/App.tsx): a page that
/// arrives is appended past the cards already held, and a row that arrives
/// changed replaces its card through `reconcileBlocks`. Both are timed with
/// the feed's work on them.

/// What one change of the list cost the page, in milliseconds.
export interface FeedGrowthMeasure {
  /// The app's update of the list: the new array.
  listMs: number;
  /// The feed on the new list: its render and every effect of it.
  feedMs: number;
}

export interface FeedGrowthAuditHandle {
  /// Shows the first `count` cards as a feed just read: every card anew.
  load: (count: number) => void;
  /// Keeps the first `count` cards as they are and drops the rest.
  truncate: (count: number) => void;
  /// The next `count` cards arrive as a page of the feed.
  appendPage: (count: number) => FeedGrowthMeasure;
  /// The row of the card at `index` arrives changed: its preview is built,
  /// or lost again when it was built.
  changeCard: (index: number) => FeedGrowthMeasure;
  loaded: () => number;
}

declare global {
  interface Window {
    __MINE_FEED_GROWTH_AUDIT__?: FeedGrowthAuditHandle;
  }
}

const AUDIT_VAULT_PATH = "/tmp/mine-feed-growth-audit";
const AUDIT_SAVED_AT = "2026-05-24T00:00:00.000Z";
const FIRST_ID = 500_000;
/// The pictures of the feed scroll audit (public/feed-scroll-audit): what a
/// card paints is not what this audit measures.
const PICTURES = Array.from({ length: 6 }, (_, index) => `/feed-scroll-audit/audit-${index}.svg`);
/// The shapes of a 640 px preview.
const PREVIEW_SHAPES = [
  [640, 360],
  [640, 480],
  [640, 640],
  [480, 640],
  [426, 640],
] as const;

const WORDS = [
  "archive", "notes", "on", "the", "quiet", "design", "of", "everyday", "tools", "and", "a", "study",
  "in", "contrast", "between", "paper", "screens", "light", "typography", "margins", "rhythm", "for",
  "reading", "longer", "texts", "collected", "references", "about", "architecture", "furniture",
  "photography", "printing", "заметки", "о", "форме", "и", "материале", "свет", "тень", "ритм",
  "страницы", "длинный", "текст", "короткая", "подпись", "коллекция", "ссылок", "по", "теме",
] as const;

/// The same words for the same card on every run.
function words(seed: number, count: number): string {
  let state = (seed * 2654435761) >>> 0;
  const picked: string[] = [];
  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    picked.push(WORDS[state % WORDS.length]!);
  }
  return picked.join(" ");
}

function baseBlock(index: number): LightBlock {
  return {
    id: FIRST_ID + index,
    slug: `feed-growth-audit-${index}`,
    card_kind: "article",
    block_type: "article",
    title: null,
    content_heading: null,
    display_title: null,
    fallback_label: `Card ${index + 1}`,
    url: null,
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

/// A picture with a file of its own. `built` is whether its preview exists:
/// without it the card stands on the envelope of the size its row declares.
function pictureCard(index: number, built: boolean): LightBlock {
  const [width, height] = PREVIEW_SHAPES[index % PREVIEW_SHAPES.length]!;
  const picture = PICTURES[index % PICTURES.length]!;
  return {
    ...baseBlock(index),
    card_kind: "media",
    block_type: "image",
    media_file: `/__mine_forbidden_source__/original-${index}.png`,
    // The row declares the source's size, which is not the preview's shape.
    width: 1600,
    height: 1200,
    preview_manifest: built
      ? JSON.stringify({
          kind: "image",
          primary_preview_path: picture,
          width: 1600,
          height: 1200,
          preview_width: width,
          preview_height: height,
          tiles: [],
          overflow_count: 0,
        })
      : null,
  };
}

/// A saved page: its picture, title and description.
function linkCard(index: number): LightBlock {
  const [width, height] = PREVIEW_SHAPES[index % 2]!;
  const picture = PICTURES[index % PICTURES.length]!;
  return {
    ...baseBlock(index),
    card_kind: "link",
    block_type: "link",
    title: words(index, 3 + (index % 9)),
    url: `https://example.test/feed-growth-audit/${index}`,
    preview_text: words(index + 1, 12 + (index % 30)),
    preview_manifest: JSON.stringify({
      kind: "image",
      primary_preview_path: picture,
      width: width * 2,
      height: height * 2,
      preview_width: width,
      preview_height: height,
      tiles: [],
      overflow_count: 0,
    }),
  };
}

/// An article: its title and text, every third one with a picture.
function articleCard(index: number): LightBlock {
  const text = words(index + 2, 30 + (index % 35));
  const source = `/__mine_forbidden_source__/original-${index}.png`;
  const picture = PICTURES[index % PICTURES.length]!;
  const withPicture = index % 3 === 0;
  return {
    ...baseBlock(index),
    title: words(index, 4 + (index % 8)),
    author: index % 2 === 0 ? "Mine audit" : null,
    body: text,
    preview_text: text,
    first_image: withPicture ? source : null,
    preview_manifest: withPicture
      ? JSON.stringify({
          kind: "image",
          primary_preview_path: picture,
          width: 1200,
          height: 800,
          preview_width: 640,
          preview_height: 426,
          tiles: [{
            source_path: source,
            preview_path: picture,
            width: 1200,
            height: 800,
            preview_width: 640,
            preview_height: 426,
            is_video: false,
            is_video_poster: false,
          }],
          overflow_count: 0,
        })
      : null,
  };
}

/// A post: its author, its text and, in every second one, four pictures.
function postCard(index: number): LightBlock {
  const text = words(index + 3, 10 + (index % 40));
  const tiles = Array.from({ length: 4 }, (_, tile) => ({
    source_path: `/__mine_forbidden_source__/original-${index}-${tile}.png`,
    preview_path: PICTURES[(index + tile) % PICTURES.length]!,
    width: 960,
    height: 960,
    preview_width: 320,
    preview_height: 320,
    is_video: false,
    is_video_poster: false,
  }));
  return {
    ...baseBlock(index),
    title: `Post ${index + 1}`,
    url: `https://x.com/mine/status/${1_000_000 + index}`,
    author: "Mine audit",
    body: text,
    preview_text: text,
    preview_manifest: index % 2 === 0
      ? JSON.stringify({
          kind: "composite",
          primary_preview_path: tiles[0]!.preview_path,
          width: 960,
          height: 960,
          preview_width: 640,
          preview_height: 640,
          tiles,
          overflow_count: 0,
        })
      : null,
  };
}

/// Whether the card at `index` is a picture: the cards `changeCard` changes.
function isPictureIndex(index: number): boolean {
  return index % 20 < 10;
}

/// Ten pictures, five saved pages, three articles and two posts in every
/// twenty: the mix of the spaces AUDIT_PERFORMANCE.md measured (раздел 2).
function makeAuditBlock(index: number, built = true): LightBlock {
  const kind = index % 20;
  if (kind < 10) return pictureCard(index, built);
  if (kind < 15) return linkCard(index);
  if (kind < 18) return articleCard(index);
  return postCard(index);
}

// What the feed is given besides its list stays the same from render to
// render, as in the app: a list or a function made anew on every render
// reaches every card on the page and draws each of them again, which is the
// route's work, not the feed's (AUDIT_PERFORMANCE.md, З2).
const NO_TAGS: TagCount[] = [];

function noop() {
  return undefined;
}

async function noBlockTags(): Promise<Map<string, string[]>> {
  return new Map();
}

async function wholeDeletePlan(slugs: string[]): Promise<DeleteBlocksPlan> {
  return { slugs, markdown_files: [], unused_media: [], shared_media: [] };
}

async function deleteNothing() {
  return undefined;
}

export function FeedGrowthAuditRoute() {
  const [blocks, setBlocks] = useState<LightBlock[]>([]);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  useEffect(() => {
    /// The time of `update` on the list held now, then of the feed on its
    /// result: `flushSync` returns after the render and every effect of it.
    const measured = (update: (current: LightBlock[]) => LightBlock[]): FeedGrowthMeasure => {
      const started = performance.now();
      const next = update(blocksRef.current);
      const listed = performance.now();
      flushSync(() => setBlocks(next));
      return { listMs: listed - started, feedMs: performance.now() - listed };
    };
    window.__MINE_FEED_GROWTH_AUDIT__ = {
      load: (count) => {
        flushSync(() => setBlocks(Array.from({ length: count }, (_, index) => makeAuditBlock(index))));
      },
      truncate: (count) => {
        flushSync(() => setBlocks((current) => current.slice(0, count)));
      },
      // The app's append of a page (src/App.tsx, `loadNextPage`): the rows
      // the feed does not hold yet, after the ones it holds.
      appendPage: (count) => {
        const from = blocksRef.current.length;
        const page = Array.from({ length: count }, (_, index) => makeAuditBlock(from + index));
        return measured((current) => {
          const seen = new Set(current.map((block) => block.id));
          const appended = page.filter((block) => !seen.has(block.id));
          return appended.length > 0 ? [...current, ...appended] : current;
        });
      },
      // The app's update by a changed row (src/App.tsx, the queue of preview
      // rows): the row replaces its card, every other card stays the object
      // it was.
      changeCard: (index) => {
        const card = blocksRef.current[index];
        if (!card || !isPictureIndex(index)) throw new Error(`No picture card at ${index}`);
        const row = makeAuditBlock(index, card.preview_manifest === null);
        const replacements = new Map([[row.slug, row]]);
        return measured((current) => reconcileBlocks(
          current,
          current.map((block) => replacements.get(block.slug) ?? block),
        ));
      },
      loaded: () => blocksRef.current.length,
    };
    return () => {
      delete window.__MINE_FEED_GROWTH_AUDIT__;
    };
  }, []);

  return (
    <main
      className="h-screen w-screen overflow-hidden bg-background text-foreground"
      data-feed-growth-audit-route=""
      data-feed-growth-audit-block-count={blocks.length}
    >
      <Grid
        blocks={blocks}
        vaultPath={AUDIT_VAULT_PATH}
        thumbsRootPath=""
        tags={NO_TAGS}
        currentTag={undefined}
        scrollToTop={0}
        keyboardNavigationDisabled
        onBlockClick={noop}
        onToggleTag={noop}
        onCreateAndAssign={noop}
        onLoadBlockTags={noBlockTags}
        onBatchSetTag={noop}
        onCreateAndAssignBatch={noop}
        onPrepareDeleteSelectedBlocks={wholeDeletePlan}
        onDeleteSelectedBlocks={deleteNothing}
        onMergeSelectedBlocks={noop}
        onRequestRename={noop}
        onRequestDelete={noop}
      />
    </main>
  );
}
