// The onboarding, screen by screen (SPEC_ONBOARDING.md, О9 to О15).
//
// Every frame is a window of production components: the tab bar above, and
// below it the tab page as App.tsx lays it out, the picker without a space or
// the space's chrome, sidebar, feed, bottom bar and notice. The system folder
// dialog is not drawn: a line between the frames stands for it.

import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { DndContext } from "@dnd-kit/core";
import { MemoryRouter } from "react-router";
import { Plus } from "lucide-react";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { ActionButton } from "@/components/ActionButton";
import { ChromeRow, ChromeShell } from "@/components/ChromeRow";
import { Grid } from "@/components/Grid";
import { IndexingProgress, type IndexingStep } from "@/components/IndexingProgress";
import { MainSecondaryTopBar } from "@/components/MainSecondaryChrome";
import { NotificationAnchor } from "@/components/NotificationCard";
import { Sidebar } from "@/components/Sidebar";
import { TopCollectionSwitcher } from "@/components/TopCollectionSwitcher";
import { VaultPicker } from "@/components/VaultPicker";
import { VaultSwitcher } from "@/components/VaultSwitcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { APP_MAIN_MIN_WIDTH_PX } from "@/lib/appLayout";
import { PreviewsPendingContext } from "@/lib/cardPreviewState";
import { applyChromeRowHeight, TALL_CHROME_ROW_HEIGHT } from "@/lib/chromeHeight";
import { commandById } from "@/lib/commandRegistry";
import { EDGE_FADE_WIDTH, createRightFadeMaskStyle } from "@/lib/edgeFade";
import { SEARCH_INPUT_SUPPRESSION_PROPS } from "@/lib/searchInputSuppression";
import { TabBar } from "@/tabbar/TabBar";
import "@/tabbar/tabbar.css";
import type { LightBlock, PreviewCard, TabBarState } from "@/types";

// The tab bar and the space switcher talk to the backend: here they get
// empty answers, and their event listeners a local bus.
mockWindows("onboarding");
mockIPC((command) => {
  if (command === "list_known_vaults" || command === "list_spaces") return [];
  return null;
}, { shouldMockEvents: true });

const NOTES_FOLDER = "/Users/me/References";
const EMPTY_FOLDER = "/Users/me/Moodboard";
/** Notes in the folder: more than the window shows. */
const NOTE_COUNT = 674;
/** The first-run sidebar width (domain/windows.rs, SIDEBAR_DEFAULT_WIDTH_PX). */
const SIDEBAR_WIDTH = 360;
/** The page under the tab bar in a window of the default size. */
const PAGE_HEIGHT = 800;
const WINDOW_WIDTH = 1200;

// A window's default rows are tall (SPEC_TABS.md, В83). The sidebar's width
// lives on the root, where its columns are derived from it, as
// useSidebarResize writes it.
applyChromeRowHeight(TALL_CHROME_ROW_HEIGHT);
document.documentElement.style.setProperty("--sidebar-width", `${SIDEBAR_WIDTH}px`);

const SIDEBAR_SEARCH_MASK_STYLE = createRightFadeMaskStyle(EDGE_FADE_WIDTH, 0);

function noop() {
  return undefined;
}

function folderName(path: string): string {
  return path.split("/").pop() ?? path;
}

// ── The folder's notes ─────────────────────────────────────────────────────

const PICTURES = [0, 1, 2, 3, 4, 5].map((index) => `/feed-scroll-audit/audit-${index}.svg`);

type Size = [number, number];

const PORTRAIT: Size = [600, 800];
const LANDSCAPE: Size = [1200, 800];
const SQUARE: Size = [900, 900];
const TALL: Size = [600, 900];
const WIDE: Size = [1600, 900];

const TEXTS: [string, string][] = [
  ["Notes on calm interfaces", "A calm interface answers when asked and stays still otherwise."],
  ["Reading list", "Books on type, grids and the craft of making tools for thought."],
  ["Why grids work", "A grid is a promise: things that line up belong together."],
  ["Margins", "White space is not empty. It is the room the content breathes in."],
  ["On slowness", "Some tools should be fast; the best ones let you be slow."],
];

/** A picture or a text note, in the feed's order. */
const SHAPES: (Size | "text")[] = [
  PORTRAIT, LANDSCAPE, "text", SQUARE, TALL, WIDE,
  PORTRAIT, "text", LANDSCAPE, SQUARE, TALL, PORTRAIT,
  WIDE, SQUARE, "text", PORTRAIT, LANDSCAPE, TALL,
  SQUARE, PORTRAIT, WIDE, "text", LANDSCAPE, TALL,
  PORTRAIT, SQUARE, "text", WIDE, PORTRAIT, LANDSCAPE,
];

function baseBlock(id: number, overrides: Partial<LightBlock>): LightBlock {
  return {
    id,
    slug: `onboarding-${id}`,
    card_kind: "media",
    block_type: "image",
    title: null,
    content_heading: null,
    display_title: null,
    fallback_label: `Picture ${id}`,
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: new Date(Date.UTC(2026, 9, 8) - id * 3_600_000).toISOString(),
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
    ...overrides,
  };
}

interface Note {
  /** Before its preview: what the index gives a card. */
  block: LightBlock;
  /** After: the card with its preview, or the same text card. */
  previewed: LightBlock;
  picture: string | null;
}

let textIndex = 0;
const NOTES: Note[] = SHAPES.map((shape, index) => {
  const id = index + 1;
  if (shape === "text") {
    const [title, text] = TEXTS[textIndex++ % TEXTS.length]!;
    const block = baseBlock(id, {
      card_kind: "article",
      block_type: "article",
      title,
      display_title: title,
      fallback_label: title,
      preview_text: text,
      body: text,
    });
    return { block, previewed: block, picture: null };
  }
  const picture = PICTURES[index % PICTURES.length]!;
  const [width, height] = shape;
  // A folder on the disk: the index reads each picture's size.
  const block = baseBlock(id, { media_file: picture, width, height });
  const previewed: LightBlock = {
    ...block,
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
  return { block, previewed, picture };
});

/** The cards whose previews are ready while the pass runs: scattered. */
const ARRIVED = new Set([0, 3, 5, 9, 12, 13, 17, 20, 24, 28]);

const FEED_PREVIEWS_PENDING = NOTES.map((note, index) => (ARRIVED.has(index) ? note.previewed : note.block));
const FEED_READY = NOTES.map((note) => note.previewed);

/** The Everything row's strip: the newest cards that have a thumbnail. */
function everythingPreviews(ready: (index: number) => boolean): Map<string, PreviewCard[]> {
  const cards = NOTES.flatMap((note, index) => (
    note.picture !== null && ready(index)
      ? [{ slug: note.block.slug, url: note.picture, text: false, hasThumb: true }]
      : []
  ));
  return new Map([["__all__", cards.slice(0, 20)]]);
}

const NO_PREVIEWS = new Map<string, PreviewCard[]>([["__all__", []]]);

// ── The window ─────────────────────────────────────────────────────────────

function tabBarState(spaceName: string | null): TabBarState {
  return {
    window_id: "onboarding-window",
    tabs: [{
      id: "0".repeat(32),
      space_name: spaceName,
      place: null,
      card: null,
      live: true,
      history: { back: false, forward: false },
      error: null,
    }],
    active_tab: "0".repeat(32),
    sidebar: { width_px: SIDEBAR_WIDTH, collapsed: false },
    fullscreen: false,
    chrome_rows: { tab_bar: TALL_CHROME_ROW_HEIGHT, page: TALL_CHROME_ROW_HEIGHT },
  };
}

/** The window: its tab bar, and the tab page under it. */
function Window({ spaceName, children }: { spaceName: string | null; children: ReactNode }) {
  return (
    <div
      data-onboarding-window=""
      className="flex w-full flex-col overflow-hidden rounded-1 border border-border bg-background"
      style={{ maxWidth: WINDOW_WIDTH }}
    >
      {/* The tab bar is a page of its own, standing on the accent. */}
      <div className="bg-accent" style={{ "--surface": "var(--accent)" } as CSSProperties}>
        <TabBar bar={tabBarState(spaceName)} dropHover={null} />
      </div>
      {/* The transform makes the page the containing block of the fixed
          notice anchor, so the notice stands in this page, as in a tab. */}
      <div
        data-onboarding-page=""
        className="relative w-full [transform:translateZ(0)]"
        style={{ height: PAGE_HEIGHT }}
      >
        {children}
      </div>
    </div>
  );
}

interface SpacePageProps {
  path: string;
  blocks: LightBlock[];
  /** The space's card count, the Everything row's number. */
  totalBlocks: number;
  previews: Map<string, PreviewCard[]>;
  /** The first index pass is running, with its count. */
  indexing: { processed: number; total: number } | null;
  /** The full preview pass is queued or running. */
  previewsPending: boolean;
  /** The opening notice, when it shows. */
  notice: IndexingStep | null;
}

/** A tab with a space open, as App.tsx lays it out on Everything. */
function SpacePage({ path, blocks, totalBlocks, previews, indexing, previewsPending, notice }: SpacePageProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  // The page publishes its bottom bar's height for the notice, as App does.
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const bar = barRef.current;
    if (!shell || !bar) return;
    const publish = () => shell.style.setProperty("--bottom-bar-height", `${bar.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  return (
    <PreviewsPendingContext.Provider value={previewsPending}>
      <MemoryRouter initialEntries={["/"]}>
        <DndContext>
          <div ref={shellRef} className="h-full w-full">
          <ChromeShell topEdge={false} className="h-full w-full">
            <ChromeRow as="header" separator="bottom" className="bg-chrome">
              <div
                data-app-top-sidebar-segment=""
                className="flex h-full shrink-0 items-center overflow-hidden border-r border-sidebar-border"
                style={{ width: "var(--sidebar-width)" }}
              >
                <div className="flex h-full min-w-0 flex-1" data-top-chrome-space-search-group="">
                  <VaultSwitcher
                    currentPath={path}
                    onVaultSelected={noop}
                    onOpenInNewTab={noop}
                    surface="topChrome"
                    topChromeCollapsed={false}
                  />
                  <div aria-hidden="true" className="h-full w-px shrink-0 bg-border" />
                  <div className="flex h-full min-w-0 flex-1 items-center bg-chrome">
                    <Input
                      {...SEARCH_INPUT_SUPPRESSION_PROPS}
                      aria-label="Find or create collection"
                      placeholder="Find or create..."
                      style={SIDEBAR_SEARCH_MASK_STYLE}
                      variant="ghost"
                      value=""
                      onChange={noop}
                      className="h-full min-w-0 flex-1 rounded-0 bg-transparent px-3 py-0 font-mono text-sm text-muted-foreground placeholder:text-muted-foreground"
                    />
                    <div className="mr-2 flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="chrome"
                        size="chrome-icon"
                        plate="raised"
                        aria-label="New Collection"
                        shortcut={commandById("new-collection").combo}
                      >
                        <Plus />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex h-full min-w-0 flex-1 items-center">
                <TopCollectionSwitcher
                  orderedTags={[]}
                  onNavigate={noop}
                  onCreateCollection={async () => undefined}
                  joinsNext
                />
                <MainSecondaryTopBar
                  part="content"
                  sidebarCollapsed={false}
                  sidebarResizing={false}
                  stats={null}
                  viewMode="grid"
                  onViewModeChange={noop}
                  vaultPath={path}
                  tags={[]}
                  onToggleTag={noop}
                  onCreateAndAssign={noop}
                  onRequestRename={noop}
                  onRenameFile={async () => undefined}
                  onCheckFileName={async () => null}
                  onRequestDelete={noop}
                  onDetailClose={noop}
                  detailMenuOpenRequestSequence={0}
                />
              </div>
            </ChromeRow>

            <div className="relative flex min-h-0 flex-1">
              <Sidebar
                width={SIDEBAR_WIDTH}
                collapsed={false}
                isResizing={false}
                vaultPath={path}
                previewsPending={previewsPending}
                tags={[]}
                orderedTags={[]}
                channelPreviews={previews}
                totalBlocks={totalBlocks}
                isDropDragging={false}
                isCreatingChannel={false}
                onSetCreatingChannel={noop}
                onDeleteTag={noop}
                onRenameTag={noop}
                onCreateChannel={noop}
              />
              <main className="relative isolate min-h-0 flex-1 overflow-hidden" style={{ minWidth: APP_MAIN_MIN_WIDTH_PX }}>
                <Grid
                  blocks={blocks}
                  vaultPath={path}
                  thumbsRootPath=""
                  tags={[]}
                  scrollToTop={0}
                  keyboardNavigationDisabled
                  onInstallClipper={noop}
                  spaceOnboardingOwed
                  firstIndexProgress={indexing}
                  vaultIndexing={indexing !== null}
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
              {notice !== null && (
                <NotificationAnchor>
                  <div className="grid justify-items-end gap-2">
                    <IndexingProgress spaceName={folderName(path)} step={notice} />
                  </div>
                </NotificationAnchor>
              )}
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
              {blocks.length > 0 && (
                <ActionButton chrome hotkey={commandById("navigate").combo} readOnly>
                  {commandById("navigate").name}
                </ActionButton>
              )}
              <div className="flex-1" />
              <ActionButton chrome hotkey={commandById("find-elements").combo}>
                {commandById("find-elements").name}
              </ActionButton>
              <ActionButton chrome hotkey={commandById("settings").combo}>
                {commandById("settings").name}
              </ActionButton>
            </ChromeRow>
          </ChromeShell>
          </div>
        </DndContext>
      </MemoryRouter>
    </PreviewsPendingContext.Provider>
  );
}

// ── The page ───────────────────────────────────────────────────────────────

/** The picker fills its page, not the browser's screen. */
const PICKER_IN_FRAME_CSS = `
[data-onboarding-page] [data-vault-picker] {
  width: 100%;
  height: 100%;
}
`;

/** One screen. `label` is its number, or the step it branches from. */
function Step({ label, caption, children }: { label: string; caption: string; children: ReactNode }) {
  return (
    <section className="grid gap-3" data-onboarding-step={label}>
      {children}
      <p className="flex gap-2 text-sm text-muted-foreground">
        <span className="tabular-nums text-foreground">{label}</span>
        <span>{caption}</span>
      </p>
    </section>
  );
}

function Between({ children }: { children: ReactNode }) {
  return <p className="py-6 text-sm text-muted-foreground">{children}</p>;
}

export function OnboardingPage() {
  return (
    // The document never scrolls (global.css, native app scroll contract):
    // the page is its own scroll pane.
    <main className="h-full overflow-y-auto bg-background p-8 text-foreground">
      <style>{PICKER_IN_FRAME_CSS}</style>
      <div className="grid gap-12">
        <Step label="1" caption="Первый запуск">
          <Window spaceName={null}>
            <VaultPicker onVaultSelected={noop} />
          </Window>
        </Step>

        <Between>Системный диалог выбора папки</Between>

        <Step label="2" caption="Индексация заметок">
          <Window spaceName={folderName(NOTES_FOLDER)}>
            <SpacePage
              path={NOTES_FOLDER}
              blocks={[]}
              totalBlocks={0}
              previews={NO_PREVIEWS}
              indexing={{ processed: 284, total: NOTE_COUNT }}
              previewsPending={false}
              notice={{ phase: "notes", count: { processed: 284, total: NOTE_COUNT } }}
            />
          </Window>
        </Step>

        <Step label="3" caption="Подготовка превью">
          <Window spaceName={folderName(NOTES_FOLDER)}>
            <SpacePage
              path={NOTES_FOLDER}
              blocks={FEED_PREVIEWS_PENDING}
              totalBlocks={NOTE_COUNT}
              previews={everythingPreviews((index) => ARRIVED.has(index))}
              indexing={null}
              previewsPending
              notice={{ phase: "previews", count: { processed: 212, total: NOTE_COUNT } }}
            />
          </Window>
        </Step>

        <Step label="4" caption="Готово">
          <Window spaceName={folderName(NOTES_FOLDER)}>
            <SpacePage
              path={NOTES_FOLDER}
              blocks={FEED_READY}
              totalBlocks={NOTE_COUNT}
              previews={everythingPreviews(() => true)}
              indexing={null}
              previewsPending={false}
              notice={null}
            />
          </Window>
        </Step>

        {/* Another way the folder chosen at step 1 can go: not a step after 4. */}
        <Step label="1 →" caption="Пустая папка">
          <Window spaceName={folderName(EMPTY_FOLDER)}>
            <SpacePage
              path={EMPTY_FOLDER}
              blocks={[]}
              totalBlocks={0}
              previews={NO_PREVIEWS}
              indexing={null}
              previewsPending={false}
              notice={null}
            />
          </Window>
        </Step>
      </div>
    </main>
  );
}
