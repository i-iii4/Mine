import { scrollBehavior } from "@/lib/motion";
import { commandById } from "@/lib/commandRegistry";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  type ComponentType,
  type CSSProperties,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useDraggable } from "@dnd-kit/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import type { Components } from "react-markdown";
import {
  CloudDownload,
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
import { ChromeRow, ChromeActions } from "@/components/ChromeRow";
import {
  MetadataRow,
  MetadataLinkValue,
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
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
import { preprocessWikilinks, inlineMediaOccurrenceIndex, markdownSourceByteOffset, firstImageOffset } from "@/lib/markdownWikilinks";
import { decodeLocalMarkdownUrl, decodeWikilinkHref } from "@/lib/markdownWikilinks";
import {
  thumbnailUrl,
  mediaUrl,
  previewAssetUrl,
  domainFromUrl,
  isSafeUrl,
  fallbackThumbsRoot,
} from "@/lib/assets";
import { safeMarkdownUrl } from "@/lib/markdownUrl";
import {
  CLOUD_BADGE_DELAY_MS,
  CLOUD_DOWNLOADING_LABEL,
  CLOUD_OFFLINE_LABEL,
} from "@/lib/cloudContent";
import { cn } from "@/lib/utils";
import { useTopFadeMask } from "@/hooks/useTopFadeMask";
import { TopFadeScrim } from "./TopFadeScrim";
import { getDisplayTitle, getFallbackLabel, getNavigationLabel } from "@/lib/displayTitle";
import { copyMediaAssetToClipboard, getBlock, icloudDownloadProgress, prepareDeleteMediaAsset, resolveNoteLink } from "@/lib/commands";
import { collectionRefLabel } from "@/lib/collections";
import { getHoverPreviewOpenDelay } from "@/lib/hoverPreviewTiming";
import {
  findPreviewTileForSource,
  normalizeDetailPreviewManifest,
} from "@/lib/feedPreview";
import { deriveCardContent } from "@/lib/cardLayout";
import { parseYoutubeSource } from "@/lib/youtubeSource";
import { YoutubeSourcePlayer } from "@/components/YoutubeSourcePlayer";
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
import { ARTICLE_AUDIO_ENABLED } from "@/lib/featureFlags";
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
import { CardRow } from "./CardRow";
import { CardRowActions, cardRowActionsReservePx } from "./CardRowActions";
import { deriveSearchResultRow } from "@/lib/searchResultRow";
import type { ImagePreviewRequest, ImagePreviewSibling } from "./ImagePreviewOverlay";
import { copyTextToClipboard } from "@/lib/clipboard";

// The open card's layout (SPEC_FRONTEND.md, Detail; user's decision of
// 07.10.2026): the side panel never takes space from the content. The content
// stands at its full width beside the fixed 20rem panel while three insets,
// that width and the panel fit; past that the view stacks at once, content
// centred and the panel's sections under it at the same width. Scroll content
// and fixed metadata share one grid; insets and the top offset follow the
// app-wide edge rhythm.
const DETAIL_RAIL_GRID_CLASSES = "grid w-full pt-[var(--card-content-pad)]";
const DETAIL_STACKED_LAYOUT_CLASSES =
  "grid w-full grid-cols-[var(--card-content-pad)_minmax(0,1fr)_var(--card-content-pad)] pt-[var(--card-content-pad)]";
/// The reading column, `48rem`: the content's full width, unless a lone
/// picture's own size is smaller.
const DETAIL_CONTENT_MAX_WIDTH_PX = 768;
const DETAIL_RAIL_WIDTH_PX = 320;
/// `--card-content-pad` until its probe is measured: the default edge rhythm.
const DETAIL_CONTENT_PAD_FALLBACK_PX = 32;
/// A picture in the open card is at most `85vh` tall (DetailImage).
const DETAIL_MEDIA_MAX_VIEWPORT_HEIGHT_SHARE = 0.85;
const DETAIL_METADATA_CARD_MIN_WIDTH_PX = 240;
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
  onDeleteSourceVideo?: (slug: string) => Promise<void>;
  onSourceVideoDownloaded?: () => Promise<void>;
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

/// Only the feed's light shape carries this: a block fetched by slug does not
/// know where its media currently lives, and absence means nothing claims it
/// is in the cloud. See SPEC_CLOUD_STORAGE.md Х5.
function isContentInCloud(block: LightBlock | IndexedBlock): boolean {
  return "content_in_cloud" in block && block.content_in_cloud === true;
}

type HoverPreviewPosition = {
  top: number;
  left: number;
};

type HoverPreviewBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type HoveredRelatedNote = {
  rowKey: string;
  slug: string;
};

const noopMediaAssetConnect = async (_asset: MediaAssetRef, _tag: string) => {};
const noopMediaAssetRename = async (_asset: MediaAssetRef, _newStem: string) => {};
const noopMediaAssetDelete = async (_asset: MediaAssetRef) => {};
const noopSourceVideoDelete = async (_slug: string) => {};
const noopSourceVideoDownloaded = async () => {};
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
    const src = frame
      .querySelector("img:not([data-detail-preview-backing])")
      ?.getAttribute("src");
    if (mediaRef && src) found.push({ src, mediaRef });
  }
  return found;
}

function getElementLayoutWidth(node: HTMLElement): number {
  const measuredWidth = node.getBoundingClientRect().width;
  if (measuredWidth > 0) return measuredWidth;
  return window.innerWidth;
}

/**
 * The content's full width in the open card (SPEC_FRONTEND.md, Detail): the
 * reading column, or a lone picture's own size when it is smaller (its
 * natural width, or the width it takes at `85vh`, as DetailImage draws it).
 * One rule for every card: what decides is the content, not a kind.
 */
export function detailContentFullWidth(
  block: LightBlock | IndexedBlock,
  viewportHeight: number,
): number {
  if (deriveCardContent(block).source !== "image") return DETAIL_CONTENT_MAX_WIDTH_PX;
  const manifest = normalizeDetailPreviewManifest(block.preview_manifest);
  const width = block.width ?? manifest?.width ?? null;
  const height = block.height ?? manifest?.height ?? null;
  if (!width || !height || width <= 0 || height <= 0 || viewportHeight <= 0) {
    return DETAIL_CONTENT_MAX_WIDTH_PX;
  }
  const atHeightLimit = (DETAIL_MEDIA_MAX_VIEWPORT_HEIGHT_SHARE * viewportHeight * width) / height;
  return Math.max(1, Math.round(Math.min(DETAIL_CONTENT_MAX_WIDTH_PX, width, atHeightLimit)));
}

/** Whether the content at full width, the panel and three insets do not fit. */
export function detailLayoutIsStacked(
  containerWidth: number,
  contentPadPx: number,
  contentWidth: number,
): boolean {
  return containerWidth < 3 * contentPadPx + contentWidth + DETAIL_RAIL_WIDTH_PX;
}

/** The open card's container width, `--card-content-pad` and the window's
 *  height, kept current as the window and the edge rhythm change. */
function useDetailLayoutMetrics() {
  const containerRef = useRef<HTMLDivElement>(null);
  const padProbeRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<
    { width: number; pad: number; viewportHeight: number } | null
  >(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const measure = () => {
      const pad = padProbeRef.current?.getBoundingClientRect().width ?? 0;
      const next = {
        width: getElementLayoutWidth(node),
        pad: pad > 0 ? pad : DETAIL_CONTENT_PAD_FALLBACK_PX,
        viewportHeight: window.innerHeight,
      };
      setMetrics((current) => (
        current
        && current.width === next.width
        && current.pad === next.pad
        && current.viewportHeight === next.viewportHeight
          ? current
          : next
      ));
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    if (padProbeRef.current) observer?.observe(padProbeRef.current);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, []);

  return { containerRef, padProbeRef, metrics };
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
  onDeleteSourceVideo = noopSourceVideoDelete,
  onSourceVideoDownloaded = noopSourceVideoDownloaded,
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
  const {
    containerRef: detailLayoutRef,
    padProbeRef: detailPadProbeRef,
    metrics: detailLayoutMetrics,
  } = useDetailLayoutMetrics();
  const contentWidth = detailContentFullWidth(
    displayBlock,
    detailLayoutMetrics?.viewportHeight ?? window.innerHeight,
  );
  const isStackedLayout = detailLayoutMetrics !== null
    && detailLayoutIsStacked(detailLayoutMetrics.width, detailLayoutMetrics.pad, contentWidth);
  const layoutClasses = isStackedLayout
    ? DETAIL_STACKED_LAYOUT_CLASSES
    : DETAIL_RAIL_GRID_CLASSES;
  // Beside the panel the content's column is exactly its full width; the
  // spare room goes to the two flexible tracks around it.
  const layoutStyle: CSSProperties | undefined = isStackedLayout
    ? undefined
    : {
        gridTemplateColumns: `minmax(var(--card-content-pad),1fr) ${contentWidth}px minmax(var(--card-content-pad),1fr) ${DETAIL_RAIL_WIDTH_PX}px var(--card-content-pad)`,
      };
  const articleColumnClasses = isStackedLayout
    ? "col-start-2 min-w-0 mx-auto w-full"
    : "col-start-2 min-w-0";
  const stackedColumnStyle: CSSProperties | undefined = isStackedLayout
    ? { maxWidth: contentWidth }
    : undefined;

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

  // The header names the file; the folder it sits in (Cards/, Media/) only
  // in the hint. Paths are relative to the space root.
  const filePath = displayBlock.media_file ?? `${displayBlock.slug}.md`;
  const filename = filePath.slice(filePath.lastIndexOf("/") + 1);
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
        <ChromeRow as="header" separator="bottom"
          separatorProps={{ className: "detail-top-bar-line-enter", "data-entered": chromeEntered ? "true" : "false" }}
          data-entered={chromeEntered ? "true" : "false"}
          className={cn(
            "detail-top-bar-enter gap-1 pl-[var(--chrome-edge-pad)]",
            "bg-accent",
          )}
          data-detail-top-menu="classic"
        >
          <div
            // The card's name is not dragged: a double click renames the
            // card (05.10.2026).
            onDoubleClick={() => onRequestRename(displayBlock)}
            className="min-w-0 flex-1 select-none truncate font-mono text-sm text-muted-foreground"
            data-detail-card-name
            title={filePath}
          >
            {filename}
          </div>
          <ChromeActions>
          <CardMoreMenu
            block={displayBlock}
            vaultPath={vaultPath}
            tags={tags}
            currentTag={currentTag}
            onToggleTag={onToggleTag}
            onCreateAndAssign={onCreateAndAssign}
            onRequestRename={onRequestRename}
            onRequestDelete={onRequestDelete}
            triggerVariant="chrome"
            openRequestSequence={topMenuRequestSequence}
            onOpenChange={setTopMenuOpen}
          />
          <ChromeCloseButton label="Close" onClick={onClose} />
          </ChromeActions>
        </ChromeRow>
      )}
      <div
        ref={detailLayoutRef}
        className={cn(
          "relative min-h-0 flex-1",
          isClosing && "opacity-0",
        )}
        data-detail-layout-mode={isStackedLayout ? "stacked" : "rail"}
        data-detail-content-width={contentWidth}
      >
        {/* Measures `--card-content-pad` for the stacking rule. */}
        <div
          ref={detailPadProbeRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute top-0 left-0 h-0 w-[var(--card-content-pad)]"
          data-detail-pad-probe
        />
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
            style={layoutStyle}
            data-detail-layout-grid="scroll"
          >
            <div className={articleColumnClasses} style={stackedColumnStyle} data-detail-article-column>
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
                onDeleteSourceVideo={onDeleteSourceVideo}
                onSourceVideoDownloaded={onSourceVideoDownloaded}
                onOpenImagePreview={onOpenImagePreview}
                onOpenRelatedNote={onOpenRelatedNote}
                onTextSelectionDrop={onTextSelectionDrop}
                onCreateChannelAndTextSelectionCard={onCreateChannelAndTextSelectionCard}
                onTextSelectionDelete={onTextSelectionDelete}
              />
            </div>
            {isStackedLayout ? (
              <div
                className="col-start-2 mx-auto mt-[var(--card-content-pad)] w-full min-w-0"
                style={stackedColumnStyle}
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
                  onRequestRename={onRequestRename}
                  onRequestDelete={onRequestDelete}
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
              style={layoutStyle}
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
                  onRequestRename={onRequestRename}
                  onRequestDelete={onRequestDelete}
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
  onRequestRename: (block: LightBlock | IndexedBlock) => void;
  onRequestDelete: (slug: string) => void;
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
  onRequestRename,
  onRequestDelete,
  onOpenRelatedNote,
}: MetadataPanelProps) {
  const relatedNoteRowRefs = useRef(new Map<string, HTMLElement>());
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
    const button = relatedNoteRowRefs.current.get(hoveredRelatedNote.rowKey);
    if (!button) {
      setHoverPreviewPosition(null);
      return;
    }

    const triggerRect = button.getBoundingClientRect();
    const previewHeight =
      hoverPreviewRef.current?.getBoundingClientRect().height ??
      HOVER_CARD_FALLBACK_HEIGHT;
    setHoverPreviewPosition(computeHoverPreviewPosition(triggerRect, previewHeight, hoverPreviewBounds(button)));
  }, [hoveredRelatedNote, hoveredRelatedNoteBlock]);

  useEffect(() => {
    if (!hoveredRelatedNote || !hoverPreviewPosition || !hoverPreviewRef.current) {
      return;
    }
    const button = relatedNoteRowRefs.current.get(hoveredRelatedNote.rowKey);
    if (!button) return;

    const triggerRect = button.getBoundingClientRect();
    const previewHeight = hoverPreviewRef.current.getBoundingClientRect().height;
    const nextPosition = computeHoverPreviewPosition(triggerRect, previewHeight, hoverPreviewBounds(button));
    if (
      Math.abs(nextPosition.top - hoverPreviewPosition.top) > 1 ||
      Math.abs(nextPosition.left - hoverPreviewPosition.left) > 1
    ) {
      setHoverPreviewPosition(nextPosition);
    }
  }, [hoveredRelatedNote, hoverPreviewPosition, hoveredRelatedNoteBlock]);


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
        {ARTICLE_AUDIO_ENABLED && (
          <ArticleAudioControls
            slug={displayBlock.slug}
            blockType={displayBlock.card_kind === "article" ? "article" : displayBlock.card_kind}
            url={displayBlock.url}
          />
        )}

        <div className="flex min-w-0 flex-col gap-6" data-metadata-sections>
          <DetailPanelCard data-detail-metadata-card>
            <div className="px-2 pb-4 pt-4" data-detail-metadata-card-content>
              <MetadataTable>
                {displayBlock.width != null && displayBlock.height != null && (
                  <MetadataField
                    label="Resolution"
                    value={`${displayBlock.width} \u00d7 ${displayBlock.height}`}
                  />
                )}
                <MetadataField label="Date" value={formattedDate} />

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
          </DetailPanelCard>

          {relatedNotes.length > 0 && (
            <RelatedNotesSection
              relatedNotes={relatedNotes}
              relatedNoteBlocks={relatedNoteBlocks}
              resolvedThumbsRoot={resolvedThumbsRoot}
              vaultPath={vaultPath}
              tags={tags}
              currentTag={currentTag}
              onToggleTag={onToggleTag}
              onCreateAndAssign={onCreateAndAssign}
              onRequestRename={onRequestRename}
              onRequestDelete={onRequestDelete}
              onOpenRelatedNote={onOpenRelatedNote}
              relatedNoteRowRefs={relatedNoteRowRefs}
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

/**
 * A card of the open card's panel: the metadata with its buttons, and the
 * Related notes. The card's surface, the level of the second chrome row, in
 * both themes (user's decision of 06.10.2026); 8 px inset inside.
 */
function DetailPanelCard({ className, style, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn("overflow-hidden rounded-[var(--radius-card)] border border-border bg-card", className)}
      style={{ minWidth: DETAIL_METADATA_CARD_MIN_WIDTH_PX, ...style }}
      data-detail-panel-card
      {...props}
    />
  );
}

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
          className="min-w-0 flex-1 cursor-pointer"
          onClick={() => openUrl(block.url!)}
        >
          Source
          <ExternalLink className="size-[13px]" />
        </Button>
      )}

      <DropdownMenu open={connectOpen} onOpenChange={setConnectOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="default"
            size="default"
            className="min-w-0 flex-1"
          >
            Connect
            <Plus className="size-[13px]" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className={COLLECTION_PICKER_CONTENT_CLASS} align="start">
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

/**
 * The open card's Related notes: the search's own rows (`CardRow`, user's
 * decision of 07.10.2026) in a card of the panel, like the metadata above
 * it. Each row shows the note's file name and, dimmed, the start of its
 * text; under the pointer the row lights up and shows the card's commands
 * (Connect, Source, More) at its right end, as a search result does. A press
 * elsewhere on the row opens the note.
 */
function RelatedNotesSection({
  relatedNotes,
  relatedNoteBlocks,
  resolvedThumbsRoot,
  vaultPath,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
  onOpenRelatedNote,
  relatedNoteRowRefs,
  onRelatedNotePreviewEnter,
  onRelatedNotePreviewLeave,
}: {
  relatedNotes: string[];
  relatedNoteBlocks: Map<string, IndexedBlock | null> | null;
  resolvedThumbsRoot: string;
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestRename: (block: LightBlock | IndexedBlock) => void;
  onRequestDelete: (slug: string) => void;
  onOpenRelatedNote: (slug: string) => void;
  relatedNoteRowRefs: { current: Map<string, HTMLElement> };
  onRelatedNotePreviewEnter: (note: HoveredRelatedNote) => void;
  onRelatedNotePreviewLeave: () => void;
}) {
  // The row the pointer is on, by row identity: a note linked twice is two
  // rows. Leaving the row or turning the wheel lets go of it.
  const [pointerRowKey, setPointerRowKey] = useState<string | null>(null);
  // The row whose menu is open holds its commands and its light; the
  // pointer on its way to the menu moves nothing (SPEC_CARD_STATES.md, С7.8).
  const [menuRowKey, setMenuRowKey] = useState<string | null>(null);

  // A closed row menu gives focus back to the page, not to its hidden
  // button: the open card's own keys keep working.
  const handleMenuCloseAutoFocus = useCallback((event: Event) => {
    event.preventDefault();
  }, []);

  return (
    <DetailPanelCard data-related-notes-block>
      {/* A label of the card, at the metadata labels' inset and over the
          rows' thumbnails. */}
      <div className={cn(METADATA_LABEL_CLASSES, "px-2 pt-4")}>Related notes</div>
      {/* The rows' light keeps 4 px off the frame on every side. */}
      <div
        className="flex w-full min-w-0 flex-col p-1"
        onWheel={() => setPointerRowKey(null)}
        data-related-notes-list
      >
        {relatedNotes.map((slug, index) => {
          const baseSlug = baseRelatedNoteSlug(slug);
          const rowKey = `${index}:${slug}`;
          const relatedBlock = relatedNoteBlocks?.get(baseSlug) ?? null;

          if (!relatedBlock) {
            // Still loading, or a link to a note that is gone: the name
            // alone, dimmed, nothing to open.
            return (
              <CardRow
                key={rowKey}
                row={deriveSearchResultRow({ slug: baseSlug, preview_text: null })}
                preview={null}
                active={false}
                framed
                item={{ as: "static" }}
                data-related-note-item="placeholder"
              />
            );
          }

          const holdsMenu = menuRowKey === rowKey;
          const actionsShown = holdsMenu || (menuRowKey === null && pointerRowKey === rowKey);
          return (
            <CardRow
              key={rowKey}
              rowRef={(node) => {
                if (node) {
                  relatedNoteRowRefs.current.set(rowKey, node);
                } else {
                  relatedNoteRowRefs.current.delete(rowKey);
                }
              }}
              row={deriveSearchResultRow(relatedBlock)}
              preview={microPreviewFromIndexedBlock(relatedBlock, resolvedThumbsRoot)}
              active={actionsShown}
              actionsReservePx={actionsShown ? cardRowActionsReservePx(relatedBlock) : 0}
              framed
              onPointerMove={() => {
                if (menuRowKey === null && pointerRowKey !== rowKey) setPointerRowKey(rowKey);
              }}
              onPointerLeave={() => {
                setPointerRowKey((current) => (current === rowKey ? null : current));
              }}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onMouseEnter={() => {
                if (menuRowKey === null) onRelatedNotePreviewEnter({ rowKey, slug: baseSlug });
              }}
              onMouseLeave={onRelatedNotePreviewLeave}
              item={{
                as: "button",
                props: {
                  onClick: (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onOpenRelatedNote(baseSlug);
                  },
                },
              }}
              actions={(actionsShown || pointerRowKey === rowKey) && (
                <CardRowActions
                  block={relatedBlock}
                  vaultPath={vaultPath}
                  tags={tags}
                  currentTag={currentTag}
                  visible={actionsShown}
                  onToggleTag={onToggleTag}
                  onCreateAndAssign={onCreateAndAssign}
                  onRequestRename={onRequestRename}
                  onRequestDelete={onRequestDelete}
                  onMenuOpenChange={(_slug, open) => {
                    setMenuRowKey((current) => (open ? rowKey : current === rowKey ? null : current));
                    // The card preview steps aside for the menu.
                    if (open) onRelatedNotePreviewLeave();
                  }}
                  onMenuCloseAutoFocus={handleMenuCloseAutoFocus}
                />
              )}
              data-related-note-item="button"
            />
          );
        })}
      </div>
    </DetailPanelCard>
  );
}

/**
 * Cards that reference a media file, in its delete confirmation: compact
 * card-reference rows that open the card.
 */
function CardReferenceList({
  references,
  referenceBlocks,
  fallbackLabels,
  resolvedThumbsRoot,
  onOpenReference,
  referenceRowRefs,
  onReferencePreviewEnter,
  onReferencePreviewLeave,
}: {
  references: string[];
  referenceBlocks: Map<string, IndexedBlock | null> | null;
  fallbackLabels: Map<string, string>;
  resolvedThumbsRoot: string;
  onOpenReference: (slug: string) => void;
  referenceRowRefs: { current: Map<string, HTMLElement> };
  onReferencePreviewEnter: (note: HoveredRelatedNote) => void;
  onReferencePreviewLeave: () => void;
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-1" data-card-reference-list>
      {references.map((slug, index) => {
        const baseSlug = baseRelatedNoteSlug(slug);
        const rowKey = `${index}:${slug}`;
        const referenceBlock = referenceBlocks?.get(baseSlug) ?? null;
        const rowLabel = referenceBlock
          ? getFallbackLabel(referenceBlock)
          : fallbackLabels.get(baseSlug) ?? baseSlug;

        if (!referenceBlock) {
          return (
            <CardReferenceRow
              key={slug}
              label={rowLabel}
              preview={null}
              className="text-muted-foreground"
              data-card-reference-item="placeholder"
            />
          );
        }

        return (
          <CardReferenceButton
            key={rowKey}
            label={rowLabel}
            preview={microPreviewFromIndexedBlock(referenceBlock, resolvedThumbsRoot)}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpenReference(baseSlug);
            }}
            className="text-muted-foreground"
            ref={(node) => {
              if (node) {
                referenceRowRefs.current.set(rowKey, node);
              } else {
                referenceRowRefs.current.delete(rowKey);
              }
            }}
            onMouseEnter={() => onReferencePreviewEnter({ rowKey, slug: baseSlug })}
            onMouseLeave={onReferencePreviewLeave}
            data-card-reference-item="button"
          />
        );
      })}
    </div>
  );
}

function getIndexWarning(block: LightBlock | IndexedBlock): string | null {
  return "index_warning" in block ? block.index_warning ?? null : null;
}

function baseRelatedNoteSlug(target: string): string {
  return target.split("#", 1)[0] ?? target;
}

/**
 * Where a row's card preview may stand: the open card's own area. Beyond it
 * the sidebar and the window's chrome cover the preview. A row outside an
 * open card (a dialog over the window) has the whole window.
 */
export function hoverPreviewBounds(anchor: Element): HoverPreviewBounds {
  const area = anchor.closest("[data-detail-root]");
  if (area) {
    const rect = area.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}

/**
 * Beside the row when the area has room on its right, else on its left. A
 * row as wide as the area (the stacked view) has room on neither side: the
 * preview then stands under the row, or over it when there is no room below,
 * starting at the row's left edge. The preview never leaves the area.
 */
export function computeHoverPreviewPosition(
  triggerRect: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  previewHeight: number,
  bounds: HoverPreviewBounds,
): HoverPreviewPosition {
  const minLeft = bounds.left + HOVER_CARD_VIEWPORT_MARGIN;
  const maxRight = bounds.right - HOVER_CARD_VIEWPORT_MARGIN;
  const minTop = bounds.top + HOVER_CARD_VIEWPORT_MARGIN;
  const maxBottom = bounds.bottom - HOVER_CARD_VIEWPORT_MARGIN;
  const fitsRight = triggerRect.right + HOVER_CARD_GAP + HOVER_CARD_WIDTH <= maxRight;
  const fitsLeft = triggerRect.left - HOVER_CARD_GAP - HOVER_CARD_WIDTH >= minLeft;
  if (fitsRight || fitsLeft) {
    const canOpenDown = triggerRect.top + previewHeight <= maxBottom;
    return {
      left: fitsRight
        ? triggerRect.right + HOVER_CARD_GAP
        : triggerRect.left - HOVER_CARD_GAP - HOVER_CARD_WIDTH,
      top: canOpenDown
        ? Math.max(minTop, triggerRect.top)
        : Math.max(minTop, triggerRect.bottom - previewHeight),
    };
  }
  const fitsBelow = triggerRect.bottom + HOVER_CARD_GAP + previewHeight <= maxBottom;
  return {
    left: Math.max(minLeft, Math.min(triggerRect.left, maxRight - HOVER_CARD_WIDTH)),
    top: fitsBelow
      ? triggerRect.bottom + HOVER_CARD_GAP
      : Math.max(minTop, triggerRect.top - HOVER_CARD_GAP - previewHeight),
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

function resolveDetailMediaReference(vaultPath: string, src: string | null): string | null {
  if (!src) return null;
  return isSafeUrl(src) ? src : mediaUrl(vaultPath, src);
}

function localBodyVideoReferences(body: string, manifest: ReturnType<typeof normalizeDetailPreviewManifest>): string[] {
  const sources: string[] = [];
  function visit(node: Nodes) {
    if (node.type === "image") {
      const source = decodeLocalMarkdownUrl(node.url);
      if (isLocalMediaRef(source) && /\.(?:mp4|webm|m4v|mov)$/i.test(source)) {
        sources.push(findPreviewTileForSource(manifest, source)?.sourcePath ?? source);
      }
    }
    if ("children" in node) node.children.forEach(visit);
  }
  visit(fromMarkdown(preprocessWikilinks(body)));
  return sources;
}

/** Whether the body holds anything besides one embed of `source`: text, or other media. */
function bodyHasMoreThanEmbed(
  body: string,
  manifest: ReturnType<typeof normalizeDetailPreviewManifest>,
  source: string,
): boolean {
  let skipped = false;
  let more = false;
  function visit(node: Nodes) {
    if (more) return;
    if (node.type === "image") {
      const resolved = findPreviewTileForSource(manifest, decodeLocalMarkdownUrl(node.url))?.sourcePath
        ?? decodeLocalMarkdownUrl(node.url);
      if (!skipped && resolved === source) {
        skipped = true;
      } else {
        more = true;
      }
      return;
    }
    if ((node.type === "text" || node.type === "inlineCode" || node.type === "code") && node.value.trim()) {
      more = true;
      return;
    }
    if ("children" in node) node.children.forEach(visit);
  }
  visit(fromMarkdown(preprocessWikilinks(body)));
  return more;
}

/** Where the lead video's own image starts in `processedBody`: the first image
 * whose source resolves to `source`, the one `bodyHasMoreThanEmbed` sets aside
 * and the body under the player leaves out. `null` when the body has none.
 */
function leadEmbedImageOffset(
  processedBody: string,
  manifest: ReturnType<typeof normalizeDetailPreviewManifest>,
  source: string,
): number | null {
  return firstImageOffset(processedBody, (url) => {
    const decoded = decodeLocalMarkdownUrl(url);
    return (findPreviewTileForSource(manifest, decoded)?.sourcePath ?? decoded) === source;
  });
}

/** The lead video's place among the body's `![`, as Remove names it to the
 * core: the same image the body under the player leaves out, so an image
 * before it in the body does not shift it (SPEC_AUDIT_FIXES.md, Д1.1).
 */
function leadEmbedOccurrenceIndex(
  body: string,
  manifest: ReturnType<typeof normalizeDetailPreviewManifest>,
  source: string,
): number | null {
  const offset = leadEmbedImageOffset(preprocessWikilinks(body), manifest, source);
  return offset === null ? null : inlineMediaOccurrenceIndex(body, offset);
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

/// The local preview to show while the original is still arriving.
///
/// The original may be on a slow disk or held in iCloud, where a read blocks
/// until the file is fetched in full. The preview is derived, local and
/// permanent, so the card can be complete from the first frame and swap in the
/// original when it lands. See SPEC_CLOUD_STORAGE.md Х8.
function detailBackingPreviewSource({
  block,
  previewManifest,
  thumbsRootPath,
}: {
  block: LightBlock | IndexedBlock;
  previewManifest: ReturnType<typeof normalizeDetailPreviewManifest>;
  thumbsRootPath: string;
}): string | null {
  if (previewManifest?.primaryPreviewPath) {
    return previewAssetUrl(thumbsRootPath, previewManifest.primaryPreviewPath);
  }
  return thumbnailUrl(thumbsRootPath, block.slug);
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
  onDeleteSourceVideo,
  onSourceVideoDownloaded,
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
  onDeleteSourceVideo: (slug: string) => Promise<void>;
  onSourceVideoDownloaded: () => Promise<void>;
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
  // The record's source decides how the open card shows its media; the feed
  // card's look does not (SPEC_CARD_UNIFIED.md, Е1).
  const content = useMemo(
    () => deriveCardContent(fullBlock ?? block),
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
  const sourceVideo = parseYoutubeSource(block.url);
  const bodyVideoReferences = useMemo(() => localBodyVideoReferences(body, previewManifest), [body, previewManifest]);
  const mainVideoIsInBody = !!block.media_file && bodyVideoReferences.some((source) => (
    source === block.media_file || (!source.includes("/") && block.media_file?.endsWith(`/${source}`))
  ));
  const primaryLocalVideo = block.media_file
    && !isSafeUrl(block.media_file)
    && /\.(?:mp4|webm|m4v|mov)$/i.test(block.media_file)
    ? resolveDetailMediaReference(vaultPath, block.media_file)
    : null;
  const sourcePlayer = sourceVideo && !primaryLocalVideo && bodyVideoReferences.length === 0 ? (
    <YoutubeSourcePlayer
      key={sourceVideo.videoId}
      source={sourceVideo}
      poster={block.thumbnail && !isSafeUrl(block.thumbnail)
        ? resolveDetailMediaReference(vaultPath, block.thumbnail)
        : null}
      title={displayTitle ?? navigationLabel}
      slug={block.slug}
      onDelete={() => onDeleteSourceVideo(block.slug)}
      onDownloaded={onSourceVideoDownloaded}
    />
  ) : null;

  switch (block.card_kind) {
    case "article": {
      return (
        <div>
          {primaryLocalVideo && sourceVideo && !mainVideoIsInBody ? (
            <MediaAssetActionFrame
              asset={mediaAssetFromPrimary(block, "video")}
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
              <VideoFromBlob key={primaryLocalVideo} src={primaryLocalVideo} controls className="mb-6 block max-h-[85vh] max-w-full" />
            </MediaAssetActionFrame>
          ) : sourcePlayer}
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
      if (sourcePlayer) return <div>{sourcePlayer}</div>;
      if (content.source === "link" && previewManifest?.kind !== "text") {
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
      if (content.source === "image") {
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
              <DetailImage
                key={src}
                src={src}
                sourceWidth={block.width ?? previewManifest?.width}
                sourceHeight={block.height ?? previewManifest?.height}
                previewSrc={detailBackingPreviewSource({
                  block,
                  previewManifest,
                  thumbsRootPath: resolvedThumbsRoot,
                })}
                contentInCloud={isContentInCloud(block)}
                mediaRef={block.media_file}
                alt={navigationLabel}
                className="block max-h-[85vh] max-w-full object-contain"
              />
            </MediaAssetActionFrame>
          </div>
        );
      }

      if (content.source === "link") {
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

      if (content.source === "video") {
        const videoSourcePath =
          content.media?.items.find((item) => item.isVideo)?.sourcePath
          ?? block.media_file;
        const localSrc = resolveDetailMediaReference(vaultPath, videoSourcePath);
        // The lead video is either the primary file or the body's first video
        // embed. In the second case the body below must not show it again.
        const leadIsBodyEmbed = !!videoSourcePath
          && videoSourcePath !== block.media_file
          && bodyVideoReferences.includes(videoSourcePath);
        const omittedEmbed = leadIsBodyEmbed && videoSourcePath
          ? { source: videoSourcePath }
          : null;
        const showBody = !!body && (!omittedEmbed || bodyHasMoreThanEmbed(body, previewManifest, omittedEmbed.source));
        return (
          <div className="flex min-h-full flex-col">
            <div className="flex flex-1 items-center justify-center">
              {sourcePlayer ? (
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
                  {sourcePlayer}
                </MediaAssetActionFrame>
              ) : localSrc ? (
                <MediaAssetActionFrame
                  asset={videoSourcePath
                    ? leadIsBodyEmbed
                      ? mediaAssetFromMediaRef(
                        block.slug,
                        videoSourcePath,
                        "video",
                        "body_embed",
                        leadEmbedOccurrenceIndex(body, previewManifest, videoSourcePath) ?? undefined,
                      )
                      : mediaAssetFromMediaRef(block.slug, videoSourcePath, "video", "frontmatter_file")
                    : null}
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
                  {/* Plays on its own, muted and looping, like a video inside
                      an article and like the feed. */}
                  <VideoFromBlob
                    key={localSrc}
                    src={localSrc}
                    controls
                    autoPlay
                    muted
                    loop
                    className="block h-auto max-h-[85vh] max-w-full"
                  />
                </MediaAssetActionFrame>
              ) : (
                <div className="flex aspect-video items-center justify-center text-muted-foreground">
                  No video file
                </div>
              )}
            </div>
            {showBody && (
              <div className="p-6">
                <ArticleBody
                  omittedEmbed={omittedEmbed}
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
  const [dialog, setDialog] = useState<MediaAssetDialog | null>(null);
  // Copying reads the file, and reading a file iCloud is holding downloads it
  // first. A local copy finishes instantly; only a copy that outlives the
  // shared badge delay earns an indicator, so fast copies never flash one.
  // See SPEC_CLOUD_STORAGE.md Х13.
  const [copyWaiting, setCopyWaiting] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const beginCopyIndicator = useCallback(() => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyWaiting(true), CLOUD_BADGE_DELAY_MS);
  }, []);
  const endCopyIndicator = useCallback(() => {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    setCopyWaiting(false);
  }, []);
  useEffect(() => endCopyIndicator, [endCopyIndicator]);
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

  const menuItemProps = {
    asset,
    vaultPath,
    tags,
    currentTag,
    onCreateMediaAssetCard,
    onCreateChannelAndMediaAssetCard,
    onCopyStarted: beginCopyIndicator,
    onCopySettled: endCopyIndicator,
    onRequestDialog: setDialog,
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
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
              // The menu opens here, at the pointer; an enclosing surface must not
              // open its own menu over it.
              event.stopPropagation();
            }}
            onDragStart={(event) => {
              if (canDrag) {
                event.preventDefault();
              }
            }}
          >
            {children}
            {copyWaiting && (
              <div
                className="absolute inset-x-0 bottom-0 z-10 flex items-center gap-2 bg-card/90 px-3 py-2"
                data-detail-copy-waiting=""
              >
                <CloudDownload className="size-[13px] text-muted-foreground" aria-hidden="true" />
                <span className="text-sm text-muted-foreground">{CLOUD_DOWNLOADING_LABEL}</span>
              </div>
            )}
            {/* A video has its own controls under the pointer, and the
                ellipsis covered them; its menu opens only on right click. */}
            {asset.media_kind !== "video" && (
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
                    <Expand className="size-[13px]" />
                  </Button>
                )}
                <MediaAssetMoreMenu
                  itemProps={menuItemProps}
                  open={menuOpen}
                  onOpenChange={setMenuOpen}
                />
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent data-detail-media-context-menu>
          <MediaAssetMenuItems kit={CONTEXT_MENU_KIT} {...menuItemProps} />
        </ContextMenuContent>
      </ContextMenu>
      <RenameMediaAssetDialog
        asset={asset}
        open={dialog === "rename"}
        onOpenChange={(open) => setDialog(open ? "rename" : null)}
        onRename={onRenameMediaAsset}
      />
      <RemoveMediaAssetFromCardDialog
        asset={asset}
        open={dialog === "remove"}
        onOpenChange={(open) => setDialog(open ? "remove" : null)}
        onRemove={onRemoveMediaAssetFromCard}
      />
      <DeleteMediaAssetDialog
        asset={asset}
        vaultPath={vaultPath}
        open={dialog === "delete"}
        onOpenChange={(open) => setDialog(open ? "delete" : null)}
        onDelete={onDeleteMediaAsset}
        onOpenRelatedNote={(slug) => {
          setDialog(null);
          setMenuOpen(false);
          onOpenRelatedNote(slug);
        }}
      />
    </>
  );
}

type MediaAssetDialog = "rename" | "remove" | "delete";

/** The primitives a media menu is drawn with: the ellipsis opens a dropdown,
 *  a right click opens a context menu at the pointer. Same items in both. */
interface MediaMenuKit {
  Item: ComponentType<{
    variant?: "default" | "destructive" | "detach";
    onSelect?: (event: Event) => void;
    children?: ReactNode;
  }>;
  Separator: ComponentType;
  Sub: ComponentType<{ open?: boolean; onOpenChange?: (open: boolean) => void; children?: ReactNode }>;
  SubTrigger: ComponentType<{ children?: ReactNode }>;
  SubContent: ComponentType<{ className?: string; children?: ReactNode }>;
}

const DROPDOWN_MENU_KIT: MediaMenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

const CONTEXT_MENU_KIT: MediaMenuKit = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};

interface MediaAssetMenuItemProps {
  asset: MediaAssetRef;
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  onCreateMediaAssetCard: (asset: MediaAssetRef, tag: string) => Promise<void>;
  onCreateChannelAndMediaAssetCard: (asset: MediaAssetRef, tag: string) => Promise<void>;
  onCopyStarted: () => void;
  onCopySettled: () => void;
  onRequestDialog: (dialog: MediaAssetDialog) => void;
}

function MediaAssetMenuItems({
  kit,
  asset,
  vaultPath,
  tags,
  currentTag,
  onCreateMediaAssetCard,
  onCreateChannelAndMediaAssetCard,
  onCopyStarted,
  onCopySettled,
  onRequestDialog,
  connectSubmenuOpen,
  onConnectSubmenuOpenChange,
}: MediaAssetMenuItemProps & {
  kit: MediaMenuKit;
  connectSubmenuOpen?: boolean;
  onConnectSubmenuOpenChange?: (open: boolean) => void;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const mediaPath = mediaAbsolutePath(vaultPath, asset.media_ref);
  const { Item, Separator, Sub, SubTrigger, SubContent } = kit;

  return (
    <>
      <Sub open={connectSubmenuOpen} onOpenChange={onConnectSubmenuOpenChange}>
        <SubTrigger>
          <MenuIconSlot>
            <Plus className="size-[13px]" />
          </MenuIconSlot>
          Create Element
        </SubTrigger>
        <SubContent className={COLLECTION_PICKER_CONTENT_CLASS}>
          <MediaAssetCollectionPicker
            asset={asset}
            tags={tags}
            currentTag={currentTag}
            onConnect={onCreateMediaAssetCard}
            onCreateAndConnect={onCreateChannelAndMediaAssetCard}
          />
        </SubContent>
      </Sub>

      <Separator />

      <Item onSelect={() => revealItemInDir(mediaPath)}>
        <MenuIconSlot />
        Reveal in Finder
      </Item>
      <Item onSelect={() => copyTextToClipboard(mediaPath)}>
        <MenuIconSlot />
        Copy Path
      </Item>
      <Item
        onSelect={(event) => {
          event.preventDefault();
          setActionError(null);
          onCopyStarted();
          void copyMediaAssetToClipboard(asset.media_ref)
            .catch((error) => setActionError(mediaAssetErrorMessage(error)))
            .finally(onCopySettled);
        }}
      >
        <MenuIconSlot />
        Copy Media
      </Item>

      {actionError && (
        <div className="px-2 py-1.5 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <Separator />

      <Item onSelect={() => onRequestDialog("rename")}>
        <MenuIconSlot />
        Rename Media...
      </Item>
      <Item variant="detach" onSelect={() => onRequestDialog("remove")}>
        <MenuIconSlot>
          <Unlink className="size-[13px]" />
        </MenuIconSlot>
        Remove from Element
      </Item>
      <Item variant="destructive" onSelect={() => onRequestDialog("delete")}>
        <MenuIconSlot>
          <Trash2 className="size-[13px]" />
        </MenuIconSlot>
        Delete Media
      </Item>
    </>
  );
}

function MediaAssetMoreMenu({
  itemProps,
  open,
  onOpenChange,
  className,
}: {
  itemProps: MediaAssetMenuItemProps;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}) {
  const [connectSubmenuOpen, setConnectSubmenuOpen] = useState(false);
  const updateRootOpen = useCallback((open: boolean) => {
    if (!open) {
      setConnectSubmenuOpen(false);
    }
    onOpenChange(open);
  }, [onOpenChange]);

  return (
    <DropdownMenu open={open} onOpenChange={updateRootOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="default"
          size="icon"
          className={className}
          aria-label="Media actions"
          data-detail-media-more-button
        >
          <MoreHorizontal className="size-[13px]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <MediaAssetMenuItems
          kit={DROPDOWN_MENU_KIT}
          {...itemProps}
          connectSubmenuOpen={connectSubmenuOpen}
          onConnectSubmenuOpenChange={setConnectSubmenuOpen}
        />
      </DropdownMenuContent>
    </DropdownMenu>
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
  const [selectionActionError, setSelectionActionError] = useState<string | null>(null);
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
    setSelectionActionError(null);
    try {
      if (create) {
        await onCreateAndConnect(payload, tag);
      } else {
        await onConnect(payload, tag);
      }
      setSearch("");
    } catch (error) {
      setSelectionActionError(textSelectionErrorMessage(error));
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
              onSelect={(event) => {
                event.preventDefault();
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
            onSelect={(event) => {
              event.preventDefault();
              void connect(trimmed, true);
            }}
          >
            <Plus className="size-[13px] shrink-0" />
            <span>Create &ldquo;{trimmed}&rdquo;</span>
          </DropdownMenuItem>
        )}

        {filtered.length === 0 && !canCreate && (
          <p className="flex h-[var(--menu-row-height)] items-center justify-center px-2 text-center text-sm text-muted-foreground">
            No collections
          </p>
        )}
      </QuantizedMenuScrollArea>
      {selectionActionError && <p role="alert" className="p-2 text-sm text-destructive">{selectionActionError}</p>}
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
            ) : planError ? null : references.length > 0 ? (
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
                  if (!plan) return;
                  await onDelete({ ...asset, media_ref: plan.media_ref });
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
  const relatedNoteRowRefs = useRef(new Map<string, HTMLElement>());
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
    const button = relatedNoteRowRefs.current.get(hoveredRelatedNote.rowKey);
    if (!button) {
      setHoverPreviewPosition(null);
      return;
    }

    const triggerRect = button.getBoundingClientRect();
    const previewHeight =
      hoverPreviewRef.current?.getBoundingClientRect().height ??
      HOVER_CARD_FALLBACK_HEIGHT;
    setHoverPreviewPosition(computeHoverPreviewPosition(triggerRect, previewHeight, hoverPreviewBounds(button)));
  }, [hoveredRelatedNote, hoveredRelatedNoteBlock]);

  useEffect(() => {
    if (!hoveredRelatedNote || !hoverPreviewPosition || !hoverPreviewRef.current) {
      return;
    }
    const button = relatedNoteRowRefs.current.get(hoveredRelatedNote.rowKey);
    if (!button) return;

    const triggerRect = button.getBoundingClientRect();
    const previewHeight = hoverPreviewRef.current.getBoundingClientRect().height;
    const nextPosition = computeHoverPreviewPosition(triggerRect, previewHeight, hoverPreviewBounds(button));
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
      <CardReferenceList
        references={relatedNotes}
        referenceBlocks={relatedNoteBlocks}
        fallbackLabels={fallbackLabels}
        resolvedThumbsRoot={thumbsRootPath}
        onOpenReference={onOpenRelatedNote}
        referenceRowRefs={relatedNoteRowRefs}
        onReferencePreviewEnter={openRelatedNotePreview}
        onReferencePreviewLeave={requestCloseRelatedNotePreview}
      />
    </>
  );
}

// ─── Markdown renderer for article body ─────────────────────────────────────

function ArticleBody({
  omittedEmbed = null,
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
  /** An embed already shown above the body (a media card's lead video): its
   * first image in the body is not drawn twice. */
  omittedEmbed?: { source: string } | null;
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
  const selectionMenuOpenRef = useRef(false);
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
    const renderedRange = findFirstSelectedMarkdownBlockRange(root, selection);
    const start = renderedRange ? markdownSourceByteOffset(body, renderedRange.start) : null;
    const end = renderedRange ? markdownSourceByteOffset(body, renderedRange.end) : null;
    const range = start !== null && end !== null ? { start, end } : null;
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
    if (selectionHandleLockedRef.current || selectionMenuOpenRef.current) {
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

  const handleTextSelectionDelete = useCallback(async (payload: MineTextSelectionDragPayload) => {
    await onTextSelectionDelete?.(payload);
    setSelectionHandle(null);
    window.getSelection()?.removeAllRanges();
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
  // The lead video's own image in the body: the first one of its source, the
  // one `bodyHasMoreThanEmbed` sets aside and the player's Remove names.
  const omittedSource = omittedEmbed?.source ?? null;
  const omittedImageOffset = useMemo(
    () => omittedSource === null
      ? null
      : leadEmbedImageOffset(processedBody, previewManifest, omittedSource),
    [omittedSource, previewManifest, processedBody],
  );

  useEffect(() => {
    if (!scrollAnchor || !articleRef.current) return;
    const root = articleRef.current;
    const frame = window.requestAnimationFrame(() => {
      const element = findElementForBlockAnchor(root, scrollAnchor);
      if (!element) return;
      element.scrollIntoView?.({ block: "center", behavior: scrollBehavior() });
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
        // Where this image stands among the body's `![`: Remove takes away
        // this one image and no other of the same file (Г1.4).
        const nodeStartOffset = (node as MarkdownPositionedNode | undefined)?.position?.start?.offset;
        const occurrenceIndex = typeof nodeStartOffset === "number"
          ? inlineMediaOccurrenceIndex(body, nodeStartOffset) ?? undefined
          : undefined;
        if (omittedImageOffset !== null && nodeStartOffset === omittedImageOffset) {
          return null;
        }
        // Video/GIF (downloaded MP4) — render as inline autoplay video with controls.
        // Autoplay must stay muted to satisfy browser/WebView media policies.
        if (/\.(?:mp4|webm|m4v|mov)(?:\?|$)/i.test(decodedSrc)) {
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
                // Height must follow the shrunken width, or the element keeps
                // its intrinsic height and letterboxes the frame — dark bars
                // that read as extra spacing under the video.
                className="h-auto max-w-full rounded-0"
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
              key={originalSrc}
              src={originalSrc}
              sourceWidth={previewTile?.width}
              sourceHeight={previewTile?.height}
              previewSrc={previewSrc}
              alt={alt ?? ""}
              className="rounded-0"
              {...props}
            />
          </MediaAssetActionFrame>
        );
      },
      a: ({ href, children, ...props }) => {
        const wikilinkTarget = decodeWikilinkHref(href);
        return (
          <a
            href={href}
            target={wikilinkTarget === null ? "_blank" : undefined}
            rel={wikilinkTarget === null ? "noopener noreferrer" : undefined}
            {...props}
            onClick={(event) => {
              if (wikilinkTarget === null) return;
              event.preventDefault();
              if (!sourceSlug) return;
              void resolveNoteLink(sourceSlug, wikilinkTarget)
                .then((slug) => { if (slug) onOpenRelatedNote(slug); })
                .catch((error) => { console.error("Failed to resolve note link:", error); });
            }}
          >
            {children}
          </a>
        );
      },
    }),
    [
      body,
      currentTag,
      omittedImageOffset,
      onCreateMediaAssetCard,
      onCreateChannelAndMediaAssetCard,
      onDeleteMediaAsset,
      onOpenImagePreview,
      onOpenRelatedNote,
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
      className="prose prose-sm max-w-none [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_li]:leading-5 [&_p]:leading-5"
      data-article-body
      data-content-font=""
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
          onMenuOpenChange={(open) => { selectionMenuOpenRef.current = open; }}
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
  onMenuOpenChange,
  onDismiss,
}: {
  state: TextSelectionHandleState;
  tags: TagCount[];
  currentTag?: string;
  onCreateCard?: (payload: MineTextSelectionDragPayload, tag: string) => void | Promise<void>;
  onCreateChannelAndCard: (
    payload: MineTextSelectionDragPayload,
    tag: string,
  ) => Promise<void>;
  onDelete?: (payload: MineTextSelectionDragPayload) => void | Promise<void>;
  onInteractionStart: () => void;
  onMenuOpenChange: (open: boolean) => void;
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const updateConnectOpen = (open: boolean) => {
    onMenuOpenChange(open);
    setConnectOpen(open);
  };
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
        <GripVertical className="size-[13px]" aria-hidden="true" />
      </Button>

      {onCreateCard && (
        <DropdownMenu open={connectOpen} onOpenChange={updateConnectOpen} modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="default"
              size="xs"
              onMouseDown={(event) => {
                event.preventDefault();
              }}
            >
              <Plus className="size-[13px]" aria-hidden="true" />
              Create Element
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
           
            className={COLLECTION_PICKER_CONTENT_CLASS}
            align="start"
          >
            <TextSelectionCollectionPicker
              payload={state.payload}
              tags={tags}
              currentTag={currentTag}
              onConnect={async (payload, tag) => {
                await onCreateCard(payload, tag);
                updateConnectOpen(false);
                onDismiss();
              }}
              onCreateAndConnect={async (payload, tag) => {
                await onCreateChannelAndCard(payload, tag);
                updateConnectOpen(false);
                onDismiss();
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
          disabled={deleting}
          onClick={async () => {
            setDeleting(true);
            setActionError(null);
            onMenuOpenChange(true);
            try {
              await onDelete(state.payload);
            } catch (error) {
              setActionError(textSelectionErrorMessage(error));
            } finally {
              setDeleting(false);
              onMenuOpenChange(false);
            }
          }}
        >
          <Trash2 className="size-[13px]" aria-hidden="true" />
          Delete Text
        </Button>
      )}

      {actionError && <p role="alert" className="absolute top-full left-0 mt-1 rounded-1 border bg-popover p-2 text-sm text-destructive">{actionError}</p>}

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
        <X className="size-[13px]" aria-hidden="true" />
      </Button>
    </div>
  );

  return createPortal(actionBar, document.body);
}

/// Force a fresh request for the same file: a retry that reuses the cached
/// failure is not a retry.
function textSelectionErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "kind" in error) {
    if (error.kind === "stale_selection") return "The note changed. Select the text again.";
    if (error.kind === "unsupported_selection_shape") return "This selection cannot be mapped safely to the note. Select a smaller text fragment.";
    if ("message" in error && typeof error.message === "string") return error.message;
  }
  return error instanceof Error ? error.message : "Could not complete this action. Please try again.";
}

function withRetryToken(src: string, attempt: number): string {
  if (attempt === 0) return src;
  return `${src}${src.includes("?") ? "&" : "?"}retry=${attempt}`;
}

function DetailImage({
  src,
  sourceWidth,
  sourceHeight,
  previewSrc,
  contentInCloud = false,
  mediaRef = null,
  alt,
  className,
  ...imgProps
}: {
  src: string;
  sourceWidth?: number | null;
  sourceHeight?: number | null;
  previewSrc: string | null;
  /// Whether this file's contents are held in iCloud rather than on this Mac.
  contentInCloud?: boolean;
  /// The card's media reference, for asking the system about its download.
  mediaRef?: string | null;
  alt: string;
} & React.ImgHTMLAttributes<HTMLImageElement>) {
  const [originalReady, setOriginalReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Source geometry owns layout; loading changes pixels, never the box.
  // Legacy records without dimensions lock the first usable image geometry.
  const [size, setSize] = useState<{ width: number; height: number } | null>(() =>
    sourceWidth && sourceHeight && sourceWidth > 0 && sourceHeight > 0
      && Number.isFinite(sourceWidth) && Number.isFinite(sourceHeight)
      ? { width: sourceWidth, height: sourceHeight } : null);
  const frameStyle: CSSProperties | undefined = size ? {
    width: `min(${size.width}px, ${85 * size.width / size.height}vh)`,
    maxWidth: "100%",
    aspectRatio: `${size.width} / ${size.height}`,
  } : undefined;
  const rememberSize = (image: HTMLImageElement) => {
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      setSize(previous => previous ?? { width: image.naturalWidth, height: image.naturalHeight });
    }
  };
  // Late like the card badge: a file that arrives quickly must not flash a
  // notice about waiting. See SPEC_CLOUD_STORAGE.md Х6, Х9.
  const [waited, setWaited] = useState(false);
  // The system's published download percent. Null until macOS reports one —
  // the indicator shows a number only when there is a real number to show.
  const [percent, setPercent] = useState<number | null>(null);

  useEffect(() => {
    setOriginalReady(false);
    setFailed(false);
    setAttempt(0);
    setPercent(null);
  }, [src]);

  useEffect(() => {
    setWaited(false);
    if (originalReady || !contentInCloud) return;
    const timer = window.setTimeout(() => setWaited(true), CLOUD_BADGE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [contentInCloud, originalReady, attempt, src]);

  const requestedSrc = withRetryToken(src, attempt);
  const showDownloading = contentInCloud && !originalReady && !failed && waited;
  const showOffline = contentInCloud && failed;

  // While the waiting notice is visible, ask the system once a second what it
  // knows about the download. See SPEC_CLOUD_STORAGE.md Х4, Х9.
  useEffect(() => {
    if (!showDownloading || !mediaRef) return;
    let cancelled = false;
    const poll = () => {
      icloudDownloadProgress(mediaRef)
        .then((progress) => {
          if (cancelled) return;
          setPercent(progress.percent ?? null);
        })
        .catch(() => {
          // An unreachable probe keeps the numberless indicator.
        });
    };
    poll();
    const timer = window.setInterval(poll, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [showDownloading, mediaRef, attempt]);

  return (
    <div className="relative max-w-full overflow-hidden leading-none" style={frameStyle} data-detail-image="">
      {previewSrc && !originalReady && (
        <img
          src={previewSrc}
          alt=""
          className={cn("block max-w-full rounded-0", className, size && "absolute inset-0 size-full object-contain")}
          onLoad={event => rememberSize(event.currentTarget)}
          loading="eager"
          draggable={false}
          aria-hidden="true"
          data-detail-preview-backing=""
        />
      )}
      <img
        key={requestedSrc}
        src={requestedSrc}
        alt={alt}
        className={cn(
          "block max-w-full rounded-0",
          className,
          previewSrc && !originalReady && "absolute inset-0",
          size && "absolute inset-0 size-full object-contain",
        )}
        loading="lazy"
        draggable={false}
        {...imgProps}
        onLoad={async (event) => {
          const image = event.currentTarget;
          if (typeof image.decode === "function") {
            try { await image.decode(); }
            catch { setFailed(true); return; }
            if (!image.isConnected) return;
          }
          rememberSize(image);
          setOriginalReady(true);
          setFailed(false);
        }}
        onError={(e) => {
          // Contents held in iCloud is a state of the file, not a broken card:
          // it keeps its preview and says what happened.
          if (contentInCloud) {
            setFailed(true);
            return;
          }
          if (!previewSrc) {
            (e.target as HTMLImageElement).style.display = "none";
          }
        }}
        style={previewSrc && !originalReady ? { opacity: 0 } : undefined}
      />

      {showDownloading && (
        <div
          className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-card/90 px-3 py-2"
          data-detail-cloud-state="downloading"
        >
          <CloudDownload className="size-[13px] text-muted-foreground" aria-hidden="true" />
          <span className="text-sm text-muted-foreground">
            {percent === null
              ? CLOUD_DOWNLOADING_LABEL
              : `${CLOUD_DOWNLOADING_LABEL} · ${Math.round(percent)}%`}
          </span>
        </div>
      )}

      {showOffline && (
        <div
          className="absolute inset-x-0 bottom-0 grid gap-1 bg-card/90 px-3 py-2"
          data-detail-cloud-state="offline"
        >
          <span className="text-sm text-muted-foreground">{CLOUD_OFFLINE_LABEL}</span>
          <div>
            <Button
              size="sm"
              onClick={() => {
                setFailed(false);
                setAttempt((previous) => previous + 1);
              }}
            >
              Try again
            </Button>
          </div>
        </div>
      )}
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

/** The open element's menu chord from the command registry, rebinding
 *  included (SPEC_AUDIT_FIXES.md, Ф11). */
function isDetailCommandK(event: KeyboardEvent): boolean {
  return commandById("element-menu-open").matches?.(event) ?? false;
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
