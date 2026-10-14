// The first opening of a space from iCloud, for design acceptance
// (SPEC_CLOUD_STORAGE.md, «Первое открытие пространства из облака»).
//
// Production components only: the opening notice in each of its states, the
// feed cards before and after their previews, and one window that plays the
// whole opening on a loop with the real Grid, notice and bottom bar: the
// feed appears whole after the notes, then the previews arrive scattered.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActionButton } from "@/components/ActionButton";
import { Card } from "@/components/Card";
import { ChromeRow } from "@/components/ChromeRow";
import { Grid } from "@/components/Grid";
import { IndexingProgress, openingStep, useIndexingNotice } from "@/components/IndexingProgress";
import { NotificationAnchor } from "@/components/NotificationCard";
import { computeCardHeight } from "@/lib/cardHeight";
import { commandById } from "@/lib/commandRegistry";
import { FeedShowContext } from "@/lib/feedDisplay";
import { publishNotificationBottom } from "@/lib/notificationPlacement";
import type { LightBlock } from "@/types";

const PICTURES = [0, 1, 2, 3, 4, 5].map((index) => `/feed-scroll-audit/audit-${index}.svg`);

interface Shape {
  /** The size the note declares; null when the note has none. */
  declared: [number, number] | null;
  /** The size of the preview that arrives. */
  actual: [number, number];
}

function pictureBlock(id: number, shape: Shape, overrides: Partial<LightBlock> = {}): LightBlock {
  return {
    id,
    slug: `cloud-open-${id}`,
    card_kind: "media",
    block_type: "image",
    title: null,
    content_heading: null,
    display_title: null,
    fallback_label: `Picture ${id}`,
    url: null,
    media_file: PICTURES[id % PICTURES.length]!,
    thumbnail: null,
    saved_at: "2026-10-08T00:00:00Z",
    width: shape.declared?.[0] ?? null,
    height: shape.declared?.[1] ?? null,
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
    ...overrides,
  };
}

function withPreview(block: LightBlock, [width, height]: [number, number]): LightBlock {
  const picture = PICTURES[block.id % PICTURES.length]!;
  return {
    ...block,
    content_in_cloud: false,
    preview_manifest: JSON.stringify({
      kind: "image",
      primary_preview_path: picture,
      width,
      height,
      preview_width: width,
      preview_height: height,
      tiles: [],
      overflow_count: 0,
    }),
  };
}

function textBlock(id: number, title: string, text: string): LightBlock {
  return pictureBlock(id, { declared: null, actual: [1, 1] }, {
    card_kind: "article",
    block_type: "article",
    media_file: null,
    title,
    display_title: title,
    preview_text: text,
    body: text,
  });
}

const PORTRAIT: Shape = { declared: [600, 800], actual: [600, 800] };
const LANDSCAPE: Shape = { declared: [1200, 800], actual: [1200, 800] };
const SQUARE: Shape = { declared: [900, 900], actual: [900, 900] };
const UNSIZED_TALL: Shape = { declared: null, actual: [600, 900] };
const UNSIZED_WIDE: Shape = { declared: null, actual: [1600, 900] };

const FEED: { block: LightBlock; actual: [number, number] | null }[] = [
  PORTRAIT, UNSIZED_TALL, LANDSCAPE, null, SQUARE, UNSIZED_WIDE,
  UNSIZED_TALL, PORTRAIT, null, LANDSCAPE, UNSIZED_TALL, SQUARE,
  LANDSCAPE, null, UNSIZED_TALL, PORTRAIT, SQUARE, UNSIZED_WIDE,
  UNSIZED_TALL, LANDSCAPE, PORTRAIT, null, UNSIZED_TALL, SQUARE,
].map((shape, index) => {
  const id = 1000 + index;
  if (shape === null) {
    return {
      block: textBlock(id, "Notes on calm interfaces", "A calm interface answers when asked and stays still otherwise."),
      actual: null,
    };
  }
  return { block: pictureBlock(id, shape, { content_in_cloud: index % 5 === 1 }), actual: shape.actual };
});

/** The order previews arrive in: scattered, as a real pass finishes them. */
const ARRIVAL_ORDER = [3, 0, 7, 1, 12, 5, 9, 14, 2, 18, 6, 10, 21, 4, 16, 8, 22, 11, 19, 13, 23, 15, 20, 17];

const TICK_MS = 250;
const NOTES_TICKS = 16;
const BETWEEN_TICKS = 4;
const PREVIEW_TICKS = FEED.length;
const HOLD_TICKS = 20;
const LOOP_TICKS = NOTES_TICKS + BETWEEN_TICKS + PREVIEW_TICKS + HOLD_TICKS;

function useLoopTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => (value + 1) % LOOP_TICKS), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return tick;
}

function noop() {
  return undefined;
}

function OpeningWindow() {
  const tick = useLoopTick();
  const notesProcessed = tick < NOTES_TICKS ? Math.round((FEED.length * tick) / NOTES_TICKS) : null;
  const previewTick = tick - NOTES_TICKS - BETWEEN_TICKS;
  const previewsPending = tick >= NOTES_TICKS && previewTick < PREVIEW_TICKS;
  const previewsArrived = Math.max(0, Math.min(previewTick, PREVIEW_TICKS));

  // The index commits in one piece: the feed stays empty while the notes
  // are read and appears whole once they are (SPEC_CLOUD_STORAGE.md, Х26).
  const shown = notesProcessed === null ? FEED.length : 0;
  const arrived = useMemo(() => new Set(ARRIVAL_ORDER.slice(0, previewsArrived)), [previewsArrived]);
  const previewed = useMemo(
    () => FEED.map(({ block, actual }) => (actual === null ? block : withPreview(block, actual))),
    [],
  );
  const blocks = useMemo(
    () => FEED.slice(0, shown).map(({ block }, index) => (arrived.has(index) ? previewed[index]! : block)),
    [arrived, previewed, shown],
  );

  const step = openingStep(
    notesProcessed === null ? null : { processed: notesProcessed, total: FEED.length },
    previewsPending,
    previewTick >= 0 && previewsPending ? { processed: previewsArrived, total: PREVIEW_TICKS } : null,
  );
  const noticeVisible = useIndexingNotice(step !== null);

  const frameRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const bar = barRef.current;
    if (!frame || !bar) return;
    const publish = () => publishNotificationBottom(frame, bar, frame.getBoundingClientRect().bottom);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={frameRef}
      // The transform makes the frame the containing block of the fixed
      // notice anchor, so the notice stands in this window, not the page.
      className="flex h-[640px] w-full max-w-[1100px] [transform:translateZ(0)] flex-col overflow-hidden rounded-1 border border-border bg-background"
    >
      <div className="relative min-h-0 flex-1">
        <Grid
          blocks={blocks}
          vaultPath=""
          thumbsRootPath=""
          tags={[]}
          currentTag={undefined}
          scrollToTop={0}
          keyboardNavigationDisabled
          firstIndexProgress={notesProcessed === null ? null : { processed: notesProcessed, total: FEED.length }}
          vaultIndexing={notesProcessed !== null}
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
      </div>
      <ChromeRow
        separator="top"
        ref={barRef}
        className="gap-2 bg-accent pl-[var(--sidebar-label-inset)] pr-[var(--chrome-edge-pad)]"
      >
        <ActionButton chrome hotkey={commandById("toggle-sidebar").combo}>Hide Sidebar</ActionButton>
        <ActionButton chrome hotkey={commandById("new-collection").combo}>
          {commandById("new-collection").name}
        </ActionButton>
      </ChromeRow>
      {noticeVisible && step !== null && (
        <NotificationAnchor>
          <IndexingProgress spaceName="NSFV" step={step} />
        </NotificationAnchor>
      )}
    </div>
  );
}

const CARD_WIDTH = 224;

function FeedCard({ block }: { block: LightBlock }) {
  return (
    <FeedShowContext.Provider value="cards">
      <div style={{ width: CARD_WIDTH, height: computeCardHeight(block, CARD_WIDTH, null, "cards") }}>
        <Card
          block={block}
          vaultPath=""
          thumbsRootPath=""
          onClick={noop}
          tags={[]}
          onToggleTag={noop}
          onCreateAndAssign={noop}
          onRequestRename={noop}
          onRequestDelete={noop}
        />
      </div>
    </FeedShowContext.Provider>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-2">
      {children}
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

const CARD_STATES: { label: string; block: LightBlock }[] = [
  { label: "3:4 из заметки", block: pictureBlock(2001, PORTRAIT) },
  { label: "3:2 из заметки", block: pictureBlock(2002, LANDSCAPE) },
  { label: "без размера, 16:9", block: pictureBlock(2003, UNSIZED_TALL) },
  { label: "в iCloud", block: pictureBlock(2004, PORTRAIT, { content_in_cloud: true }) },
  { label: "превью пришло", block: withPreview(pictureBlock(2005, UNSIZED_TALL), UNSIZED_TALL.actual) },
];

export function CloudOpenPage() {
  return (
    // The document never scrolls (global.css, native app scroll contract):
    // the page is its own scroll pane.
    <main className="h-full overflow-y-auto bg-background p-8 text-foreground">
      <div className="grid gap-12">
        <div className="flex flex-wrap items-start gap-6">
          <Labeled label="заметки">
            <IndexingProgress spaceName="NSFV" step={{ phase: "notes", count: { processed: 284, total: 674 } }} />
          </Labeled>
          <Labeled label="превью, до подсчёта">
            <IndexingProgress spaceName="NSFV" step={{ phase: "previews", count: null }} />
          </Labeled>
          <Labeled label="превью">
            <IndexingProgress spaceName="NSFV" step={{ phase: "previews", count: { processed: 312, total: 643 } }} />
          </Labeled>
        </div>

        <div className="flex flex-wrap items-start gap-6">
          {CARD_STATES.map(({ label, block }) => (
            <Labeled key={block.id} label={label}>
              <FeedCard block={block} />
            </Labeled>
          ))}
        </div>

        <OpeningWindow />
      </div>
    </main>
  );
}
