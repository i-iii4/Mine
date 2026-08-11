import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useDraggable } from "@dnd-kit/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import {
  Expand,
  ExternalLink,
  GripVertical,
  MoreHorizontal,
  Plus,
  Trash2,
  Unlink,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChromeCloseButton } from "@/components/ChromeCloseButton";
import {
  MetadataRow,
  MetadataLinkValue,
  formatMetadataCardKind,
  METADATA_LABEL_CLASSES,
  METADATA_VALUE_BASE_CLASSES,
} from "@/components/MetadataRow";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type {
  DeleteMediaAssetPlan,
  IndexedBlock,
  LightBlock,
  MediaAssetRef,
  TagCount,
} from "@/types";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { preprocessWikilinks, inlineMediaOccurrenceIndex } from "@/lib/markdownWikilinks";
import { decodeLocalMarkdownUrl } from "@/lib/markdownWikilinks";
import {
  thumbnailUrl,
  mediaUrl,
  previewAssetUrl,
  domainFromUrl,
  isSafeUrl,
  fallbackThumbsRoot,
} from "@/lib/assets";
import { safeMarkdownUrl } from "@/lib/markdownUrl";
import { cn } from "@/lib/utils";
import { useTopFadeMask } from "@/hooks/useTopFadeMask";
import { TopFadeScrim } from "./TopFadeScrim";
import { getDisplayTitle, getFallbackLabel, getNavigationLabel } from "@/lib/displayTitle";
import { copyMediaAssetToClipboard, getBlock, prepareDeleteMediaAsset } from "@/lib/commands";
import { collectionRefLabel } from "@/lib/collections";
import { getHoverPreviewOpenDelay } from "@/lib/hoverPreviewTiming";
import {
  findPreviewTileForSource,
  normalizeDetailPreviewManifest,
} from "@/lib/feedPreview";
import { deriveCardLayoutDescriptor } from "@/lib/cardLayout";
import {
  setActiveMineTextSelectionDragPayload,
  type MineTextSelectionDragPayload,
} from "@/lib/textSelectionDrag";
import {
  placeTextSelectionActionBar,
  TEXT_SELECTION_ACTION_BAR_HEIGHT_PX,
  TEXT_SELECTION_ACTION_BAR_VIEWPORT_MARGIN_PX,
  type TextSelectionAnchorRect,
  type TextSelectionSafeBounds,
} from "@/lib/textSelectionActionBarPlacement";
import { VideoFromBlob } from "./VideoFromBlob";
import { ArticleAudioControls } from "./ArticleAudioControls";
import { CardMoreMenu } from "./CardHoverMenu";
import { MenuIconSlot } from "@/components/ui/menu-icon-slot";
import {
  CARD_REFERENCE_ROW_ESTIMATED_HEIGHT_PX,
  CARD_REFERENCE_ROW_GAP_PX,
  CardReferenceButton,
  CardReferenceRow,
} from "./CardReferenceRow";
import { ReadOnlyCardPreview } from "./Card";
import {
  COLLECTION_PICKER_CONTENT_CLASS,
  CollectionPicker,
} from "./CollectionPicker";
import { QuantizedMenuScrollArea } from "./QuantizedMenuScrollArea";
import { SearchMenuInput } from "./SearchMenuInput";
import { microPreviewFromIndexedBlock } from "./MicroPreviewThumbnail";
import type { ImagePreviewRequest, ImagePreviewSibling } from "./ImagePreviewOverlay";
import { copyTextToClipboard } from "@/lib/clipboard";

// Layout constants shared by scroll content and fixed metadata. The rail is
// anchored to the right edge with a fixed 20rem inspector width, while the
// article/media column is centered in the remaining space to its left.
// Side columns, the gap between article and rail, and the top offset all follow
// the app-wide edge rhythm.
const DETAIL_RAIL_LAYOUT_CLASSES =
  "grid w-full grid-cols-[minmax(var(--edge-rhythm,32px),1fr)_minmax(400px,48rem)_minmax(var(--edge-rhythm,32px),1fr)_20rem_var(--edge-rhythm,32px)] pt-[var(--edge-rhythm,32px)]";
const DETAIL_STACKED_LAYOUT_CLASSES =
  "grid w-full grid-cols-[var(--edge-rhythm,32px)_minmax(240px,1fr)_var(--edge-rhythm,32px)] pt-[var(--edge-rhythm,32px)]";
const DETAIL_MIN_ARTICLE_WIDTH_PX = 400;
const DETAIL_FIXED_RAIL_WIDTH_PX = 320;
const DETAIL_GRID_INSET_WIDTH_PX = 32;
const DETAIL_METADATA_CARD_MIN_WIDTH_PX = 240;
const DETAIL_STACKED_BREAKPOINT_PX =
  DETAIL_MIN_ARTICLE_WIDTH_PX +
  DETAIL_FIXED_RAIL_WIDTH_PX +
  DETAIL_GRID_INSET_WIDTH_PX * 3;
const DETAIL_BOTTOM_SAFE_SPACE_CLASS = "pb-20";
const HOVER_CARD_WIDTH = 240;
const HOVER_CARD_FALLBACK_HEIGHT = 320;
const HOVER_CARD_GAP = 8;
const HOVER_CARD_VIEWPORT_MARGIN = 16;
const TEXT_SELECTION_ACTION_BAR_FALLBACK_WIDTH_PX = 296;
const ARTICLE_H1_CLASSES = "mt-0 mb-4 text-lg leading-6 font-semibold";
const ARTICLE_SECTION_HEADING_CLASSES = "mt-6 mb-2 text-base leading-5 font-semibold";

interface DetailProps {
  block: LightBlock | IndexedBlock;
  scrollAnchor?: string | null;
  vaultPath: string;
  thumbsRootPath?: string;
  isClosing?: boolean;
  topChromeMode?: "classic" | "external";
  onClose: () => void;
  onNavigate: (direction: "prev" | "next" | "up" | "down") => void;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onTagsChanged: () => void;
  onRequestRename: (block: LightBlock | IndexedBlock) => void;
  onRequestDelete: (slug: string) => void;
  onCreateMediaAssetCard?: (asset: MediaAssetRef, tag: string) => Promise<void>;
  onCreateChannelAndMediaAssetCard?: (asset: MediaAssetRef, tag: string) => Promise<void>;
  onRenameMediaAsset?: (asset: MediaAssetRef, newStem: string) => Promise<void>;
  onRemoveMediaAssetFromCard?: (asset: MediaAssetRef) => Promise<void>;
  onDeleteMediaAsset?: (asset: MediaAssetRef) => Promise<void>;
  onOpenImagePreview?: (preview: ImagePreviewRequest) => void;
  onOpenRelatedNote: (slug: string) => void;
  onTextSelectionDrop?: (payload: MineTextSelectionDragPayload, tag: string) => void;
  onCreateChannelAndTextSelectionCard?: (
    payload: MineTextSelectionDragPayload,
    tag: string,
  ) => Promise<void>;
  onTextSelectionDelete?: (payload: MineTextSelectionDragPayload) => void | Promise<void>;
  /** Dissolve content into transparency as it scrolls up under the top menu. */
  scrollEdgeFade?: boolean;
}

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

const noopMediaAssetConnect = async (_asset: MediaAssetRef, _tag: string) => {};
const noopMediaAssetRename = async (_asset: MediaAssetRef, _newStem: string) => {};
const noopMediaAssetDelete = async (_asset: MediaAssetRef) => {};
const noopTextSelectionCreate = async (_payload: MineTextSelectionDragPayload, _tag: string) => {};
const noopOpenImagePreview = (_preview: ImagePreviewRequest) => {};

/// Collect every image of the card that `origin` belongs to, in reading order.
///
/// Read from the rendered card rather than from a prepared list: the body is
/// Markdown turned into elements, so document order *is* reading order, and no
/// separate index can be more authoritative than what the reader sees. Frames
/// without a loaded image are skipped — the viewer has nothing to show for them.
function collectCardImages(origin: HTMLElement | null): ImagePreviewSibling[] {
  const column = origin?.closest("[data-detail-article-column]");
  if (!column) return [];
  const found: ImagePreviewSibling[] = [];
  for (const frame of column.querySelectorAll<HTMLElement>("[data-media-asset-ref]")) {
    const mediaRef = frame.dataset.mediaAssetRef;
    const src = frame.querySelector("img")?.getAttribute("src");
    if (mediaRef && src) found.push({ src, mediaRef });
  }
  return found;
}

function getElementLayoutWidth(node: HTMLElement): number {
  const measuredWidth = node.getBoundingClientRect().width;
  if (measuredWidth > 0) return measuredWidth;
  return window.innerWidth;
}

function useDetailStackedLayout() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const updateWidth = () => {
      setContainerWidth(getElementLayoutWidth(node));
    };

    updateWidth();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver((entries) => {
        const entryWidth = entries[0]?.contentRect.width ?? 0;
        setContainerWidth(entryWidth > 0 ? entryWidth : getElementLayoutWidth(node));
      });
      observer.observe(node);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", updateWidth);
    return () => window.removeEventListener("resize", updateWidth);
  }, []);

  return {
    containerRef,
    isStackedLayout:
      containerWidth !== null && containerWidth < DETAIL_STACKED_BREAKPOINT_PX,
  };
}

export function Detail({
  block,
  scrollAnchor = null,
  vaultPath,
  thumbsRootPath,
  isClosing = false,
  topChromeMode = "classic",
  onClose,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
  onCreateMediaAssetCard = noopMediaAssetConnect,
  onCreateChannelAndMediaAssetCard = noopMediaAssetConnect,
  onRenameMediaAsset = noopMediaAssetRename,
  onRemoveMediaAssetFromCard = noopMediaAssetDelete,
  onDeleteMediaAsset = noopMediaAssetDelete,
  onOpenImagePreview = noopOpenImagePreview,
  onOpenRelatedNote,
  onTextSelectionDrop,
  onCreateChannelAndTextSelectionCard = noopTextSelectionCreate,
  onTextSelectionDelete,
  scrollEdgeFade = false,
}: DetailProps) {
  const [fullBlock, setFullBlock] = useState<IndexedBlock | null>(
    isIndexedBlock(block) ? block : null,
  );
  const [topMenuRequestSequence, setTopMenuRequestSequence] = useState(0);
  const [topMenuOpen, setTopMenuOpen] = useState(false);
  const displayBlock = fullBlock ?? block;
  const currentBlockSlugRef = useRef(block.slug);
  const { containerRef: detailLayoutRef, isStackedLayout } = useDetailStackedLayout();
  const layoutClasses = isStackedLayout
    ? DETAIL_STACKED_LAYOUT_CLASSES
    : DETAIL_RAIL_LAYOUT_CLASSES;
  const articleColumnClasses = isStackedLayout
    ? "col-start-2 min-w-0 mx-auto w-full max-w-[48rem]"
    : "col-start-2 min-w-0";
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
  }, [isClosing]);

  const refreshFullBlock = useCallback((slug: string) => {
    void getBlock(slug)
      .then((full) => {
        if (!full || currentBlockSlugRef.current !== slug) {
          return;
        }
        setFullBlock(full);
      })
      .catch((error) => {
        console.error("Failed to refresh block:", error);
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
  const topFade = useTopFadeMask(panelRef, scrollEdgeFade);

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

  useEffect(() => {
    if (topChromeMode === "external") return;
    const handler = (event: KeyboardEvent) => {
      if (!isDetailCommandK(event)) return;
      if (shouldIgnoreDetailCommandK(event) && !topMenuOpen) return;
      event.preventDefault();
      event.stopPropagation();
      setTopMenuRequestSequence((current) => current + 1);
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [topChromeMode, topMenuOpen]);

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
        "flex flex-col",
      )}
      role="dialog"
      aria-modal="false"
      aria-label={filename}
      data-detail-root
    >
      {topChromeMode === "classic" && (
        <header
          data-entered={chromeEntered ? "true" : "false"}
          className={cn(
            "detail-top-bar-enter relative flex h-8 shrink-0 items-center gap-3 px-[var(--edge-rhythm,32px)]",
            "bg-accent",
          )}
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
            openRequestSequence={topMenuRequestSequence}
            onOpenChange={setTopMenuOpen}
          />
          <ChromeCloseButton label="Close" onClick={onClose} />
          <span
            aria-hidden="true"
            data-entered={chromeEntered ? "true" : "false"}
            className="detail-top-bar-line-enter pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border"
          />
        </header>
      )}
      <div
        ref={detailLayoutRef}
        className={cn(
          "relative min-h-0 flex-1",
          isClosing && "opacity-0",
        )}
        data-detail-layout-mode={isStackedLayout ? "stacked" : "rail"}
      >
        <TopFadeScrim scrolled={topFade.scrolled} surface="detail" color="var(--background)" />
        {/* Layer 1: Scrollable content + invisible spacer */}
        <div
          ref={topFade.ref}
          tabIndex={-1}
          className="h-full w-full overflow-y-auto outline-none"
          data-detail-scroll
          data-detail-top-fade={topFade.scrolled ? "true" : undefined}
        >
          <div
            className={cn(layoutClasses, DETAIL_BOTTOM_SAFE_SPACE_CLASS)}
            data-detail-layout-grid="scroll"
          >
            <div className={articleColumnClasses} data-detail-article-column>
              <BlockContent
                block={block}
                fullBlock={fullBlock}
                scrollAnchor={scrollAnchor}
                vaultPath={vaultPath}
                thumbsRootPath={thumbsRootPath}
                tags={tags}
                currentTag={currentTag}
                onCreateMediaAssetCard={onCreateMediaAssetCard}
                onCreateChannelAndMediaAssetCard={onCreateChannelAndMediaAssetCard}
                onRenameMediaAsset={onRenameMediaAsset}
                onRemoveMediaAssetFromCard={onRemoveMediaAssetFromCard}
                onDeleteMediaAsset={onDeleteMediaAsset}
                onOpenImagePreview={onOpenImagePreview}
                onOpenRelatedNote={onOpenRelatedNote}
                onTextSelectionDrop={onTextSelectionDrop}
                onCreateChannelAndTextSelectionCard={onCreateChannelAndTextSelectionCard}
                onTextSelectionDelete={onTextSelectionDelete}
              />
            </div>
            {isStackedLayout ? (
              <div
                className="col-start-2 mt-[var(--edge-rhythm,32px)] min-w-0"
                data-detail-stacked-metadata-row
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
            ) : (
              <div
                className="col-start-4 min-w-0"
                aria-hidden="true"
                data-detail-metadata-spacer
              />
            )}
          </div>
        </div>

        {!isStackedLayout && (
          /* Layer 2: Fixed metadata (same layout, doesn't scroll) */
          <div
            className="pointer-events-none absolute inset-0 overflow-hidden"
            data-detail-fixed-metadata-layer
          >
            <div
              className={layoutClasses}
              data-detail-layout-grid="metadata"
            >
              <div className="col-start-2 min-w-0" />
              <div
                className="pointer-events-auto col-start-4 min-w-0 overflow-y-auto overflow-x-hidden"
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
        )}
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
  const resolvedThumbsRoot = thumbsRootPath ?? fallbackThumbsRoot(vaultPath);
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
            className="overflow-hidden rounded-1 border border-border bg-accent"
            style={{ minWidth: DETAIL_METADATA_CARD_MIN_WIDTH_PX }}
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

const DELETE_MEDIA_CONNECTED_CARDS_VISIBLE_COUNT = 5;
const DELETE_MEDIA_CONNECTED_CARDS_MAX_HEIGHT_PX =
  DELETE_MEDIA_CONNECTED_CARDS_VISIBLE_COUNT * CARD_REFERENCE_ROW_ESTIMATED_HEIGHT_PX
  + (DELETE_MEDIA_CONNECTED_CARDS_VISIBLE_COUNT - 1) * CARD_REFERENCE_ROW_GAP_PX;

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
    void getBlock(block.slug)
      .then((full) => {
        if (!cancelled) {
          setSelectedTags(full?.tags ?? (isIndexedBlock(block) ? block.tags : []));
        }
      })
      .catch((error) => {
        console.error("Failed to load tags for block:", error);
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
          // Opens the browser, so it carries the pointing hand; every other
          // control in this bar acts inside Mine and keeps the arrow.
          className="min-w-0 flex-1 cursor-pointer bg-component-fill-inner"
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
        <DropdownMenuContent widthRole="picker" className={COLLECTION_PICKER_CONTENT_CLASS} align="start">
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
  label = "Related notes",
  relatedNotes,
  relatedNoteBlocks,
  fallbackLabels,
  resolvedThumbsRoot,
  onOpenRelatedNote,
  relatedNoteButtonRefs,
  onRelatedNotePreviewEnter,
  onRelatedNotePreviewLeave,
}: {
  label?: string | null;
  relatedNotes: string[];
  relatedNoteBlocks: Map<string, IndexedBlock | null> | null;
  fallbackLabels?: Map<string, string>;
  resolvedThumbsRoot: string;
  onOpenRelatedNote: (slug: string) => void;
  relatedNoteButtonRefs: { current: Map<string, HTMLButtonElement> };
  onRelatedNotePreviewEnter: (note: HoveredRelatedNote) => void;
  onRelatedNotePreviewLeave: () => void;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1" data-related-notes-block>
      {label !== null && <div className={METADATA_LABEL_CLASSES}>{label}</div>}
      <div className="flex w-full min-w-0 flex-col gap-1" data-related-notes-list>
        {relatedNotes.map((slug, index) => {
          const baseSlug = baseRelatedNoteSlug(slug);
          const rowKey = `${index}:${slug}`;
          const relatedBlock = relatedNoteBlocks?.get(baseSlug) ?? null;
          const rowLabel = relatedBlock
            ? getFallbackLabel(relatedBlock)
            : fallbackLabels?.get(baseSlug) ?? baseSlug;

          if (!relatedBlock) {
            return (
              <CardReferenceRow
                key={slug}
                label={rowLabel}
                preview={null}
                className="text-muted-foreground"
                data-related-note-item="placeholder"
              />
            );
          }

          return (
            <CardReferenceButton
              key={rowKey}
              label={rowLabel}
              preview={microPreviewFromIndexedBlock(relatedBlock, resolvedThumbsRoot)}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenRelatedNote(baseSlug);
              }}
              className="text-muted-foreground"
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
            />
          );
        })}
      </div>
    </section>
  );
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
  previewManifest: ReturnType<typeof normalizeDetailPreviewManifest>;
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
  tags,
  currentTag,
  onCreateMediaAssetCard,
  onCreateChannelAndMediaAssetCard,
  onRenameMediaAsset,
  onRemoveMediaAssetFromCard,
  onDeleteMediaAsset,
  onOpenImagePreview,
  onOpenRelatedNote,
  onTextSelectionDrop,
  onCreateChannelAndTextSelectionCard,
  onTextSelectionDelete,
}: {
  block: LightBlock | IndexedBlock;
  fullBlock: IndexedBlock | null;
  scrollAnchor?: string | null;
  vaultPath: string;
  thumbsRootPath?: string;
  tags: TagCount[];
  currentTag?: string;
  onCreateMediaAssetCard: (asset: MediaAssetRef, tag: string) => Promise<void>;
  onCreateChannelAndMediaAssetCard: (asset: MediaAssetRef, tag: string) => Promise<void>;
  onRenameMediaAsset: (asset: MediaAssetRef, newStem: string) => Promise<void>;
  onRemoveMediaAssetFromCard: (asset: MediaAssetRef) => Promise<void>;
  onDeleteMediaAsset: (asset: MediaAssetRef) => Promise<void>;
  onOpenImagePreview: (preview: ImagePreviewRequest) => void;
  onOpenRelatedNote: (slug: string) => void;
  onTextSelectionDrop?: (payload: MineTextSelectionDragPayload, tag: string) => void;
  onCreateChannelAndTextSelectionCard: (
    payload: MineTextSelectionDragPayload,
    tag: string,
  ) => Promise<void>;
  onTextSelectionDelete?: (payload: MineTextSelectionDragPayload) => void | Promise<void>;
}) {
  const resolvedThumbsRoot = thumbsRootPath ?? fallbackThumbsRoot(vaultPath);
  const previewManifest = useMemo(
    () => normalizeDetailPreviewManifest((fullBlock ?? block).preview_manifest),
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
      let cancelled = false;
      getBlock(block.slug)
        .then((full) => {
          if (!cancelled && full) setFullBody(full.body);
        })
        .catch((error) => {
          console.error("Failed to load full block body:", error);
        });
      return () => {
        cancelled = true;
      };
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
            tags={tags}
            currentTag={currentTag}
            onCreateMediaAssetCard={onCreateMediaAssetCard}
            onCreateChannelAndMediaAssetCard={onCreateChannelAndMediaAssetCard}
            onRenameMediaAsset={onRenameMediaAsset}
            onRemoveMediaAssetFromCard={onRemoveMediaAssetFromCard}
            onDeleteMediaAsset={onDeleteMediaAsset}
            onOpenImagePreview={onOpenImagePreview}
            onOpenRelatedNote={onOpenRelatedNote}
            onTextSelectionDrop={onTextSelectionDrop}
            onCreateChannelAndTextSelectionCard={onCreateChannelAndTextSelectionCard}
            onTextSelectionDelete={onTextSelectionDelete}
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
              tags={tags}
              currentTag={currentTag}
              onCreateMediaAssetCard={onCreateMediaAssetCard}
              onCreateChannelAndMediaAssetCard={onCreateChannelAndMediaAssetCard}
              onRenameMediaAsset={onRenameMediaAsset}
              onRemoveMediaAssetFromCard={onRemoveMediaAssetFromCard}
              onDeleteMediaAsset={onDeleteMediaAsset}
              onOpenImagePreview={onOpenImagePreview}
              onOpenRelatedNote={onOpenRelatedNote}
              onTextSelectionDrop={onTextSelectionDrop}
              onCreateChannelAndTextSelectionCard={onCreateChannelAndTextSelectionCard}
              onTextSelectionDelete={onTextSelectionDelete}
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

    case "link": {
      if (descriptor.variant === "link" && previewManifest?.kind !== "text") {
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
                onError={(event) => {
                  event.currentTarget.style.display = "none";
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

      return (
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
            <MediaAssetActionFrame
              asset={mediaAssetFromPrimary(block, "image")}
              vaultPath={vaultPath}
              tags={tags}
              currentTag={currentTag}
              canDrag
              onCreateMediaAssetCard={onCreateMediaAssetCard}
              onCreateChannelAndMediaAssetCard={onCreateChannelAndMediaAssetCard}
              onRenameMediaAsset={onRenameMediaAsset}
              onRemoveMediaAssetFromCard={onRemoveMediaAssetFromCard}
              onDeleteMediaAsset={onDeleteMediaAsset}
              onOpenImagePreview={onOpenImagePreview}
              onOpenRelatedNote={onOpenRelatedNote}
              imageSrc={src}
              fullSizeImageSrc={src}
            >
              <img
                src={src}
                alt={navigationLabel}
                className="block max-h-[85vh] max-w-full object-contain"
                draggable={false}
              />
            </MediaAssetActionFrame>
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
          descriptor.mediaItems.find((item) => item.isVideo)?.sourcePath
          ?? block.media_file;
        const localSrc = resolveDetailMediaReference(vaultPath, videoSourcePath);
        return (
          <div className="flex min-h-full flex-col">
            <div className="flex flex-1 items-center justify-center bg-black">
              {embedUrl ? (
                <MediaAssetActionFrame
                  asset={null}
                  vaultPath={vaultPath}
                  tags={tags}
                  currentTag={currentTag}
                  canDrag={false}
                  onCreateMediaAssetCard={onCreateMediaAssetCard}
                  onCreateChannelAndMediaAssetCard={onCreateChannelAndMediaAssetCard}
                  onRenameMediaAsset={onRenameMediaAsset}
                  onRemoveMediaAssetFromCard={onRemoveMediaAssetFromCard}
                  onDeleteMediaAsset={onDeleteMediaAsset}
                  onOpenRelatedNote={onOpenRelatedNote}
                  className="w-full"
                >
                  <iframe
                    src={embedUrl}
                    className="aspect-video w-full max-h-[85vh]"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                </MediaAssetActionFrame>
              ) : localSrc ? (
                <MediaAssetActionFrame
                  asset={videoSourcePath ? mediaAssetFromMediaRef(block.slug, videoSourcePath, "video", "frontmatter_file") : null}
                  vaultPath={vaultPath}
                  tags={tags}
                  currentTag={currentTag}
                  canDrag={false}
                  onCreateMediaAssetCard={onCreateMediaAssetCard}
                  onCreateChannelAndMediaAssetCard={onCreateChannelAndMediaAssetCard}
                  onRenameMediaAsset={onRenameMediaAsset}
                  onRemoveMediaAssetFromCard={onRemoveMediaAssetFromCard}
                  onDeleteMediaAsset={onDeleteMediaAsset}
                  onOpenRelatedNote={onOpenRelatedNote}
                >
                  <video controls className="block max-h-[85vh] max-w-full" draggable={false}>
                    <source src={localSrc} />
                  </video>
                </MediaAssetActionFrame>
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
                  sourceSlug={block.slug}
                  sourceBodyHash={fullBlock?.body_hash ?? (isIndexedBlock(block) ? block.body_hash : null)}
                  tags={tags}
                  currentTag={currentTag}
                  onCreateMediaAssetCard={onCreateMediaAssetCard}
                  onCreateChannelAndMediaAssetCard={onCreateChannelAndMediaAssetCard}
                  onRenameMediaAsset={onRenameMediaAsset}
                  onRemoveMediaAssetFromCard={onRemoveMediaAssetFromCard}
                  onDeleteMediaAsset={onDeleteMediaAsset}
                  onOpenImagePreview={onOpenImagePreview}
                  onOpenRelatedNote={onOpenRelatedNote}
                  onTextSelectionDrop={onTextSelectionDrop}
                  onCreateChannelAndTextSelectionCard={onCreateChannelAndTextSelectionCard}
                  onTextSelectionDelete={onTextSelectionDelete}
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

function MediaAssetActionFrame({
  asset,
  vaultPath,
  tags,
  currentTag,
  canDrag,
  imageSrc,
  fullSizeImageSrc,
  onOpenImagePreview = noopOpenImagePreview,
  onCreateMediaAssetCard,
  onCreateChannelAndMediaAssetCard,
  onRenameMediaAsset,
  onRemoveMediaAssetFromCard,
  onDeleteMediaAsset,
  onOpenRelatedNote,
  className,
  children,
}: {
  asset: MediaAssetRef | null;
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  canDrag: boolean;
  imageSrc?: string;
  fullSizeImageSrc?: string;
  onOpenImagePreview?: (preview: ImagePreviewRequest) => void;
  onCreateMediaAssetCard: (asset: MediaAssetRef, tag: string) => Promise<void>;
  onCreateChannelAndMediaAssetCard: (asset: MediaAssetRef, tag: string) => Promise<void>;
  onRenameMediaAsset: (asset: MediaAssetRef, newStem: string) => Promise<void>;
  onRemoveMediaAssetFromCard: (asset: MediaAssetRef) => Promise<void>;
  onDeleteMediaAsset: (asset: MediaAssetRef) => Promise<void>;
  onOpenRelatedNote: (slug: string) => void;
  className?: string;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const {
    attributes: dragAttributes,
    listeners: dragListeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: asset && canDrag
      ? `media-asset:${asset.source_slug}:${asset.media_ref}`
      : `media-asset-disabled:${asset?.media_ref ?? "none"}`,
    disabled: !asset || !canDrag,
    data: asset && canDrag
      ? {
          type: "media_asset",
          asset,
          imageSrc,
        }
      : undefined,
  });
  const dragPointerListener = (dragListeners as {
    onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  } | undefined)?.onPointerDown;
  const canOpenImagePreview = asset?.media_kind === "image" && Boolean(fullSizeImageSrc);
  const controlsVisible = menuOpen;

  if (!asset) {
    return (
      <div
        className={cn(
          "not-prose relative inline-flex max-h-[85vh] max-w-full overflow-hidden align-top leading-none [&_img]:m-0 [&_img]:block [&_video]:m-0 [&_video]:block",
          className,
        )}
        data-detail-media-action-frame
      >
        {children}
      </div>
    );
  }

  return (
    <div
      ref={setDragRef}
      {...(canDrag ? dragAttributes : {})}
      {...(canDrag ? dragListeners : {})}
      className={cn(
        "not-prose group/detail-media relative inline-flex max-h-[85vh] max-w-full overflow-hidden align-top leading-none [&_img]:m-0 [&_img]:block [&_video]:m-0 [&_video]:block",
        // No resting cursor of its own: the pointer stays default until a drag
        // actually starts, and only then becomes grabbing.
        canDrag && "select-none active:cursor-grabbing",
        isDragging && "opacity-40",
        className,
      )}
      draggable={false}
      data-detail-media-action-frame
      data-detail-inline-media-drag={canDrag ? "true" : undefined}
      data-media-asset-ref={asset.media_ref}
      onPointerDown={(event) => {
        if (!canDrag || event.button !== 0) return;
        dragPointerListener?.(event);
        // Suppressing the default here would also suppress the click that
        // follows, and a click is now how the image opens. The drag sensor
        // needs an 8px move to engage, so a still press stays a click.
        if (!canOpenImagePreview) event.preventDefault();
        window.getSelection()?.removeAllRanges();
      }}
      onMouseDown={(event) => {
        if (canDrag && event.button === 0 && !canOpenImagePreview) {
          event.preventDefault();
        }
      }}
      onClick={(event) => {
        // A completed drag never reaches here: dnd-kit swallows the click once
        // the pointer passes the activation distance.
        if (!canOpenImagePreview || !fullSizeImageSrc || isDragging) return;
        onOpenImagePreview({
          src: fullSizeImageSrc,
          mediaRef: asset.media_ref,
          siblings: collectCardImages(event.currentTarget),
        });
      }}
      onContextMenu={(event) => {
        if (!canOpenImagePreview) return;
        event.preventDefault();
        event.stopPropagation();
        setMenuOpen(true);
      }}
      onDragStart={(event) => {
        if (canDrag) {
          event.preventDefault();
        }
      }}
    >
      {children}
      <div
        className={cn(
          "absolute right-2 top-2 z-10 flex gap-1 transition-opacity duration-[160ms]",
          controlsVisible
            ? "opacity-100"
            : "pointer-events-none opacity-0 group-hover/detail-media:pointer-events-auto group-hover/detail-media:opacity-100 group-focus-within/detail-media:pointer-events-auto group-focus-within/detail-media:opacity-100",
        )}
        data-detail-media-action-menu
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      >
        {canOpenImagePreview && fullSizeImageSrc && (
          <Button
            type="button"
            variant="default"
            size="icon"
            aria-label="Expand image"
            data-detail-media-expand-button
            onClick={(event) => {
              onOpenImagePreview({
                src: fullSizeImageSrc,
                mediaRef: asset.media_ref,
                siblings: collectCardImages(event.currentTarget),
              });
            }}
          >
            <Expand className="size-4" />
          </Button>
        )}
        <MediaAssetMoreMenu
          asset={asset}
          vaultPath={vaultPath}
          tags={tags}
          currentTag={currentTag}
          onCreateMediaAssetCard={onCreateMediaAssetCard}
          onCreateChannelAndMediaAssetCard={onCreateChannelAndMediaAssetCard}
          onRenameMediaAsset={onRenameMediaAsset}
          onRemoveMediaAssetFromCard={onRemoveMediaAssetFromCard}
          onDeleteMediaAsset={onDeleteMediaAsset}
          onOpenRelatedNote={onOpenRelatedNote}
          open={menuOpen}
          onOpenChange={setMenuOpen}
        />
      </div>
    </div>
  );
}

function MediaAssetMoreMenu({
  asset,
  vaultPath,
  tags,
  currentTag,
  onCreateMediaAssetCard,
  onCreateChannelAndMediaAssetCard,
  onRenameMediaAsset,
  onRemoveMediaAssetFromCard,
  onDeleteMediaAsset,
  onOpenRelatedNote,
  open,
  onOpenChange,
  className,
}: {
  asset: MediaAssetRef;
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  onCreateMediaAssetCard: (asset: MediaAssetRef, tag: string) => Promise<void>;
  onCreateChannelAndMediaAssetCard: (asset: MediaAssetRef, tag: string) => Promise<void>;
  onRenameMediaAsset: (asset: MediaAssetRef, newStem: string) => Promise<void>;
  onRemoveMediaAssetFromCard: (asset: MediaAssetRef) => Promise<void>;
  onDeleteMediaAsset: (asset: MediaAssetRef) => Promise<void>;
  onOpenRelatedNote: (slug: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}) {
  const [connectSubmenuOpen, setConnectSubmenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const mediaPath = mediaAbsolutePath(vaultPath, asset.media_ref);
  const updateRootOpen = useCallback((open: boolean) => {
    if (!open) {
      setConnectSubmenuOpen(false);
    }
    onOpenChange(open);
  }, [onOpenChange]);

  return (
    <>
      <DropdownMenu open={open} onOpenChange={updateRootOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="default"
            size="icon"
            className={className}
            aria-label="Media actions"
            data-detail-media-more-button
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuSub open={connectSubmenuOpen} onOpenChange={setConnectSubmenuOpen}>
            <DropdownMenuSubTrigger>
              <MenuIconSlot>
                <Plus className="size-3" />
              </MenuIconSlot>
              Create Element
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent widthRole="picker" className={COLLECTION_PICKER_CONTENT_CLASS}>
              <MediaAssetCollectionPicker
                asset={asset}
                tags={tags}
                currentTag={currentTag}
                onConnect={onCreateMediaAssetCard}
                onCreateAndConnect={onCreateChannelAndMediaAssetCard}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={() => revealItemInDir(mediaPath)}>
            <MenuIconSlot />
            Reveal in Finder
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => copyTextToClipboard(mediaPath)}>
            <MenuIconSlot />
            Copy Path
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              setActionError(null);
              void copyMediaAssetToClipboard(asset.media_ref)
                .catch((error) => setActionError(mediaAssetErrorMessage(error)));
            }}
          >
            <MenuIconSlot />
            Copy Media
          </DropdownMenuItem>

          {actionError && (
            <div className="px-2 py-1.5 text-sm text-destructive">
              {actionError}
            </div>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
            <MenuIconSlot />
            Rename Media...
          </DropdownMenuItem>
          <DropdownMenuItem variant="detach" onSelect={() => setRemoveOpen(true)}>
            <MenuIconSlot>
              <Unlink className="size-3" />
            </MenuIconSlot>
            Remove from Element
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setDeleteOpen(true)}
          >
            <MenuIconSlot>
              <Trash2 className="size-3" />
            </MenuIconSlot>
            Delete Media
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameMediaAssetDialog
        asset={asset}
        open={renameOpen}
        onOpenChange={setRenameOpen}
        onRename={onRenameMediaAsset}
      />
      <RemoveMediaAssetFromCardDialog
        asset={asset}
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        onRemove={onRemoveMediaAssetFromCard}
      />
      <DeleteMediaAssetDialog
        asset={asset}
        vaultPath={vaultPath}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDelete={onDeleteMediaAsset}
        onOpenRelatedNote={(slug) => {
          setDeleteOpen(false);
          onOpenChange(false);
          onOpenRelatedNote(slug);
        }}
      />
    </>
  );
}

export function MediaAssetCollectionPicker({
  asset,
  tags,
  currentTag,
  onConnect,
  onCreateAndConnect,
}: {
  asset: MediaAssetRef;
  tags: TagCount[];
  currentTag?: string;
  onConnect: (asset: MediaAssetRef, tag: string) => Promise<void>;
  onCreateAndConnect: (asset: MediaAssetRef, tag: string) => Promise<void>;
}) {
  return (
    <CreateCardCollectionPicker
      payload={asset}
      tags={tags}
      currentTag={currentTag}
      onConnect={onConnect}
      onCreateAndConnect={onCreateAndConnect}
    />
  );
}

function TextSelectionCollectionPicker({
  payload,
  tags,
  currentTag,
  onConnect,
  onCreateAndConnect,
}: {
  payload: MineTextSelectionDragPayload;
  tags: TagCount[];
  currentTag?: string;
  onConnect: (payload: MineTextSelectionDragPayload, tag: string) => void | Promise<void>;
  onCreateAndConnect: (payload: MineTextSelectionDragPayload, tag: string) => Promise<void>;
}) {
  return (
    <CreateCardCollectionPicker
      payload={payload}
      tags={tags}
      currentTag={currentTag}
      onConnect={onConnect}
      onCreateAndConnect={onCreateAndConnect}
    />
  );
}

function CreateCardCollectionPicker<TPayload>({
  payload,
  tags,
  currentTag,
  onConnect,
  onCreateAndConnect,
}: {
  payload: TPayload;
  tags: TagCount[];
  currentTag?: string;
  onConnect: (payload: TPayload, tag: string) => void | Promise<void>;
  onCreateAndConnect: (payload: TPayload, tag: string) => void | Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [pendingTag, setPendingTag] = useState<string | null>(null);
  // Canonical sidebar order from props; only the current collection is
  // hoisted to the top (stable sort keeps the rest untouched).
  const sortedTags = useMemo(() => {
    return [...tags].sort((a, b) => {
      if (currentTag) {
        const aCurrent = a.tag === currentTag;
        const bCurrent = b.tag === currentTag;
        if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
      }
      return 0;
    });
  }, [currentTag, tags]);
  const lc = search.toLowerCase();
  const everythingItem = { tag: "", title: "Everything" };
  const channelItems = sortedTags.map((tag) => ({
    tag: tag.tag,
    title: collectionRefLabel(tag.tag),
  }));
  const filtered = lc
    ? [everythingItem, ...channelItems].filter((item) => item.title.toLowerCase().includes(lc))
    : [everythingItem, ...channelItems];
  const trimmed = search.trim();
  const canCreate = trimmed.length > 0 && filtered.length === 0;
  const listRowCount = Math.max(filtered.length + (canCreate ? 1 : 0), 1);

  const connect = async (tag: string, create: boolean) => {
    setPendingTag(tag);
    try {
      if (create) {
        await onCreateAndConnect(payload, tag);
      } else {
        await onConnect(payload, tag);
      }
      setSearch("");
    } finally {
      setPendingTag(null);
    }
  };

  return (
    <>
      <SearchMenuInput
        autoFocus
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search collections..."
        onKeyDown={(event) => event.stopPropagation()}
      />
      <QuantizedMenuScrollArea
        rowCount={listRowCount}
        rowSize="default"
        paddingY="compact"
        className="min-h-0 flex-1"
        innerClassName="px-1 py-0.5"
      >
        {filtered.map((item) => {
          const pending = pendingTag === item.tag;
          return (
            <DropdownMenuItem
              key={item.tag || "__everything__"}
              className="h-[var(--menu-row-height)] py-0"
              disabled={pendingTag !== null}
              onSelect={() => {
                void connect(item.tag, false);
              }}
            >
              <span className="truncate">{pending ? "Creating..." : item.title}</span>
            </DropdownMenuItem>
          );
        })}

        {canCreate && (
          <DropdownMenuItem
            className="h-[var(--menu-row-height)] py-0"
            disabled={pendingTag !== null}
            onSelect={() => {
              void connect(trimmed, true);
            }}
          >
            <Plus className="size-4 shrink-0" />
            <span>Create &ldquo;{trimmed}&rdquo;</span>
          </DropdownMenuItem>
        )}

        {filtered.length === 0 && !canCreate && (
          <p className="flex h-[var(--menu-row-height)] items-center justify-center px-2 text-center text-sm text-muted-foreground">
            No collections
          </p>
        )}
      </QuantizedMenuScrollArea>
    </>
  );
}

function RenameMediaAssetDialog({
  asset,
  open,
  onOpenChange,
  onRename,
}: {
  asset: MediaAssetRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: (asset: MediaAssetRef, newStem: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const extension = mediaExtension(asset.media_ref);

  useEffect(() => {
    if (!open) {
      setSubmitting(false);
      setError(null);
      return;
    }
    setValue(mediaStem(asset.media_ref));
    setError(null);
  }, [asset.media_ref, open]);

  const submit = async () => {
    const next = value.trim();
    if (!next) return;
    try {
      setSubmitting(true);
      setError(null);
      await onRename(asset, next);
      onOpenChange(false);
    } catch (rawError) {
      setError(mediaAssetErrorMessage(rawError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Rename media</DialogTitle>
          <DialogDescription>
            Rename only the media file. Cards and notes keep their filenames.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <div className="text-sm font-medium text-foreground">Current</div>
            <div className="font-mono text-sm text-muted-foreground">
              {asset.media_ref}
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground" htmlFor="rename-media-input">
              Filename
            </label>
            <Input
              id="rename-media-input"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoFocus
              spellCheck={false}
              disabled={submitting}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="text-sm text-muted-foreground">
              Extension stays <span className="font-mono">.{extension}</span>
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!value.trim() || submitting}>
            {submitting ? "Renaming..." : "Rename"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RemoveMediaAssetFromCardDialog({
  asset,
  open,
  onOpenChange,
  onRemove,
}: {
  asset: MediaAssetRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemove: (asset: MediaAssetRef) => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSubmitting(false);
      setError(null);
    }
  }, [open]);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="min-w-0 overflow-hidden">
        <AlertDialogHeader className="min-w-0">
          <AlertDialogTitle>Remove media from card?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes only this media reference from the current card. The media file stays in the vault.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="font-mono text-sm text-muted-foreground">
          {asset.media_ref}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={submitting}
            onClick={(event) => {
              event.preventDefault();
              void (async () => {
                try {
                  setSubmitting(true);
                  setError(null);
                  await onRemove(asset);
                  onOpenChange(false);
                } catch (rawError) {
                  setError(mediaAssetErrorMessage(rawError));
                } finally {
                  setSubmitting(false);
                }
              })();
            }}
          >
            {submitting ? "Removing..." : "Remove from Element"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeleteMediaAssetDialog({
  asset,
  vaultPath,
  open,
  onOpenChange,
  onDelete,
  onOpenRelatedNote,
}: {
  asset: MediaAssetRef;
  vaultPath: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (asset: MediaAssetRef) => Promise<void>;
  onOpenRelatedNote: (slug: string) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<DeleteMediaAssetPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const previewSrc = vaultPath ? mediaUrl(vaultPath, asset.media_ref) : "";
  const references = plan?.referenced_by ?? [];
  const resolvedThumbsRoot = vaultPath ? fallbackThumbsRoot(vaultPath) : "";

  useEffect(() => {
    if (!open) {
      setSubmitting(false);
      setError(null);
      setPlan(null);
      setPlanLoading(false);
      setPlanError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setPlan(null);
    setPlanError(null);
    setPlanLoading(true);
    void prepareDeleteMediaAsset(asset.media_ref)
      .then((nextPlan) => {
        if (!cancelled) {
          setPlan(nextPlan);
        }
      })
      .catch((rawError) => {
        if (!cancelled) {
          setPlanError(mediaAssetErrorMessage(rawError));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPlanLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [asset.media_ref, open]);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="min-w-0 overflow-hidden" data-delete-media-dialog="">
        <AlertDialogHeader className="min-w-0">
          <AlertDialogTitle>Delete media file?</AlertDialogTitle>
          <AlertDialogDescription>
            This deletes the local media file and removes its references from every listed card. Markdown cards stay in the vault.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex min-w-0">
          <div className="flex h-24 w-32 items-center justify-center overflow-hidden rounded-1 border border-border bg-component-fill">
            {asset.media_kind === "image" ? (
              <img
                src={previewSrc}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : asset.media_kind === "video" ? (
              <video
                src={previewSrc}
                className="h-full w-full object-cover"
                muted
                preload="metadata"
              />
            ) : (
              <span className="px-3 text-center text-xs text-muted-foreground">
                Media file
              </span>
            )}
          </div>
        </div>
        <div className="min-w-0 space-y-1">
          <div className={METADATA_LABEL_CLASSES}>Connected elements</div>
          <div
            className="min-w-0 overflow-y-auto pr-1"
            style={{ maxHeight: DELETE_MEDIA_CONNECTED_CARDS_MAX_HEIGHT_PX }}
            data-delete-media-connected-cards-scroll
            data-visible-card-count={DELETE_MEDIA_CONNECTED_CARDS_VISIBLE_COUNT}
          >
            {planLoading ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                Checking cards...
              </div>
            ) : references.length > 0 ? (
              <MediaAssetReferenceCards
                references={references}
                vaultPath={vaultPath}
                thumbsRootPath={resolvedThumbsRoot}
                onOpenRelatedNote={onOpenRelatedNote}
              />
            ) : (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                No cards currently reference this file.
              </div>
            )}
          </div>
        </div>
        {planError && <p className="text-sm text-destructive">{planError}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={submitting || planLoading || Boolean(planError)}
            onClick={(event) => {
              event.preventDefault();
              void (async () => {
                try {
                  setSubmitting(true);
                  setError(null);
                  await onDelete(asset);
                  onOpenChange(false);
                } catch (rawError) {
                  setError(mediaAssetErrorMessage(rawError));
                } finally {
                  setSubmitting(false);
                }
              })();
            }}
          >
            {submitting ? "Deleting..." : "Delete media"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MediaAssetReferenceCards({
  references,
  vaultPath,
  thumbsRootPath,
  onOpenRelatedNote,
}: {
  references: DeleteMediaAssetPlan["referenced_by"];
  vaultPath: string | null;
  thumbsRootPath: string;
  onOpenRelatedNote: (slug: string) => void;
}) {
  const relatedNoteButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const hoverPreviewRef = useRef<HTMLDivElement | null>(null);
  const hoverPreviewOpenTimerRef = useRef<number | null>(null);
  const lastHoverPreviewOpenedAtRef = useRef<number | null>(null);
  const relatedNotes = useMemo(() => references.map((reference) => reference.slug), [references]);
  const relatedNotesKey = relatedNotes.join("\u0000");
  const fallbackLabels = useMemo(
    () =>
      new Map(
        references.map((reference) => [
          reference.slug,
          mediaAssetReferenceTitle(reference),
        ]),
      ),
    [references],
  );
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

  const hoverPreview =
    vaultPath && hoverPreviewPosition && hoveredRelatedNoteBlock ? (
      <div
        ref={hoverPreviewRef}
        className="pointer-events-none fixed z-50"
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
          thumbsRootPath={thumbsRootPath}
          width={HOVER_CARD_WIDTH}
        />
      </div>
    ) : null;

  return (
    <>
      {hoverPreview && typeof document !== "undefined"
        ? createPortal(hoverPreview, document.body)
        : null}
      <RelatedNotesSection
        label={null}
        relatedNotes={relatedNotes}
        relatedNoteBlocks={relatedNoteBlocks}
        fallbackLabels={fallbackLabels}
        resolvedThumbsRoot={thumbsRootPath}
        onOpenRelatedNote={onOpenRelatedNote}
        relatedNoteButtonRefs={relatedNoteButtonRefs}
        onRelatedNotePreviewEnter={openRelatedNotePreview}
        onRelatedNotePreviewLeave={requestCloseRelatedNotePreview}
      />
    </>
  );
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
  tags,
  currentTag,
  onCreateMediaAssetCard,
  onCreateChannelAndMediaAssetCard,
  onRenameMediaAsset,
  onRemoveMediaAssetFromCard,
  onDeleteMediaAsset,
  onOpenImagePreview,
  onOpenRelatedNote,
  onTextSelectionDrop,
  onCreateChannelAndTextSelectionCard,
  onTextSelectionDelete,
}: {
  body: string;
  vaultPath: string;
  thumbsRootPath: string;
  previewManifest: ReturnType<typeof normalizeDetailPreviewManifest>;
  sourceSlug?: string;
  sourceBodyHash?: string | null;
  scrollAnchor?: string | null;
  tags: TagCount[];
  currentTag?: string;
  onCreateMediaAssetCard: (asset: MediaAssetRef, tag: string) => Promise<void>;
  onCreateChannelAndMediaAssetCard: (asset: MediaAssetRef, tag: string) => Promise<void>;
  onRenameMediaAsset: (asset: MediaAssetRef, newStem: string) => Promise<void>;
  onRemoveMediaAssetFromCard: (asset: MediaAssetRef) => Promise<void>;
  onDeleteMediaAsset: (asset: MediaAssetRef) => Promise<void>;
  onOpenImagePreview: (preview: ImagePreviewRequest) => void;
  onOpenRelatedNote: (slug: string) => void;
  onTextSelectionDrop?: (payload: MineTextSelectionDragPayload, tag: string) => void;
  onCreateChannelAndTextSelectionCard: (
    payload: MineTextSelectionDragPayload,
    tag: string,
  ) => Promise<void>;
  onTextSelectionDelete?: (payload: MineTextSelectionDragPayload) => void | Promise<void>;
}) {
  const articleRef = useRef<HTMLDivElement | null>(null);
  const selectionFrameRef = useRef<number | null>(null);
  const selectionHandleLockedRef = useRef(false);
  const [selectionHandle, setSelectionHandle] = useState<TextSelectionHandleState | null>(null);
  const hasTextSelectionActions = Boolean(onTextSelectionDrop || onTextSelectionDelete);

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
    if (!hasTextSelectionActions || !articleRef.current) {
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
    setSelectionHandle({
      payload,
      anchorRect: textSelectionAnchorRect(rect),
      safeBounds: textSelectionSafeBounds(root),
    });
  }, [buildTextSelectionDragPayload, hasTextSelectionActions]);

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

  const handleTextSelectionDelete = useCallback((payload: MineTextSelectionDragPayload) => {
    setSelectionHandle(null);
    window.getSelection()?.removeAllRanges();
    return onTextSelectionDelete?.(payload);
  }, [onTextSelectionDelete]);

  const dismissTextSelectionHandle = useCallback(() => {
    selectionHandleLockedRef.current = false;
    window.removeEventListener("pointerup", unlockTextSelectionHandle, true);
    window.removeEventListener("pointercancel", unlockTextSelectionHandle, true);
    setSelectionHandle(null);
    window.getSelection()?.removeAllRanges();
  }, [unlockTextSelectionHandle]);

  useEffect(() => {
    if (!hasTextSelectionActions) {
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
  }, [hasTextSelectionActions, scheduleTextSelectionHandleUpdate]);

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
      p: ({ node, ...props }) => {
        const mediaLayout = paragraphMediaLayout(node);
        if (mediaLayout === "media-only") {
          return (
            <div
              {...markdownBlockPositionProps(node)}
              {...props}
              className={cn("not-prose my-5 leading-none", props.className)}
              data-article-media-stack=""
            />
          );
        }
        if (mediaLayout === "mixed-media") {
          return (
            <div
              {...markdownBlockPositionProps(node)}
              {...props}
              className={cn("my-5 leading-5", props.className)}
            />
          );
        }
        return <p {...markdownBlockPositionProps(node)} {...props} />;
      },
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
      img: ({ node, src, alt, ...props }) => {
        const decodedSrc = decodeLocalMarkdownUrl(src ?? "");
        const previewTile = findPreviewTileForSource(previewManifest, decodedSrc);
        const resolvedSrc = previewTile?.sourcePath ?? decodedSrc;
        const originalSrc = resolveImageSrc(resolvedSrc, vaultPath);
        // Which duplicate of this embed in the body — lets removal target one copy.
        const nodeStartOffset = (node as MarkdownPositionedNode | undefined)?.position?.start?.offset;
        const occurrenceIndex = typeof nodeStartOffset === "number"
          ? inlineMediaOccurrenceIndex(processedBody, decodedSrc, nodeStartOffset)
          : undefined;
        // Video/GIF (downloaded MP4) — render as inline autoplay video with controls.
        // Autoplay must stay muted to satisfy browser/WebView media policies.
        if (/\.mp4(\?|$)|\.webm(\?|$)/i.test(decodedSrc)) {
          const videoAsset = sourceSlug && isLocalMediaRef(resolvedSrc)
            ? mediaAssetFromMediaRef(sourceSlug, resolvedSrc, "video", "body_embed", occurrenceIndex)
            : null;
          return (
            <MediaAssetActionFrame
              asset={videoAsset}
              vaultPath={vaultPath}
              tags={tags}
              currentTag={currentTag}
              canDrag={false}
              onCreateMediaAssetCard={onCreateMediaAssetCard}
              onCreateChannelAndMediaAssetCard={onCreateChannelAndMediaAssetCard}
              onRenameMediaAsset={onRenameMediaAsset}
              onRemoveMediaAssetFromCard={onRemoveMediaAssetFromCard}
              onDeleteMediaAsset={onDeleteMediaAsset}
              onOpenRelatedNote={onOpenRelatedNote}
            >
              <VideoFromBlob
                src={originalSrc}
                controls
                autoPlay
                muted
                loop
                className="rounded-0"
              />
            </MediaAssetActionFrame>
          );
        }
        const previewSrc = previewTile?.previewPath
          ? previewAssetUrl(thumbsRootPath, previewTile.previewPath)
          : null;
        const asset = sourceSlug && isExtractableLocalImage(resolvedSrc)
          ? mediaAssetFromMediaRef(sourceSlug, resolvedSrc, "image", "body_embed", occurrenceIndex)
          : null;
        return (
          <MediaAssetActionFrame
            asset={asset}
            vaultPath={vaultPath}
            tags={tags}
            currentTag={currentTag}
            canDrag
            imageSrc={previewSrc ?? originalSrc}
            fullSizeImageSrc={originalSrc}
            onCreateMediaAssetCard={onCreateMediaAssetCard}
            onCreateChannelAndMediaAssetCard={onCreateChannelAndMediaAssetCard}
            onRenameMediaAsset={onRenameMediaAsset}
            onRemoveMediaAssetFromCard={onRemoveMediaAssetFromCard}
            onDeleteMediaAsset={onDeleteMediaAsset}
            onOpenImagePreview={onOpenImagePreview}
            onOpenRelatedNote={onOpenRelatedNote}
          >
            <DetailImage
              src={originalSrc}
              previewSrc={previewSrc}
              alt={alt ?? ""}
              className="rounded-0"
              {...props}
            />
          </MediaAssetActionFrame>
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
    [
      currentTag,
      onCreateMediaAssetCard,
      onCreateChannelAndMediaAssetCard,
      onDeleteMediaAsset,
      onOpenImagePreview,
      onRemoveMediaAssetFromCard,
      onRenameMediaAsset,
      previewManifest,
      sourceSlug,
      tags,
      thumbsRootPath,
      vaultPath,
    ],
  );

  return (
    <div
      ref={articleRef}
      onMouseUp={scheduleTextSelectionHandleUpdate}
      onKeyUp={scheduleTextSelectionHandleUpdate}
      className="prose prose-sm max-w-none [&>:first-child]:mt-0 [&_li]:leading-5 [&_p]:leading-5"
      data-article-body
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeMarkdownUrl}
        components={components}
      >
        {processedBody}
      </ReactMarkdown>
      {selectionHandle && (
        <TextSelectionActionBar
          state={selectionHandle}
          tags={tags}
          currentTag={currentTag}
          onCreateCard={onTextSelectionDrop}
          onCreateChannelAndCard={onCreateChannelAndTextSelectionCard}
          onDelete={onTextSelectionDelete ? handleTextSelectionDelete : undefined}
          onInteractionStart={lockTextSelectionHandle}
          onDismiss={dismissTextSelectionHandle}
        />
      )}
    </div>
  );
}

type TextSelectionHandleState = {
  payload: MineTextSelectionDragPayload;
  anchorRect: TextSelectionAnchorRect;
  safeBounds: TextSelectionSafeBounds;
};

function textSelectionAnchorRect(rect: DOMRect | ClientRect): TextSelectionAnchorRect {
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function textSelectionSafeBounds(root: HTMLElement): TextSelectionSafeBounds {
  const margin = TEXT_SELECTION_ACTION_BAR_VIEWPORT_MARGIN_PX;
  const rootRect = root.getBoundingClientRect();
  const hasHorizontalBounds = rootRect.width > 0;
  return {
    left: hasHorizontalBounds ? Math.max(margin, rootRect.left) : margin,
    right: hasHorizontalBounds ? Math.min(window.innerWidth - margin, rootRect.right) : window.innerWidth - margin,
    top: margin,
    bottom: window.innerHeight - margin,
  };
}

function TextSelectionActionBar({
  state,
  tags,
  currentTag,
  onCreateCard,
  onCreateChannelAndCard,
  onDelete,
  onInteractionStart,
  onDismiss,
}: {
  state: TextSelectionHandleState;
  tags: TagCount[];
  currentTag?: string;
  onCreateCard?: (payload: MineTextSelectionDragPayload, tag: string) => void;
  onCreateChannelAndCard: (
    payload: MineTextSelectionDragPayload,
    tag: string,
  ) => Promise<void>;
  onDelete?: (payload: MineTextSelectionDragPayload) => void | Promise<void>;
  onInteractionStart: () => void;
  onDismiss: () => void;
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
  const [connectOpen, setConnectOpen] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [barSize, setBarSize] = useState({
    width: TEXT_SELECTION_ACTION_BAR_FALLBACK_WIDTH_PX,
    height: TEXT_SELECTION_ACTION_BAR_HEIGHT_PX,
  });

  useLayoutEffect(() => {
    const element = barRef.current;
    if (!element) return undefined;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      const width = rect.width > 0 ? rect.width : TEXT_SELECTION_ACTION_BAR_FALLBACK_WIDTH_PX;
      const height = rect.height > 0 ? rect.height : TEXT_SELECTION_ACTION_BAR_HEIGHT_PX;
      setBarSize((current) => (
        current.width === width && current.height === height
          ? current
          : { width, height }
      ));
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const placement = placeTextSelectionActionBar({
    anchorRect: state.anchorRect,
    toolbarWidth: barSize.width,
    toolbarHeight: barSize.height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    safeBounds: state.safeBounds,
  });
  const style: CSSProperties = {
    left: placement.left,
    top: placement.top,
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
  };

  const actionBar = (
    <div
      ref={barRef}
      className={cn(
        "fixed z-50 flex h-8 items-center gap-1 rounded-1 border border-border bg-popover px-1 text-popover-foreground shadow-sm",
        isDragging && "opacity-0",
      )}
      style={style}
      data-text-selection-action-bar=""
      onMouseDown={(event) => {
        event.preventDefault();
      }}
    >
      <Button
        ref={setNodeRef}
        type="button"
        variant="ghost"
        size="icon"
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
        className="size-8 cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
        aria-label="Drag selected text to a collection"
        title="Drag selected text to a collection"
      >
        <GripVertical className="size-4" aria-hidden="true" />
      </Button>

      {onCreateCard && (
        <DropdownMenu open={connectOpen} onOpenChange={setConnectOpen} modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="default"
              size="xs"
              onMouseDown={(event) => {
                event.preventDefault();
              }}
            >
              <Plus className="size-3" aria-hidden="true" />
              Create Element
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            widthRole="picker"
            className={COLLECTION_PICKER_CONTENT_CLASS}
            align="start"
          >
            <TextSelectionCollectionPicker
              payload={state.payload}
              tags={tags}
              currentTag={currentTag}
              onConnect={(payload, tag) => {
                onCreateCard(payload, tag);
                setConnectOpen(false);
              }}
              onCreateAndConnect={async (payload, tag) => {
                await onCreateChannelAndCard(payload, tag);
                setConnectOpen(false);
              }}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {onDelete && (
        <Button
          type="button"
          variant="destructive"
          size="xs"
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            void onDelete(state.payload);
          }}
        >
          <Trash2 className="size-3" aria-hidden="true" />
          Delete Text
        </Button>
      )}

      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Clear text selection"
        className="size-8 text-muted-foreground hover:text-foreground"
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={onDismiss}
      >
        <X className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );

  return createPortal(actionBar, document.body);
}

function DetailImage({
  src,
  previewSrc,
  alt,
  className,
  ...imgProps
}: {
  src: string;
  previewSrc: string | null;
  alt: string;
} & React.ImgHTMLAttributes<HTMLImageElement>) {
  const [originalReady, setOriginalReady] = useState(false);

  useEffect(() => {
    setOriginalReady(false);
  }, [src]);

  return (
    <div className="relative overflow-hidden leading-none">
      {previewSrc && !originalReady && (
        <img
          src={previewSrc}
          alt=""
          className={cn("block max-w-full rounded-0", className)}
          loading="eager"
          draggable={false}
          aria-hidden="true"
        />
      )}
      <img
        src={src}
        alt={alt}
        className={cn(
          "block max-w-full rounded-0",
          className,
          previewSrc && !originalReady && "absolute inset-0",
        )}
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

function mediaAssetFromPrimary(
  block: LightBlock | IndexedBlock,
  mediaKind: MediaAssetRef["media_kind"],
): MediaAssetRef | null {
  const mediaRef = block.media_file;
  if (!mediaRef || !isLocalMediaRef(mediaRef)) {
    return null;
  }
  return mediaAssetFromMediaRef(block.slug, mediaRef, mediaKind, "frontmatter_file");
}

function mediaAssetFromMediaRef(
  sourceSlug: string,
  mediaRef: string,
  mediaKind: MediaAssetRef["media_kind"],
  referenceKind: MediaAssetRef["reference_kind"],
  occurrenceIndex?: number,
): MediaAssetRef {
  return {
    source_slug: sourceSlug,
    media_ref: mediaRef,
    media_kind: mediaKind,
    reference_kind: referenceKind,
    occurrence_index: occurrenceIndex ?? null,
  };
}

function mediaAbsolutePath(vaultPath: string, mediaRef: string): string {
  return `${vaultPath.replace(/\/+$/, "")}/${mediaRef.replace(/^\/+/, "")}`;
}

function mediaStem(mediaRef: string): string {
  const fileName = mediaRef.split("/").pop() ?? mediaRef;
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

function mediaExtension(mediaRef: string): string {
  const fileName = mediaRef.split("/").pop() ?? mediaRef;
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 && dot < fileName.length - 1 ? fileName.slice(dot + 1) : "";
}

function mediaAssetReferenceTitle(reference: DeleteMediaAssetPlan["referenced_by"][number]): string {
  return reference.display_title ?? reference.title ?? reference.fallback_label ?? reference.slug;
}

function mediaAssetErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "kind" in error) {
    const typed = error as { kind: string } & Record<string, unknown>;
    switch (typed.kind) {
      case "no_vault":
        return "No vault is open.";
      case "invalid_media_ref":
        return typeof typed.reason === "string" ? typed.reason : "Invalid media reference.";
      case "media_not_found":
        return "Media file was not found.";
      case "unsupported_media_kind":
        return "This media kind is not supported.";
      case "name_taken":
        return typeof typed.target === "string"
          ? `A file named ${typed.target} already exists.`
          : "A file with this name already exists.";
      case "invalid_filename":
        return typeof typed.reason === "string" ? typed.reason : "Invalid filename.";
      case "clipboard_unsupported":
        return "Native media copy is not supported on this platform.";
      case "internal":
        return typeof typed.message === "string" ? typed.message : "Media action failed.";
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Media action failed.";
}

function isLocalMediaRef(src: string): boolean {
  const trimmed = src.trim();
  if (!trimmed || trimmed !== src) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("/")) {
    return false;
  }
  if (trimmed.includes("\\") || trimmed.includes("\0")) {
    return false;
  }
  return trimmed.split("/").every((segment) => {
    return segment.length > 0 && segment !== "." && segment !== "..";
  });
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
  if (!isLocalMediaRef(src)) {
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
    "[data-image-preview-overlay], [data-radix-popper-content-wrapper], [role='menu'], [role='listbox']",
  );
}

function isDetailCommandK(event: KeyboardEvent): boolean {
  return (
    event.metaKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    event.key.toLowerCase() === "k"
  );
}

function shouldIgnoreDetailCommandK(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return true;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest("[data-image-preview-overlay]")) return true;
  const dialog = target.closest("[role='dialog']");
  return !!dialog && !(dialog as HTMLElement).hasAttribute("data-detail-root");
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
  value?: string;
  children?: MarkdownElementNode[];
};

function paragraphMediaLayout(node: unknown): "none" | "media-only" | "mixed-media" {
  const element = node as MarkdownElementNode | undefined;
  let hasMedia = false;
  let hasNonWhitespaceContent = false;
  for (const child of element?.children ?? []) {
    const isMedia = child.type === "element" && (
      child.tagName === "img" || child.tagName === "video"
    );
    if (isMedia) {
      hasMedia = true;
      continue;
    }
    if (child.type === "text" && !/\S/.test(child.value ?? "")) {
      continue;
    }
    hasNonWhitespaceContent = true;
  }
  if (!hasMedia) return "none";
  return hasNonWhitespaceContent ? "mixed-media" : "media-only";
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
