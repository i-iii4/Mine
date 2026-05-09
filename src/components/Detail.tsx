import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useDraggable } from "@dnd-kit/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { ExternalLink, GripVertical, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { IndexedBlock, LightBlock, TagCount } from "@/types";
import { openUrl } from "@tauri-apps/plugin-opener";
import { preprocessWikilinks } from "@/lib/markdownWikilinks";
import { decodeLocalMarkdownUrl } from "@/lib/markdownWikilinks";
import {
  thumbnailUrl,
  mediaUrl,
  previewAssetUrl,
  domainFromUrl,
  isSafeUrl,
  legacyThumbsRoot,
} from "@/lib/assets";
import { cn } from "@/lib/utils";
import { getDisplayTitle, getFallbackLabel, getNavigationLabel } from "@/lib/displayTitle";
import { getBlock } from "@/lib/commands";
import { getHoverPreviewOpenDelay } from "@/lib/hoverPreviewTiming";
import type { DetailTopMenuMode } from "@/lib/appPreferences";
import {
  findPreviewTileForSource,
  normalizeFeedPreviewManifest,
} from "@/lib/feedPreview";
import { deriveCardLayoutDescriptor } from "@/lib/cardLayout";
import {
  setActiveMineTextSelectionDragPayload,
  type MineTextSelectionDragPayload,
} from "@/lib/textSelectionDrag";
import { VideoFromBlob } from "./VideoFromBlob";
import { ArticleAudioControls } from "./ArticleAudioControls";
import { CardMoreMenu } from "./CardHoverMenu";
import { ReadOnlyCardPreview } from "./Card";
import { CollectionPicker } from "./CollectionPicker";
import { MicroPreviewThumbnail, microPreviewFromIndexedBlock } from "./MicroPreviewThumbnail";

// Layout constants — shared between top chrome, scroll layer, and metadata layer.
const DETAIL_CANVAS_CLASSES = "mx-auto w-[calc(100%-4rem)] max-w-[70rem]";
const DETAIL_GRID_CLASSES = `${DETAIL_CANVAS_CLASSES} grid grid-cols-[minmax(0,48rem)_20rem] gap-8`;
const CLASSIC_LAYOUT_CLASSES = `${DETAIL_GRID_CLASSES} pt-12`;
const ISLANDS_LAYOUT_CLASSES = `${DETAIL_GRID_CLASSES} pt-20`;
const DETAIL_BOTTOM_SAFE_SPACE_CLASS = "pb-20";
const HOVER_CARD_WIDTH = 240;
const HOVER_CARD_FALLBACK_HEIGHT = 320;
const HOVER_CARD_GAP = 8;
const HOVER_CARD_VIEWPORT_MARGIN = 16;
const ARTICLE_H1_CLASSES = "mt-0 mb-4 text-lg leading-6 font-semibold";
const ARTICLE_SECTION_HEADING_CLASSES = "mt-6 mb-2 text-base leading-5 font-semibold";

interface DetailProps {
  block: LightBlock | IndexedBlock;
  scrollAnchor?: string | null;
  vaultPath: string;
  thumbsRootPath?: string;
  detailTopMenuMode?: DetailTopMenuMode;
  isClosing?: boolean;
  onClose: () => void;
  onNavigate: (direction: "prev" | "next" | "up" | "down") => void;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onTagsChanged: () => void;
  onRequestRename: (block: LightBlock | IndexedBlock) => void;
  onRequestDelete: (slug: string) => void;
  onOpenRelatedNote: (slug: string) => void;
  onTextSelectionDrop?: (payload: MineTextSelectionDragPayload, tag: string) => void;
}

type DetailInlineMediaExtraction = {
  sourceSlug: string;
  mediaRef: string;
};

function isIndexedBlock(block: LightBlock | IndexedBlock): block is IndexedBlock {
  return "tags" in block;
}

type HoverPreviewPosition = {
  top: number;
  left: number;
};

type HoveredRelatedNote = {
  rowKey: string;
  slug: string;
};

export function Detail({
  block,
  scrollAnchor = null,
  vaultPath,
  thumbsRootPath,
  detailTopMenuMode = "island",
  isClosing = false,
  onClose,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
  onOpenRelatedNote,
  onTextSelectionDrop,
}: DetailProps) {
  const [fullBlock, setFullBlock] = useState<IndexedBlock | null>(
    isIndexedBlock(block) ? block : null,
  );
  const displayBlock = fullBlock ?? block;
  const currentBlockSlugRef = useRef(block.slug);
  const isFloatingTopMenu = detailTopMenuMode !== "classic";
  const layoutClasses = isFloatingTopMenu ? ISLANDS_LAYOUT_CLASSES : CLASSIC_LAYOUT_CLASSES;
  const {
    attributes: dragAttributes,
    listeners: dragListeners,
    setNodeRef: setDragHandleRef,
    isDragging,
  } = useDraggable({
    id: `detail:${displayBlock.slug}`,
    data: {
      type: "block",
      slug: displayBlock.slug,
      block: displayBlock,
    },
  });

  useEffect(() => {
    setFullBlock(isIndexedBlock(block) ? block : null);
  }, [block]);

  useEffect(() => {
    currentBlockSlugRef.current = block.slug;
  }, [block.slug]);

  const [chromeEntered, setChromeEntered] = useState(false);

  useEffect(() => {
    if (isClosing) {
      setChromeEntered(false);
      return;
    }
    setChromeEntered(false);
    const frame = window.requestAnimationFrame(() => {
      setChromeEntered(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detailTopMenuMode, isClosing]);

  const refreshFullBlock = useCallback((slug: string) => {
    void getBlock(slug).then((full) => {
      if (!full || currentBlockSlugRef.current !== slug) {
        return;
      }
      setFullBlock(full);
    });
  }, []);

  useEffect(() => {
    if (isIndexedBlock(block)) return;
    refreshFullBlock(block.slug);
  }, [block, refreshFullBlock]);

  useEffect(() => {
    const handleVaultRefreshed = () => {
      refreshFullBlock(block.slug);
    };
    window.addEventListener("vault-refreshed", handleVaultRefreshed);
    return () => {
      window.removeEventListener("vault-refreshed", handleVaultRefreshed);
    };
  }, [block.slug, refreshFullBlock]);

  const panelRef = useRef<HTMLDivElement>(null);

  // ESC closes Detail. Arrow keys remain native to the reading surface.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (shouldIgnoreDetailEscape(e)) return;
      if (e.metaKey || e.altKey || e.ctrlKey) return;
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [onClose]);

  // Auto-focus the panel so keyboard events work immediately
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, [block]);

  const filename = displayBlock.media_file ?? `${displayBlock.slug}.md`;
  const formattedDate = new Date(displayBlock.saved_at).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <div
      className={cn(
        "absolute inset-0 z-10 outline-none",
        isClosing ? "pointer-events-none bg-transparent" : "bg-background",
        !isFloatingTopMenu && "flex flex-col",
      )}
      role="dialog"
      aria-modal="false"
      aria-label={filename}
      data-detail-root
    >
      {isFloatingTopMenu ? (
        <div
          className={cn("absolute left-1/2 top-4 z-20 -translate-x-1/2", DETAIL_CANVAS_CLASSES)}
        >
          <header
            data-detail-top-menu={detailTopMenuMode}
            data-entered={chromeEntered ? "true" : "false"}
            className={cn(
              "detail-top-pill-enter flex h-8 w-full items-center gap-3 rounded-1 border border-border bg-accent/80 pl-3 pr-1 backdrop-blur-sm backdrop-saturate-150",
            )}
          >
            <div
              ref={setDragHandleRef}
              {...dragAttributes}
              {...dragListeners}
              className={cn(
                "min-w-0 flex-1 cursor-grab truncate font-mono text-sm text-muted-foreground active:cursor-grabbing",
                isDragging && "opacity-30",
              )}
              data-detail-drag-handle
              title={filename}
            >
              {filename}
            </div>
            <div className="flex h-8 shrink-0 items-center gap-1">
              <CardMoreMenu
                block={displayBlock}
                vaultPath={vaultPath}
                tags={tags}
                currentTag={currentTag}
                onToggleTag={onToggleTag}
                onCreateAndAssign={onCreateAndAssign}
                onRequestRename={onRequestRename}
                onRequestDelete={onRequestDelete}
                triggerVariant="ghost"
                className="shrink-0 text-muted-foreground hover:text-foreground"
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
                <span className="sr-only">Close</span>
              </Button>
            </div>
          </header>
        </div>
      ) : (
        <header
          data-entered={chromeEntered ? "true" : "false"}
          className="detail-top-bar-enter relative flex h-8 shrink-0 items-center gap-3 bg-accent px-8"
          data-detail-top-menu="classic"
        >
          <div
            ref={setDragHandleRef}
            {...dragAttributes}
            {...dragListeners}
            className={cn(
              "min-w-0 flex-1 cursor-grab truncate font-mono text-sm text-muted-foreground active:cursor-grabbing",
              isDragging && "opacity-30",
            )}
            data-detail-drag-handle
            title={filename}
          >
            {filename}
          </div>
          <CardMoreMenu
            block={displayBlock}
            vaultPath={vaultPath}
            tags={tags}
            currentTag={currentTag}
            onToggleTag={onToggleTag}
            onCreateAndAssign={onCreateAndAssign}
            onRequestRename={onRequestRename}
            onRequestDelete={onRequestDelete}
            triggerVariant="ghost"
            className="shrink-0 text-muted-foreground hover:text-foreground"
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </Button>
          <span
            aria-hidden="true"
            data-entered={chromeEntered ? "true" : "false"}
            className="detail-top-bar-line-enter pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border"
          />
        </header>
      )}
      <div
        className={cn(
          "relative min-h-0",
          isFloatingTopMenu ? "h-full" : "flex-1",
          isClosing && "opacity-0",
        )}
      >
        {/* Layer 1: Scrollable content + invisible spacer */}
        <div
          ref={panelRef}
          tabIndex={-1}
          className="h-full w-full overflow-y-auto outline-none"
          data-detail-scroll
        >
          <div className={cn(layoutClasses, DETAIL_BOTTOM_SAFE_SPACE_CLASS)}>
            <div className="min-w-0 pl-2" data-detail-article-column>
              <BlockContent
                block={block}
                fullBlock={fullBlock}
                scrollAnchor={scrollAnchor}
                vaultPath={vaultPath}
                thumbsRootPath={thumbsRootPath}
                onTextSelectionDrop={onTextSelectionDrop}
              />
            </div>
            <div
              className="min-w-0"
              aria-hidden="true"
              data-detail-metadata-spacer
            />
          </div>
        </div>

        {/* Layer 2: Fixed metadata (same layout, doesn't scroll) */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className={layoutClasses}>
            <div className="min-w-0" />
            <div
              className="pointer-events-auto min-w-0 overflow-y-auto overflow-x-hidden"
              data-metadata-scroll
            >
              <MetadataPanel
                block={block}
                fullBlock={fullBlock}
                formattedDate={formattedDate}
                vaultPath={vaultPath}
                thumbsRootPath={thumbsRootPath}
                tags={tags}
                currentTag={currentTag}
                onToggleTag={onToggleTag}
                onCreateAndAssign={onCreateAndAssign}
                onOpenRelatedNote={onOpenRelatedNote}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Metadata panel ─────────────────────────────────────────────────────────

interface MetadataPanelProps {
  block: LightBlock | IndexedBlock;
  fullBlock: IndexedBlock | null;
  formattedDate: string;
  vaultPath: string;
  thumbsRootPath?: string;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onOpenRelatedNote: (slug: string) => void;
}

function MetadataPanel({
  block,
  fullBlock,
  formattedDate,
  vaultPath,
  thumbsRootPath,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onOpenRelatedNote,
}: MetadataPanelProps) {
  const relatedNoteButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const hoverPreviewRef = useRef<HTMLDivElement | null>(null);
  const hoverPreviewOpenTimerRef = useRef<number | null>(null);
  const lastHoverPreviewOpenedAtRef = useRef<number | null>(null);
  const displayBlock = fullBlock ?? block;
  const indexWarning = getIndexWarning(displayBlock);
  const relatedNotes = useMemo(
    () =>
      isIndexedBlock(displayBlock) && Array.isArray(displayBlock.related_notes)
        ? displayBlock.related_notes
        : [],
    [displayBlock],
  );
  const relatedNotesKey = relatedNotes.join("\u0000");
  const resolvedThumbsRoot = thumbsRootPath ?? legacyThumbsRoot(vaultPath);
  const [relatedNoteBlocks, setRelatedNoteBlocks] = useState<Map<string, IndexedBlock | null> | null>(null);
  const [hoveredRelatedNote, setHoveredRelatedNote] = useState<HoveredRelatedNote | null>(null);
  const [hoverPreviewPosition, setHoverPreviewPosition] = useState<HoverPreviewPosition | null>(null);

  useEffect(() => {
    if (relatedNotes.length === 0) {
      setRelatedNoteBlocks(null);
      return;
    }
    let cancelled = false;
    setRelatedNoteBlocks(null);
    void Promise.all(
      relatedNotes.map(async (slug) => {
        const baseSlug = baseRelatedNoteSlug(slug);
        return { slug: baseSlug, block: await getBlock(baseSlug) };
      }),
    ).then((results) => {
      if (cancelled) return;
      setRelatedNoteBlocks(
        new Map(results.map(({ slug, block }) => [slug, block])),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [relatedNotes, relatedNotesKey]);

  const cancelHoverPreviewOpen = useCallback(() => {
    if (hoverPreviewOpenTimerRef.current == null) return;
    window.clearTimeout(hoverPreviewOpenTimerRef.current);
    hoverPreviewOpenTimerRef.current = null;
  }, []);

  const showRelatedNotePreview = useCallback((note: HoveredRelatedNote) => {
    lastHoverPreviewOpenedAtRef.current = Date.now();
    setHoveredRelatedNote(note);
  }, []);

  const openRelatedNotePreview = useCallback((note: HoveredRelatedNote) => {
    cancelHoverPreviewOpen();
    const delay = getHoverPreviewOpenDelay(lastHoverPreviewOpenedAtRef.current);
    if (delay <= 0) {
      showRelatedNotePreview(note);
      return;
    }
    setHoveredRelatedNote(null);
    hoverPreviewOpenTimerRef.current = window.setTimeout(() => {
      hoverPreviewOpenTimerRef.current = null;
      showRelatedNotePreview(note);
    }, delay);
  }, [cancelHoverPreviewOpen, showRelatedNotePreview]);

  const requestCloseRelatedNotePreview = useCallback(() => {
    cancelHoverPreviewOpen();
    setHoveredRelatedNote(null);
  }, [cancelHoverPreviewOpen]);

  useEffect(() => {
    return () => {
      cancelHoverPreviewOpen();
    };
  }, [cancelHoverPreviewOpen]);

  const hoveredRelatedNoteBlock = hoveredRelatedNote
    ? relatedNoteBlocks?.get(hoveredRelatedNote.slug) ?? null
    : null;

  useEffect(() => {
    if (!hoveredRelatedNote) {
      setHoverPreviewPosition(null);
      return;
    }
    const button = relatedNoteButtonRefs.current.get(hoveredRelatedNote.rowKey);
    if (!button) {
      setHoverPreviewPosition(null);
      return;
    }

    const triggerRect = button.getBoundingClientRect();
    const previewHeight =
      hoverPreviewRef.current?.getBoundingClientRect().height ??
      HOVER_CARD_FALLBACK_HEIGHT;
    setHoverPreviewPosition(computeHoverPreviewPosition(triggerRect, previewHeight));
  }, [hoveredRelatedNote, hoveredRelatedNoteBlock]);

  useEffect(() => {
    if (!hoveredRelatedNote || !hoverPreviewPosition || !hoverPreviewRef.current) {
      return;
    }
    const button = relatedNoteButtonRefs.current.get(hoveredRelatedNote.rowKey);
    if (!button) return;

    const triggerRect = button.getBoundingClientRect();
    const previewHeight = hoverPreviewRef.current.getBoundingClientRect().height;
    const nextPosition = computeHoverPreviewPosition(triggerRect, previewHeight);
    if (
      Math.abs(nextPosition.top - hoverPreviewPosition.top) > 1 ||
      Math.abs(nextPosition.left - hoverPreviewPosition.left) > 1
    ) {
      setHoverPreviewPosition(nextPosition);
    }
  }, [hoveredRelatedNote, hoverPreviewPosition, hoveredRelatedNoteBlock]);

  const cardKindValue = formatMetadataCardKind(displayBlock.card_kind);

  return (
    <>
      {hoverPreviewPosition && hoveredRelatedNoteBlock && (
        <div
          ref={hoverPreviewRef}
          className="pointer-events-none fixed z-40"
          style={{
            top: hoverPreviewPosition.top,
            left: hoverPreviewPosition.left,
            width: HOVER_CARD_WIDTH,
          }}
          data-related-note-hover-preview
        >
          <ReadOnlyCardPreview
            block={hoveredRelatedNoteBlock}
            vaultPath={vaultPath}
            thumbsRootPath={resolvedThumbsRoot}
            width={HOVER_CARD_WIDTH}
          />
        </div>
      )}
      <div className="min-w-0 overflow-x-hidden">
        <ArticleAudioControls
          slug={displayBlock.slug}
          blockType={displayBlock.card_kind === "article" ? "article" : displayBlock.card_kind}
          url={displayBlock.url}
        />

        <div className="flex min-w-0 flex-col gap-6" data-metadata-sections>
          <section
            className="min-w-0 overflow-hidden rounded-1 border border-border bg-accent"
            data-detail-metadata-card
          >
            <div className="px-2 pb-4 pt-4" data-detail-metadata-card-content>
              <MetadataTable>
                {displayBlock.width != null && displayBlock.height != null && (
                  <MetadataField
                    label="Resolution"
                    value={`${displayBlock.width} \u00d7 ${displayBlock.height}`}
                  />
                )}
                <MetadataField label="Date" value={formattedDate} />
                <MetadataField label="Type" value={cardKindValue} />

                {indexWarning && (
                  <MetadataField
                    label="Warning"
                    value={formatIndexWarning(indexWarning)}
                    mode="wrap"
                  />
                )}

                {displayBlock.url && isSafeUrl(displayBlock.url) && (
                  <MetadataRow label="Source">
                    <MetadataLinkValue
                      value={domainFromUrl(displayBlock.url)}
                      onClick={() => openUrl(displayBlock.url!)}
                    />
                  </MetadataRow>
                )}

                {displayBlock.author && (
                  <MetadataField label="Author" value={displayBlock.author} />
                )}
              </MetadataTable>
            </div>

            <DetailActionRow
              block={displayBlock}
              tags={tags}
              currentTag={currentTag}
              onToggleTag={onToggleTag}
              onCreateAndAssign={onCreateAndAssign}
            />
          </section>

          {relatedNotes.length > 0 && (
            <RelatedNotesSection
              relatedNotes={relatedNotes}
              relatedNoteBlocks={relatedNoteBlocks}
              resolvedThumbsRoot={resolvedThumbsRoot}
              onOpenRelatedNote={onOpenRelatedNote}
              relatedNoteButtonRefs={relatedNoteButtonRefs}
              onRelatedNotePreviewEnter={openRelatedNotePreview}
              onRelatedNotePreviewLeave={requestCloseRelatedNotePreview}
            />
          )}
        </div>
      </div>
    </>
  );
}

const METADATA_LABEL_CLASSES = "whitespace-nowrap font-mono text-sm leading-4 text-muted-foreground";
const METADATA_VALUE_BASE_CLASSES = "block min-w-0 font-sans text-sm leading-4 text-foreground";
const RELATED_NOTE_ROW_SHELL_CLASSES =
  "w-full min-w-0 overflow-hidden rounded-1 border border-border bg-component-fill p-[3px] font-sans text-base";
const RELATED_NOTE_ROW_CONTENT_CLASSES = "flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden";

type MetadataValueMode = "truncate" | "wrap";

function MetadataTable({ children }: { children: ReactNode }) {
  return (
    <div
      className="w-full"
      data-metadata-table
    >
      {children}
    </div>
  );
}

interface MetadataRowProps {
  label: string;
  children: ReactNode;
}

function MetadataRow({
  label,
  children,
}: MetadataRowProps) {
  return (
    <div
      className="relative grid w-full grid-cols-[max-content_minmax(0,1fr)] items-start gap-x-4 pb-2 after:absolute after:bottom-1 after:left-0 after:right-0 after:border-t after:border-border last:pb-0 last:after:hidden"
      data-metadata-row
    >
      <div className={METADATA_LABEL_CLASSES}>
        {label}
      </div>
      <div className="min-w-0 text-right">{children}</div>
    </div>
  );
}

function MetadataField({
  label,
  value,
  mode = "truncate",
}: {
  label: string;
  value: string;
  mode?: MetadataValueMode;
}) {
  return (
    <MetadataRow label={label}>
      <MetadataTextValue value={value} mode={mode} />
    </MetadataRow>
  );
}

function MetadataTextValue({
  value,
  mode,
}: {
  value: string;
  mode: MetadataValueMode;
}) {
  const className = cn(
    METADATA_VALUE_BASE_CLASSES,
    mode === "truncate" ? "truncate" : "break-words [overflow-wrap:anywhere]",
  );

  return (
    <div className={className} title={mode === "truncate" ? value : undefined}>
      {value}
    </div>
  );
}

function MetadataLinkValue({
  value,
  onClick,
}: {
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(METADATA_VALUE_BASE_CLASSES, "w-full truncate text-right hover:underline")}
      title={value}
    >
      {value}
    </button>
  );
}

function DetailActionRow({
  block,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
}: {
  block: LightBlock | IndexedBlock;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
}) {
  const [connectOpen, setConnectOpen] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>(
    isIndexedBlock(block) ? block.tags : [],
  );

  useEffect(() => {
    if (isIndexedBlock(block)) {
      setSelectedTags(block.tags);
    }
  }, [block]);

  useEffect(() => {
    if (!connectOpen) return;
    let cancelled = false;
    void getBlock(block.slug).then((full) => {
      if (!cancelled) {
        setSelectedTags(full?.tags ?? (isIndexedBlock(block) ? block.tags : []));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [block, connectOpen]);

  return (
    <div className="flex min-w-0 items-center gap-2 px-2 pb-2" data-detail-action-row>
      {block.url && isSafeUrl(block.url) && (
        <Button
          type="button"
          variant="default"
          size="default"
          className="min-w-0 flex-1 bg-component-fill-inner"
          onClick={() => openUrl(block.url!)}
        >
          Source
          <ExternalLink className="size-3" />
        </Button>
      )}

      <DropdownMenu open={connectOpen} onOpenChange={setConnectOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="default"
            size="default"
            className="min-w-0 flex-1 bg-component-fill-inner"
          >
            Connect
            <Plus className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="flex w-64 max-h-80 flex-col overflow-hidden p-0" align="start">
          <CollectionPicker
            blockSlug={block.slug}
            selectedTags={selectedTags}
            tags={tags}
            currentTag={currentTag}
            onToggleTag={onToggleTag}
            onCreateAndAssign={onCreateAndAssign}
            stopKeyPropagation
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function RelatedNotesSection({
  relatedNotes,
  relatedNoteBlocks,
  resolvedThumbsRoot,
  onOpenRelatedNote,
  relatedNoteButtonRefs,
  onRelatedNotePreviewEnter,
  onRelatedNotePreviewLeave,
}: {
  relatedNotes: string[];
  relatedNoteBlocks: Map<string, IndexedBlock | null> | null;
  resolvedThumbsRoot: string;
  onOpenRelatedNote: (slug: string) => void;
  relatedNoteButtonRefs: { current: Map<string, HTMLButtonElement> };
  onRelatedNotePreviewEnter: (note: HoveredRelatedNote) => void;
  onRelatedNotePreviewLeave: () => void;
}) {
  return (
    <section className="flex flex-col gap-1" data-related-notes-block>
      <div className={METADATA_LABEL_CLASSES}>Related notes</div>
      <div className="flex min-w-0 flex-col gap-1" data-related-notes-list>
        {relatedNotes.map((slug, index) => {
          const baseSlug = baseRelatedNoteSlug(slug);
          const rowKey = `${index}:${slug}`;
          const relatedBlock = relatedNoteBlocks?.get(baseSlug) ?? null;
          const rowLabel = relatedBlock ? getFallbackLabel(relatedBlock) : baseSlug;

          if (!relatedBlock) {
            return (
              <div
                key={slug}
                className={cn(RELATED_NOTE_ROW_SHELL_CLASSES, "text-muted-foreground")}
                data-related-note-item="placeholder"
              >
                <div className={RELATED_NOTE_ROW_CONTENT_CLASSES}>
                  <div aria-hidden="true" className="size-8 shrink-0 overflow-hidden bg-component-fill" />
                  <span className="min-w-0 flex-1 truncate text-left leading-5">{rowLabel}</span>
                </div>
              </div>
            );
          }

          return (
            <button
              key={rowKey}
              type="button"
              onClick={() => onOpenRelatedNote(baseSlug)}
              className={cn(
                RELATED_NOTE_ROW_SHELL_CLASSES,
                "cursor-pointer text-left text-muted-foreground outline-0 outline-transparent hover:outline-1 hover:-outline-offset-1 hover:outline-component-fill-hover focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-component-fill-hover",
              )}
              ref={(node) => {
                if (node) {
                  relatedNoteButtonRefs.current.set(rowKey, node);
                } else {
                  relatedNoteButtonRefs.current.delete(rowKey);
                }
              }}
              onMouseEnter={() => onRelatedNotePreviewEnter({ rowKey, slug: baseSlug })}
              onMouseLeave={onRelatedNotePreviewLeave}
              data-related-note-item="button"
            >
              <div className={RELATED_NOTE_ROW_CONTENT_CLASSES}>
                <div aria-hidden="true" className="size-8 shrink-0 overflow-hidden bg-component-fill">
                  <MicroPreviewThumbnail
                    preview={microPreviewFromIndexedBlock(relatedBlock, resolvedThumbsRoot)}
                    loading="lazy"
                    draggable={false}
                    onError={(event) => {
                      event.currentTarget.style.display = "none";
                    }}
                  />
                </div>
                <span className="min-w-0 flex-1 truncate text-left leading-5">{rowLabel}</span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function formatMetadataCardKind(cardKind: LightBlock["card_kind"] | IndexedBlock["card_kind"]): string {
  return cardKind.charAt(0).toUpperCase() + cardKind.slice(1);
}

function getIndexWarning(block: LightBlock | IndexedBlock): string | null {
  return "index_warning" in block ? block.index_warning ?? null : null;
}

function baseRelatedNoteSlug(target: string): string {
  return target.split("#", 1)[0] ?? target;
}

function computeHoverPreviewPosition(
  triggerRect: DOMRect,
  previewHeight: number,
): HoverPreviewPosition {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const canOpenRight =
    viewportWidth - triggerRect.right - HOVER_CARD_GAP - HOVER_CARD_VIEWPORT_MARGIN >=
    HOVER_CARD_WIDTH;
  const left = canOpenRight
    ? triggerRect.right + HOVER_CARD_GAP
    : Math.max(
        HOVER_CARD_VIEWPORT_MARGIN,
        triggerRect.left - HOVER_CARD_GAP - HOVER_CARD_WIDTH,
      );
  const canOpenDown =
    triggerRect.top + previewHeight <=
    viewportHeight - HOVER_CARD_VIEWPORT_MARGIN;
  const top = canOpenDown
    ? Math.max(HOVER_CARD_VIEWPORT_MARGIN, triggerRect.top)
    : Math.max(
        HOVER_CARD_VIEWPORT_MARGIN,
        triggerRect.bottom - previewHeight,
      );
  return {
    top,
    left,
  };
}

function formatIndexWarning(warning: string): string {
  switch (warning) {
    case "malformed_frontmatter":
      return "Malformed frontmatter, shown as Markdown";
    case "unknown_type":
      return "Unknown type, shown as article";
    case "invalid_saved_at":
      return "Invalid date, using file date";
    case "unsupported_tag_shape":
      return "Some tags ignored";
    default:
      return warning.replaceAll("_", " ");
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function youtubeEmbedUrl(url: string): string | null {
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/);
  return match ? `https://www.youtube.com/embed/${match[1]}` : null;
}

function resolveDetailMediaReference(vaultPath: string, src: string | null): string | null {
  if (!src) return null;
  return isSafeUrl(src) ? src : mediaUrl(vaultPath, src);
}

function detailPreviewImageSource({
  block,
  previewManifest,
  vaultPath,
  thumbsRootPath,
}: {
  block: LightBlock | IndexedBlock;
  previewManifest: ReturnType<typeof normalizeFeedPreviewManifest>;
  vaultPath: string;
  thumbsRootPath: string;
}): string {
  return resolveDetailMediaReference(vaultPath, block.media_file)
    ?? (previewManifest?.primaryPreviewPath
      ? previewAssetUrl(thumbsRootPath, previewManifest.primaryPreviewPath)
      : null)
    ?? resolveDetailMediaReference(vaultPath, block.thumbnail)
    ?? thumbnailUrl(thumbsRootPath, block.slug);
}

// ─── Block content renderers ────────────────────────────────────────────────

function BlockContent({
  block,
  fullBlock,
  scrollAnchor,
  vaultPath,
  thumbsRootPath,
  onTextSelectionDrop,
}: {
  block: LightBlock | IndexedBlock;
  fullBlock: IndexedBlock | null;
  scrollAnchor?: string | null;
  vaultPath: string;
  thumbsRootPath?: string;
  onTextSelectionDrop?: (payload: MineTextSelectionDragPayload, tag: string) => void;
}) {
  const resolvedThumbsRoot = thumbsRootPath ?? legacyThumbsRoot(vaultPath);
  const previewManifest = useMemo(
    () => normalizeFeedPreviewManifest((fullBlock ?? block).preview_manifest),
    [block, fullBlock],
  );
  const descriptor = useMemo(
    () => deriveCardLayoutDescriptor(fullBlock ?? block),
    [block, fullBlock],
  );
  // Lazy-load full body if truncated (LightBlock carries only a short preview).
  const [fullBody, setFullBody] = useState<string | null>(fullBlock?.body ?? null);
  useEffect(() => {
    setFullBody(fullBlock?.body ?? null);
    if (fullBlock) {
      return;
    }
    if (block.body.length >= 218) {
      getBlock(block.slug).then((full) => {
        if (full) setFullBody(full.body);
      });
    }
  }, [block.slug, block.body.length, fullBlock]);

  const body = fullBody ?? block.body;
  const description = "description" in block ? (block as IndexedBlock).description : null;
  const displayTitle = getDisplayTitle(block);
  const navigationLabel = getNavigationLabel(block);

  switch (block.card_kind) {
    case "article": {
      return (
        <div>
          <ArticleBody
            body={body}
            vaultPath={vaultPath}
            thumbsRootPath={resolvedThumbsRoot}
            previewManifest={previewManifest}
            sourceSlug={block.slug}
            sourceBodyHash={fullBlock?.body_hash ?? (isIndexedBlock(block) ? block.body_hash : null)}
            scrollAnchor={scrollAnchor}
            onTextSelectionDrop={onTextSelectionDrop}
          />
        </div>
      );
    }

    case "channel": {
      if (body.trim()) {
        return (
          <div>
            <ArticleBody
              body={body}
              vaultPath={vaultPath}
              thumbsRootPath={resolvedThumbsRoot}
              previewManifest={previewManifest}
              sourceSlug={block.slug}
              sourceBodyHash={fullBlock?.body_hash ?? (isIndexedBlock(block) ? block.body_hash : null)}
              scrollAnchor={scrollAnchor}
              onTextSelectionDrop={onTextSelectionDrop}
            />
          </div>
        );
      }
      return (
        <div className="flex min-h-full items-center justify-center">
          <h2 className="text-lg font-semibold text-foreground">
            {displayTitle ?? navigationLabel}
          </h2>
        </div>
      );
    }

    case "media": {
      if (descriptor.variant === "image") {
        const src = detailPreviewImageSource({
          block,
          previewManifest,
          vaultPath,
          thumbsRootPath: resolvedThumbsRoot,
        });
        return (
          <div className="flex min-h-full items-center justify-center">
            <img
              src={src}
              alt={navigationLabel}
              className="max-h-[85vh] object-contain"
              draggable={false}
            />
          </div>
        );
      }

      if (descriptor.variant === "link") {
        const src = detailPreviewImageSource({
          block,
          previewManifest,
          vaultPath,
          thumbsRootPath: resolvedThumbsRoot,
        });
        return (
          <div>
            <div className="aspect-video bg-accent">
              <img
                src={src}
                alt=""
                className="h-full w-full object-contain"
                draggable={false}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            </div>
            <div className="py-4">
              {displayTitle && (
                <h2 className="text-lg font-semibold text-foreground">
                  {displayTitle}
                </h2>
              )}
              {description && (
                <p className="mt-2 text-base text-muted-foreground">
                  {description}
                </p>
              )}
            </div>
          </div>
        );
      }

      if (descriptor.variant === "video") {
        const embedUrl = block.url ? youtubeEmbedUrl(block.url) : null;
        const videoSourcePath =
          descriptor.mediaItems.find((item) => item.isVideo)?.sourcePath ??
          null;
        const localSrc = resolveDetailMediaReference(vaultPath, videoSourcePath);
        return (
          <div className="flex min-h-full flex-col">
            <div className="flex flex-1 items-center justify-center bg-black">
              {embedUrl ? (
                <iframe
                  src={embedUrl}
                  className="aspect-video w-full max-h-[85vh]"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              ) : localSrc ? (
                <video controls className="max-h-[85vh]" draggable={false}>
                  <source src={localSrc} />
                </video>
              ) : (
                <div className="flex aspect-video items-center justify-center text-muted-foreground">
                  No video file
                </div>
              )}
            </div>
            {body && (
              <div className="p-6">
                <ArticleBody
                  body={body}
                  vaultPath={vaultPath}
                  thumbsRootPath={resolvedThumbsRoot}
                  previewManifest={previewManifest}
                />
              </div>
            )}
          </div>
        );
      }

      return (
        <div className="flex min-h-full flex-col items-center justify-center gap-3">
          <div className="flex h-16 w-16 items-center justify-center rounded-1 bg-accent text-lg font-semibold text-muted-foreground">
            {block.media_file?.split(".").pop()?.toUpperCase() ?? "FILE"}
          </div>
          <p className="text-base font-semibold text-foreground">
            {displayTitle ?? navigationLabel}
          </p>
          {block.media_file && (
            <p className="text-sm text-muted-foreground">{block.media_file}</p>
          )}
        </div>
      );
    }
  }
}

// ─── Markdown renderer for article body ─────────────────────────────────────

function ArticleBody({
  body,
  vaultPath,
  thumbsRootPath,
  previewManifest,
  sourceSlug,
  sourceBodyHash,
  scrollAnchor,
  onTextSelectionDrop,
}: {
  body: string;
  vaultPath: string;
  thumbsRootPath: string;
  previewManifest: ReturnType<typeof normalizeFeedPreviewManifest>;
  sourceSlug?: string;
  sourceBodyHash?: string | null;
  scrollAnchor?: string | null;
  onTextSelectionDrop?: (payload: MineTextSelectionDragPayload, tag: string) => void;
}) {
  const articleRef = useRef<HTMLDivElement | null>(null);
  const selectionFrameRef = useRef<number | null>(null);
  const selectionHandleLockedRef = useRef(false);
  const [selectionHandle, setSelectionHandle] = useState<TextSelectionHandleState | null>(null);

  const buildTextSelectionDragPayload = useCallback((dragTarget: Node | null): MineTextSelectionDragPayload | null => {
    if (!sourceSlug || !sourceBodyHash || !articleRef.current) {
      return null;
    }
    const root = articleRef.current;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selectionIntersectsNode(selection, root)) {
      return null;
    }
    if (dragTarget && root.contains(dragTarget) && !selectionIntersectsNode(selection, dragTarget)) {
      return null;
    }
    const selectedText = selection.toString().trim();
    if (!selectedText) {
      return null;
    }
    const range = findFirstSelectedMarkdownBlockRange(root, selection)
      ?? findFirstMarkdownBlockRange(body, selectedText);
    if (!range) {
      return null;
    }
    return {
      type: "text_selection",
      sourceSlug,
      selectedText,
      firstBlockStart: range.start,
      firstBlockEnd: range.end,
      sourceBodyHash,
    };
  }, [body, sourceBodyHash, sourceSlug]);

  const updateTextSelectionHandle = useCallback(() => {
    if (selectionHandleLockedRef.current) {
      return;
    }
    if (!onTextSelectionDrop || !articleRef.current) {
      setSelectionHandle(null);
      return;
    }
    const root = articleRef.current;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selectionIntersectsNode(selection, root)) {
      setSelectionHandle(null);
      return;
    }
    const payload = buildTextSelectionDragPayload(null);
    const rect = firstSelectionClientRect(selection)
      ?? firstSelectedMarkdownBlockElement(root, selection)?.getBoundingClientRect();
    if (!payload || !rect || rect.width === 0 && rect.height === 0) {
      setSelectionHandle(null);
      return;
    }
    const rootRect = root.getBoundingClientRect();
    setSelectionHandle({
      payload,
      left: Math.max(8, Math.min(rect.left - 34, rootRect.left - 34)),
      top: Math.max(36, rect.top + Math.min(rect.height / 2, 18) - 14),
    });
  }, [buildTextSelectionDragPayload, onTextSelectionDrop]);

  const scheduleTextSelectionHandleUpdate = useCallback(() => {
    if (selectionFrameRef.current != null) {
      window.cancelAnimationFrame(selectionFrameRef.current);
    }
    selectionFrameRef.current = window.requestAnimationFrame(() => {
      selectionFrameRef.current = null;
      updateTextSelectionHandle();
    });
  }, [updateTextSelectionHandle]);

  const unlockTextSelectionHandle = useCallback(() => {
    selectionHandleLockedRef.current = false;
    window.removeEventListener("pointerup", unlockTextSelectionHandle, true);
    window.removeEventListener("pointercancel", unlockTextSelectionHandle, true);
    scheduleTextSelectionHandleUpdate();
  }, [scheduleTextSelectionHandleUpdate]);

  const lockTextSelectionHandle = useCallback(() => {
    selectionHandleLockedRef.current = true;
    window.addEventListener("pointerup", unlockTextSelectionHandle, true);
    window.addEventListener("pointercancel", unlockTextSelectionHandle, true);
  }, [unlockTextSelectionHandle]);

  useEffect(() => {
    if (!onTextSelectionDrop) {
      setSelectionHandle(null);
      return undefined;
    }
    document.addEventListener("selectionchange", scheduleTextSelectionHandleUpdate);
    window.addEventListener("resize", scheduleTextSelectionHandleUpdate);
    window.addEventListener("scroll", scheduleTextSelectionHandleUpdate, true);
    return () => {
      document.removeEventListener("selectionchange", scheduleTextSelectionHandleUpdate);
      window.removeEventListener("resize", scheduleTextSelectionHandleUpdate);
      window.removeEventListener("scroll", scheduleTextSelectionHandleUpdate, true);
      if (selectionFrameRef.current != null) {
        window.cancelAnimationFrame(selectionFrameRef.current);
        selectionFrameRef.current = null;
      }
    };
  }, [onTextSelectionDrop, scheduleTextSelectionHandleUpdate]);

  // Phase 18.H.2: rewrite Obsidian wikilinks into standard markdown
  // before passing to react-markdown. The raw `.md` file stays in
  // wikilink form for Obsidian; only the render pipeline sees the
  // transformed markdown.
  const processedBody = useMemo(() => preprocessWikilinks(body), [body]);

  useEffect(() => {
    if (!scrollAnchor || !articleRef.current) return;
    const root = articleRef.current;
    const frame = window.requestAnimationFrame(() => {
      const element = findElementForBlockAnchor(root, scrollAnchor);
      if (!element) return;
      element.scrollIntoView?.({ block: "center", behavior: "smooth" });
      element.setAttribute("data-scroll-anchor-hit", "true");
      window.setTimeout(() => {
        element.removeAttribute("data-scroll-anchor-hit");
      }, 1400);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [processedBody, scrollAnchor]);

  const components: Components = useMemo(
    () => ({
      p: ({ node, ...props }) => (
        paragraphContainsBlockMedia(node) ? (
          <div
            {...markdownBlockPositionProps(node)}
            {...props}
            className={cn("my-5 leading-5", props.className)}
          />
        ) : (
          <p {...markdownBlockPositionProps(node)} {...props} />
        )
      ),
      li: ({ node, ...props }) => (
        <li {...markdownBlockPositionProps(node)} {...props} />
      ),
      blockquote: ({ node, ...props }) => (
        <blockquote {...markdownBlockPositionProps(node)} {...props} />
      ),
      h1: ({ node, ...props }) => (
        <h1
          {...markdownBlockPositionProps(node)}
          {...props}
          className={cn(ARTICLE_H1_CLASSES, props.className)}
        />
      ),
      h2: ({ node, ...props }) => (
        <h2
          {...markdownBlockPositionProps(node)}
          {...props}
          className={cn(ARTICLE_SECTION_HEADING_CLASSES, props.className)}
        />
      ),
      h3: ({ node, ...props }) => (
        <h3
          {...markdownBlockPositionProps(node)}
          {...props}
          className={cn(ARTICLE_SECTION_HEADING_CLASSES, props.className)}
        />
      ),
      h4: ({ node, ...props }) => (
        <h4
          {...markdownBlockPositionProps(node)}
          {...props}
          className={cn(ARTICLE_SECTION_HEADING_CLASSES, props.className)}
        />
      ),
      h5: ({ node, ...props }) => (
        <h5
          {...markdownBlockPositionProps(node)}
          {...props}
          className={cn(ARTICLE_SECTION_HEADING_CLASSES, props.className)}
        />
      ),
      h6: ({ node, ...props }) => (
        <h6
          {...markdownBlockPositionProps(node)}
          {...props}
          className={cn(ARTICLE_SECTION_HEADING_CLASSES, props.className)}
        />
      ),
      img: ({ src, alt, ...props }) => {
        const decodedSrc = decodeLocalMarkdownUrl(src ?? "");
        const previewTile = findPreviewTileForSource(previewManifest, decodedSrc);
        const resolvedSrc = previewTile?.sourcePath ?? decodedSrc;
        const originalSrc = resolveImageSrc(resolvedSrc, vaultPath);
        // Video/GIF (downloaded MP4) — render as inline autoplay video with controls.
        // Autoplay must stay muted to satisfy browser/WebView media policies.
        if (/\.mp4(\?|$)|\.webm(\?|$)/i.test(decodedSrc)) {
          return (
            <VideoFromBlob
              src={originalSrc}
              controls
              autoPlay
              muted
              loop
              className="rounded-0"
            />
          );
        }
        const previewSrc = previewTile?.previewPath
          ? previewAssetUrl(thumbsRootPath, previewTile.previewPath)
          : null;
        const extraction = sourceSlug && isExtractableLocalImage(decodedSrc)
          ? {
              sourceSlug,
              mediaRef: decodedSrc,
            }
          : null;
        return (
          <DetailImage
            src={originalSrc}
            previewSrc={previewSrc}
            alt={alt ?? ""}
            extraction={extraction}
            className="rounded-0"
            {...props}
          />
        );
      },
      a: ({ href, children, ...props }) => (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          {...props}
        >
          {children}
        </a>
      ),
    }),
    [previewManifest, sourceSlug, thumbsRootPath, vaultPath],
  );

  return (
    <div
      ref={articleRef}
      onMouseUp={scheduleTextSelectionHandleUpdate}
      onKeyUp={scheduleTextSelectionHandleUpdate}
      className="prose prose-sm max-w-none [&>:first-child]:mt-0 [&_li]:leading-5 [&_p]:leading-5"
      data-article-body
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {processedBody}
      </ReactMarkdown>
      {selectionHandle && (
        <TextSelectionDragHandle
          state={selectionHandle}
          onInteractionStart={lockTextSelectionHandle}
        />
      )}
    </div>
  );
}

type TextSelectionHandleState = {
  payload: MineTextSelectionDragPayload;
  left: number;
  top: number;
};

function TextSelectionDragHandle({
  state,
  onInteractionStart,
}: {
  state: TextSelectionHandleState;
  onInteractionStart: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
  } = useDraggable({
    id: `text-selection:${state.payload.sourceSlug}`,
    data: state.payload,
  });
  const pointerListener = (listeners as {
    onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  } | undefined)?.onPointerDown;

  const style: CSSProperties = {
    left: state.left,
    top: state.top,
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
  };

  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      onPointerDown={(event) => {
        setActiveMineTextSelectionDragPayload(state.payload);
        onInteractionStart();
        pointerListener?.(event);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      className={cn(
        "fixed z-50 flex size-7 items-center justify-center rounded-1 border border-border bg-background text-muted-foreground shadow-sm",
        "cursor-grab active:cursor-grabbing hover:bg-accent hover:text-foreground",
        isDragging && "opacity-0",
      )}
      style={style}
      aria-label="Drag selected text to a collection"
      title="Drag selected text to a collection"
    >
      <GripVertical className="size-4" aria-hidden="true" />
    </button>
  );
}

function DetailImage({
  src,
  previewSrc,
  alt,
  extraction,
  className,
  ...imgProps
}: {
  src: string;
  previewSrc: string | null;
  alt: string;
  extraction: DetailInlineMediaExtraction | null;
} & React.ImgHTMLAttributes<HTMLImageElement>) {
  const [originalReady, setOriginalReady] = useState(false);
  const {
    attributes: dragAttributes,
    listeners: dragListeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: extraction
      ? `inline-media:${extraction.sourceSlug}:${extraction.mediaRef}`
      : `inline-media-disabled:${src}`,
    disabled: extraction === null,
    data: extraction
      ? {
          type: "inline_media",
          sourceSlug: extraction.sourceSlug,
          mediaRef: extraction.mediaRef,
          mediaKind: "image",
          imageSrc: previewSrc ?? src,
        }
      : undefined,
  });

  useEffect(() => {
    setOriginalReady(false);
  }, [src]);

  const dragPointerListener = (dragListeners as {
    onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  } | undefined)?.onPointerDown;

  return (
    <div
      ref={setDragRef}
      {...(extraction ? dragAttributes : {})}
      {...(extraction ? dragListeners : {})}
      draggable={extraction ? false : undefined}
      data-detail-inline-media-drag={extraction ? "true" : undefined}
      onPointerDown={(event) => {
        if (!extraction) {
          return;
        }
        dragPointerListener?.(event);
        event.preventDefault();
        window.getSelection()?.removeAllRanges();
      }}
      onMouseDown={(event) => {
        if (extraction) {
          event.preventDefault();
        }
      }}
      onDragStart={(event) => {
        if (extraction) {
          event.preventDefault();
        }
      }}
      className={cn(
        "relative overflow-hidden",
        extraction && "cursor-grab select-none active:cursor-grabbing",
        isDragging && "opacity-40",
      )}
    >
      {previewSrc && !originalReady && (
        <img
          src={previewSrc}
          alt=""
          className={cn("rounded-0", className)}
          loading="eager"
          draggable={false}
          aria-hidden="true"
        />
      )}
      <img
        src={src}
        alt={alt}
        className={cn("rounded-0", className, previewSrc && !originalReady && "absolute inset-0")}
        loading="lazy"
        draggable={false}
        {...imgProps}
        onLoad={() => setOriginalReady(true)}
        onError={(e) => {
          if (!previewSrc) {
            (e.target as HTMLImageElement).style.display = "none";
          }
        }}
        style={previewSrc && !originalReady ? { opacity: 0 } : undefined}
      />
    </div>
  );
}

/** Resolve a markdown image src to an asset URL. */
function resolveImageSrc(src: string, vaultPath: string): string {
  if (src.startsWith("http://") || src.startsWith("https://")) {
    return src;
  }
  return mediaUrl(vaultPath, src);
}

function findElementForBlockAnchor(root: HTMLElement, blockId: string): HTMLElement | null {
  const marker = `^${blockId}`;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.textContent?.includes(marker)) {
      const parent = node.parentElement;
      return parent?.closest<HTMLElement>("p, li, blockquote, h1, h2, h3, h4, h5, h6") ?? parent ?? null;
    }
    node = walker.nextNode();
  }
  return null;
}

function isExtractableLocalImage(src: string): boolean {
  if (src.startsWith("http://") || src.startsWith("https://")) {
    return false;
  }
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(src);
}

function selectionIntersectsNode(selection: Selection, node: Node): boolean {
  for (let i = 0; i < selection.rangeCount; i += 1) {
    const range = selection.getRangeAt(i);
    try {
      if (range.intersectsNode(node)) {
        return true;
      }
    } catch {
      if (node.contains(range.commonAncestorContainer)) {
        return true;
      }
    }
  }
  return false;
}

function firstSelectedMarkdownBlockElement(root: HTMLElement, selection: Selection): HTMLElement | null {
  const blocks = root.querySelectorAll<HTMLElement>("[data-mine-md-start][data-mine-md-end]");
  for (const block of Array.from(blocks)) {
    if (selectionIntersectsNode(selection, block)) {
      return block;
    }
  }
  return null;
}

function findFirstSelectedMarkdownBlockRange(
  root: HTMLElement,
  selection: Selection,
): { start: number; end: number } | null {
  const block = firstSelectedMarkdownBlockElement(root, selection);
  if (!block) return null;
  const start = Number(block.dataset.mineMdStart);
  const end = Number(block.dataset.mineMdEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  return { start, end };
}

function firstSelectionClientRect(selection: Selection): DOMRect | null {
  for (let i = 0; i < selection.rangeCount; i += 1) {
    const range = selection.getRangeAt(i);
    const rect = Array.from(range.getClientRects())
      .find((item) => item.width > 0 || item.height > 0);
    if (rect) {
      return rect as DOMRect;
    }
  }
  return null;
}

function shouldIgnoreDetailEscape(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return true;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  if (
    target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || target.isContentEditable
  ) {
    return true;
  }
  return !!target.closest(
    "[data-radix-popper-content-wrapper], [role='menu'], [role='listbox']",
  );
}

type MarkdownPositionedNode = {
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
};

type MarkdownElementNode = {
  type?: string;
  tagName?: string;
  children?: MarkdownElementNode[];
};

function paragraphContainsBlockMedia(node: unknown): boolean {
  const element = node as MarkdownElementNode | undefined;
  return (element?.children ?? []).some((child) => {
    if (child.type !== "element") return false;
    return child.tagName === "img" || child.tagName === "video";
  });
}

function markdownBlockPositionProps(
  node: unknown,
): { "data-mine-md-start"?: string; "data-mine-md-end"?: string } {
  const positioned = node as MarkdownPositionedNode | undefined;
  const start = positioned?.position?.start?.offset;
  const end = positioned?.position?.end?.offset;
  if (
    typeof start !== "number"
    || typeof end !== "number"
    || !Number.isFinite(start)
    || !Number.isFinite(end)
    || end <= start
  ) {
    return {};
  }
  return {
    "data-mine-md-start": String(start),
    "data-mine-md-end": String(end),
  };
}

function findFirstMarkdownBlockRange(
  body: string,
  selectedText: string,
): { start: number; end: number } | null {
  const selectionStart = body.indexOf(selectedText);
  const start = selectionStart >= 0
    ? selectionStart
    : findNormalizedSelectionStart(body, selectedText);
  if (start == null || start < 0) {
    return null;
  }
  return markdownBlockRangeContaining(body, start);
}

function findNormalizedSelectionStart(body: string, selectedText: string): number | null {
  const needle = collapseWhitespace(selectedText.trim());
  if (!needle) return null;
  const normalized = normalizeWithSourceIndices(body);
  const index = normalized.text.indexOf(needle);
  if (index < 0) return null;
  return normalized.indices[index] ?? null;
}

function normalizeWithSourceIndices(value: string): { text: string; indices: number[] } {
  let text = "";
  const indices: number[] = [];
  let inSpace = false;
  for (let offset = 0; offset < value.length;) {
    const codePoint = value.codePointAt(offset);
    if (codePoint == null) break;
    const char = String.fromCodePoint(codePoint);
    const nextOffset = offset + char.length;
    if (/\s/.test(char)) {
      if (!inSpace && text.length > 0) {
        text += " ";
        indices.push(offset);
      }
      inSpace = true;
    } else {
      text += char;
      indices.push(offset);
      inSpace = false;
    }
    offset = nextOffset;
  }
  return { text: text.trimEnd(), indices };
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function markdownBlockRangeContaining(body: string, index: number): { start: number; end: number } {
  let start = body.lastIndexOf("\n\n", index);
  start = start >= 0 ? start + 2 : 0;
  let end = body.indexOf("\n\n", index);
  end = end >= 0 ? end : body.length;
  while (start < end && (body[start] === "\n" || body[start] === "\r")) {
    start += 1;
  }
  while (end > start && (body[end - 1] === "\n" || body[end - 1] === "\r")) {
    end -= 1;
  }
  return { start, end };
}
