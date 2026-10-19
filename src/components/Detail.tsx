import { scrollBehavior } from "@/lib/motion";
import { commandById } from "@/lib/commandRegistry";
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  type ComponentProps,
  type ComponentType,
  type CSSProperties,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useDraggable } from "@dnd-kit/core";
import type { Nodes } from "mdast";
import type { ExtraProps } from "react-markdown";
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
  DialogCancel,
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
import { MODAL_DETAIL_CLASS, MODAL_ERROR_CLASS } from "@/components/ui/modal-window";
import type {
  CardAssociationGroup,
  DeleteMediaAssetPlan,
  IndexedBlock,
  LightBlock,
  MediaAssetRef,
  TagCount,
} from "@/types";
import { preprocessWikilinks, inlineMediaOccurrenceIndex, markdownSourceByteOffset, markdownSourceOffset, firstImageOffset, renderedMarkdownTree } from "@/lib/markdownWikilinks";
import { decodeLocalMarkdownUrl } from "@/lib/markdownWikilinks";
import {
  thumbnailUrl,
  mediaUrl,
  previewAssetUrl,
  domainFromUrl,
  isSafeUrl,
  fallbackThumbsRoot,
  withRetry,
} from "@/lib/assets";
import {
  CLOUD_BADGE_DELAY_MS,
  CLOUD_DOWNLOADING_LABEL,
  CLOUD_OFFLINE_LABEL,
} from "@/lib/cloudContent";
import { cn } from "@/lib/utils";
import { useTopFadeMask } from "@/hooks/useTopFadeMask";
import { usePreviewFileRetry } from "@/hooks/usePreviewFileRetry";
import { mediaAssetErrorMessage } from "@/lib/mediaAssetErrors";
import { MissingAwareImage } from "./MissingAwareImage";
import { TopFadeScrim } from "./TopFadeScrim";
import { getDisplayTitle, getFallbackLabel, getNavigationLabel } from "@/lib/displayTitle";
import { copyMediaAssetToClipboard, getBlock, icloudDownloadProgress, prepareDeleteMediaAsset } from "@/lib/commands";
import { collectionRefLabel } from "@/lib/collections";
import type { FloatingMenuWidth } from "@/lib/floatingLayer";
import { useHoverIntent, type HoverIntentHandle } from "@/hooks/useHoverIntent";
import { useHoverPreviewOpener } from "@/hooks/useHoverPreviewOpener";
import {
  findPreviewTileForSource,
  normalizeDetailPreviewManifest,
} from "@/lib/feedPreview";
import { deriveCardContent, type CardContent } from "@/lib/cardLayout";
import {
  DETAIL_CONTENT_MAX_WIDTH_PX,
  detailLayout,
  detailMediaFrameStyle,
  detailMediaFrameWidth,
  detailMediaMaxHeightStyle,
  detailMediaSize,
  detailRailGridTemplate,
  sameMediaProportion,
  type DetailMediaSize,
} from "@/lib/detailLayout";
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
import { findArticleAnchor, parseArticleAnchor } from "@/lib/reading/anchors";
import { ArticleMarkdown } from "./reading/ArticleMarkdown";
import { mediaControlsClasses } from "./reading/mediaControls";
import { useNoteEmbedLookups } from "./reading/NoteEmbed";
import { useTaskToggles } from "./reading/TaskCheckbox";
import { NoteEditingSwitch } from "./editing/noteEditingSwitch";
import type { EditorTextSelection } from "./editing/NoteEditor";
import { EditorImagePlacementContext } from "./editing/editorImagePlacement";
import { actOnReadingElement, clickEvent } from "./reading/readingIntents";
import {
  COLLECTION_PICKER_CONTENT_CLASS,
  CollectionPicker,
} from "./CollectionPicker";
import { QuantizedMenuScrollArea } from "./QuantizedMenuScrollArea";
import { SearchMenuInput } from "./SearchMenuInput";
import { microPreviewFromIndexedBlock, microPreviewFromLightBlock } from "./MicroPreviewThumbnail";
import { CardRow } from "./CardRow";
import { CardRowActions, cardRowActionsReservePx } from "./CardRowActions";
import { deriveSearchResultRow } from "@/lib/searchResultRow";
import { associationHeading, authorFeedHint } from "@/lib/cardAssociations";
import { useCardAssociations } from "@/hooks/useCardAssociations";
import type { ImagePreviewRequest, ImagePreviewSibling } from "./ImagePreviewOverlay";
import { COPY_PATH_FAILED_TITLE, copyTextToClipboard } from "@/lib/clipboard";
import {
  READ_ELEMENT_FAILED_TITLE,
  dismissActionFailure,
  reportActionError,
} from "@/lib/actionFailures";
import { openLinkInBrowser, revealInFinder } from "@/lib/systemActions";

// The open card's layout (SPEC_FRONTEND.md, «Раскладка открытой карточки»;
// user's decisions of 07.10.2026 and 16.10.2026): the side panel never takes
// space from the content. The content stands at its full width centred
// between the sidebar and the fixed 20rem panel while the equal margins on
// either side of it are at least one inset; past that the view stacks at
// once, content centred and the panel's cards under it, centred and no wider
// than the reading column. Scroll content and fixed metadata share one grid's
// columns; insets and the top offset follow the app-wide edge rhythm.
const DETAIL_RAIL_GRID_CLASSES = "grid w-full pt-[var(--card-content-pad)]";
/// The fixed panel layer's grid: one row as tall as the open card, so the
/// panel's column is bounded by it and scrolls its own cards (Р8). The top
/// inset lives inside the panel's scroll, as the content's does.
const DETAIL_PANEL_LAYER_GRID_CLASSES = "grid h-full w-full grid-rows-[minmax(0,1fr)]";
const DETAIL_STACKED_LAYOUT_CLASSES =
  "grid w-full grid-cols-[var(--card-content-pad)_minmax(0,1fr)_var(--card-content-pad)] pt-[var(--card-content-pad)]";
/// Stacked, the panel's cards are no wider than the reading column (Р4).
const DETAIL_STACKED_PANEL_STYLE: CSSProperties = { maxWidth: DETAIL_CONTENT_MAX_WIDTH_PX };
/// `--card-content-pad` until its probe is measured: the default edge rhythm.
const DETAIL_CONTENT_PAD_FALLBACK_PX = 32;
/// The height limit every media frame of the open card reads (Р7).
const DETAIL_ROOT_STYLE = detailMediaMaxHeightStyle();
/// A medium whose frame knows its size fills the frame exactly (Р6).
const DETAIL_MEDIA_FILL_CLASSES = "absolute inset-0 size-full object-contain";
const DETAIL_METADATA_CARD_MIN_WIDTH_PX = 240;
const DETAIL_BOTTOM_SAFE_SPACE_CLASS = "pb-20";
const HOVER_CARD_WIDTH = 240;
const HOVER_CARD_FALLBACK_HEIGHT = 320;
const HOVER_CARD_GAP = 8;
const HOVER_CARD_VIEWPORT_MARGIN = 16;
const TEXT_SELECTION_ACTION_BAR_FALLBACK_WIDTH_PX = 296;

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
  /** Opens the feed of one author's cards (SPEC_CARD_ASSOCIATIONS.md). */
  onOpenAuthorFeed?: (author: string) => void;
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

/// A light card's body this long may be the start the feed carries: the
/// index cuts it at `LIGHT_BLOCK_BODY_PREVIEW_CHARS` (220) characters
/// (storage/index.rs); counted here in UTF-16 units, with room for a cut
/// that ends inside a pair.
const LIGHT_BODY_PREVIEW_MIN_LENGTH = 218;

function mayBeLightBodyPreview(body: string): boolean {
  return body.length >= LIGHT_BODY_PREVIEW_MIN_LENGTH;
}

/** The quiet line of the notice when the card shows only the feed's start
 *  of its text (Е6.13). */
export const ONLY_TEXT_BEGINNING_SHOWN = "The open element shows only the beginning of its text.";

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
 * The content's full width in the open card (SPEC_FRONTEND.md, «Раскладка
 * открытой карточки», Р1): the reading column, or the frame width of a lone
 * picture or a lone video when it is narrower (its own width, or the width
 * it takes at the height limit, as its media frame draws it). One rule for
 * every card: what decides is the content, not a kind. `pictureOwnSize` is
 * the lone picture's own size once it has corrected a recorded size of
 * another proportion (Р6): the width follows the frame the reader sees.
 */
export function detailContentFullWidth(
  block: LightBlock | IndexedBlock,
  viewportHeight: number,
  pictureOwnSize: DetailMediaSize | null = null,
): number {
  const size = loneMediaSize(block, pictureOwnSize);
  if (!size || viewportHeight <= 0) return DETAIL_CONTENT_MAX_WIDTH_PX;
  const frameWidth = detailMediaFrameWidth(size, viewportHeight);
  return Math.max(1, Math.round(Math.min(DETAIL_CONTENT_MAX_WIDTH_PX, frameWidth)));
}

/** A lone picture's own size, reported when it corrected its record's size
 *  (Р6), with the card and the file it belongs to. */
interface LonePictureOwnSize {
  slug: string;
  mediaRef: string | null;
  size: DetailMediaSize;
}

/** The size of the one picture or the one video the card's content is: the
 *  record's, or a lone picture's own once it corrected the record's;
 *  `null` when the content is anything else (text, a video with text under
 *  it, the YouTube player) or the record has no size. */
function loneMediaSize(
  block: LightBlock | IndexedBlock,
  pictureOwnSize: DetailMediaSize | null,
): DetailMediaSize | null {
  const content = deriveCardContent(block);
  const manifest = normalizeDetailPreviewManifest(block.preview_manifest);
  if (content.source === "image") {
    const recorded = detailMediaSize(block.width ?? manifest?.width, block.height ?? manifest?.height);
    return recorded && (pictureOwnSize ?? recorded);
  }
  if (content.source !== "video") return null;
  const bodyVideoReferences = localBodyVideoReferences(block.body, manifest);
  if (playsYoutubeSource(block, bodyVideoReferences)) return null;
  const lead = videoCardLead(block, content, block.body, manifest, bodyVideoReferences);
  return lead.sourcePath && !lead.showBody ? lead.size : null;
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
  onOpenAuthorFeed,
  onTextSelectionDrop,
  onCreateChannelAndTextSelectionCard = noopTextSelectionCreate,
  onTextSelectionDelete,
  scrollEdgeFade = false,
}: DetailProps) {
  const [fullBlock, setFullBlock] = useState<IndexedBlock | null>(
    isIndexedBlock(block) ? block : null,
  );
  // The body the reading mode's derivations read (SPEC_EDITING.md, Л14):
  // every body the card is read with, but not the editor's own writes,
  // which change the file on every keystroke while the editor holds the
  // text. The lead media, the content's width and the article's own data
  // are derived from it, so a keystroke parses none of them again.
  const [readingBody, setReadingBody] = useState<string>((isIndexedBlock(block) ? block : null)?.body ?? block.body);
  const [topMenuRequestSequence, setTopMenuRequestSequence] = useState(0);
  const [topMenuOpen, setTopMenuOpen] = useState(false);
  const displayBlock = fullBlock ?? block;
  const currentBlockSlugRef = useRef(block.slug);
  const {
    containerRef: detailLayoutRef,
    padProbeRef: detailPadProbeRef,
    metrics: detailLayoutMetrics,
  } = useDetailLayoutMetrics();
  const viewportHeight = detailLayoutMetrics?.viewportHeight ?? window.innerHeight;
  // A lone picture whose record has a wrong size corrects its frame when the
  // original loads (Р6); the content's width follows (Р1), for that picture
  // of that card only.
  const [lonePictureOwnSize, setLonePictureOwnSize] = useState<LonePictureOwnSize | null>(null);
  const pictureOwnSize = lonePictureOwnSize
    && lonePictureOwnSize.slug === displayBlock.slug
    && lonePictureOwnSize.mediaRef === displayBlock.media_file
    ? lonePictureOwnSize.size
    : null;
  const layoutBlock = useMemo(
    () => (displayBlock.body === readingBody ? displayBlock : { ...displayBlock, body: readingBody }),
    [displayBlock, readingBody],
  );
  const contentWidth = useMemo(
    () => detailContentFullWidth(layoutBlock, viewportHeight, pictureOwnSize),
    [layoutBlock, viewportHeight, pictureOwnSize],
  );
  const isStackedLayout = detailLayoutMetrics !== null
    && detailLayout(detailLayoutMetrics.width, detailLayoutMetrics.pad, contentWidth).mode === "stacked";
  const layoutClasses = isStackedLayout
    ? DETAIL_STACKED_LAYOUT_CLASSES
    : DETAIL_RAIL_GRID_CLASSES;
  // Beside the panel the content's column is exactly its full width; the
  // spare room goes in equal parts to the two flexible tracks around it, so
  // the content stands centred between the sidebar and the panel.
  const layoutStyle: CSSProperties | undefined = isStackedLayout
    ? undefined
    : { gridTemplateColumns: detailRailGridTemplate(contentWidth) };
  const articleColumnClasses = isStackedLayout
    ? "col-start-2 min-w-0 mx-auto w-full"
    : "col-start-2 min-w-0";
  const stackedColumnStyle: CSSProperties | undefined = isStackedLayout
    ? { maxWidth: contentWidth }
    : undefined;

  useEffect(() => {
    setFullBlock(isIndexedBlock(block) ? block : null);
    setReadingBody(block.body);
  }, [block]);

  useEffect(() => {
    currentBlockSlugRef.current = block.slug;
    // Another card: its picture reports its own size when its original loads.
    setLonePictureOwnSize(null);
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

  // The card's file, read whole: the feed's light card carries only the start
  // of its text. A read that fails is the tab's notice, which says when the
  // text shown is only that start (SPEC_DEEP_AUDIT.md, Н11, Е6.13).
  const refreshFullBlock = useCallback((slug: string, shown: LightBlock | IndexedBlock) => {
    void getBlock(slug).then(
      (full) => {
        if (!full || currentBlockSlugRef.current !== slug) {
          return;
        }
        dismissActionFailure("read-element");
        setFullBlock(full);
        setReadingBody(full.body);
      },
      (error: unknown) => {
        if (currentBlockSlugRef.current !== slug) return;
        reportActionError(
          "read-element",
          READ_ELEMENT_FAILED_TITLE,
          error,
          !isIndexedBlock(shown) && mayBeLightBodyPreview(shown.body) ? ONLY_TEXT_BEGINNING_SHOWN : undefined,
        );
      },
    );
  }, []);

  useEffect(() => {
    if (isIndexedBlock(block)) return;
    refreshFullBlock(block.slug, block);
  }, [block, refreshFullBlock]);

  // A task box wrote the file: the card read anew carries the new body and
  // its hash (SPEC_READING_MODE.md, Ч12.3). A write that found the file
  // changed reads it again.
  const handleBodyWritten = useCallback((written: IndexedBlock) => {
    if (currentBlockSlugRef.current !== written.slug) return;
    setFullBlock(written);
    setReadingBody(written.body);
  }, []);
  // The editor wrote its text: the card's fields follow it (the panel, the
  // chrome, Л3.7); the reading mode's derivations keep the body they read
  // (Л14), the editor holds the text.
  const handleEditedBodyWritten = useCallback((written: IndexedBlock) => {
    if (currentBlockSlugRef.current === written.slug) setFullBlock(written);
  }, []);
  // Without the editor the card's text is the reading mode's again.
  const editingSwitch = useContext(NoteEditingSwitch);
  useEffect(() => {
    if (!editingSwitch && fullBlock) setReadingBody(fullBlock.body);
  }, [editingSwitch, fullBlock]);
  const handleBodyStale = useCallback(() => {
    refreshFullBlock(block.slug, block);
  }, [block, refreshFullBlock]);

  useEffect(() => {
    const handleVaultRefreshed = () => {
      refreshFullBlock(block.slug, block);
    };
    window.addEventListener("vault-refreshed", handleVaultRefreshed);
    return () => {
      window.removeEventListener("vault-refreshed", handleVaultRefreshed);
    };
  }, [block, refreshFullBlock]);

  const panelRef = useRef<HTMLDivElement>(null);
  const topFade = useTopFadeMask(panelRef, scrollEdgeFade);
  const panelTopFade = useTopFadeMask(undefined, scrollEdgeFade);

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
      style={DETAIL_ROOT_STYLE}
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
                onLonePictureOwnSize={setLonePictureOwnSize}
                readingBody={readingBody}
                onBodyWritten={handleBodyWritten}
                onEditedBodyWritten={handleEditedBodyWritten}
                onBodyStale={handleBodyStale}
              />
            </div>
            {isStackedLayout ? (
              // The panel's cards under the content, centred and no wider
              // than the reading column, whatever the content's width; in a
              // narrower window across the width between the insets (Р4).
              <div
                className="col-start-2 mx-auto mt-[var(--card-content-pad)] w-full min-w-0"
                style={DETAIL_STACKED_PANEL_STYLE}
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
                  onOpenAuthorFeed={onOpenAuthorFeed}
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
          /* Layer 2: the panel, fixed while the content scrolls, with its own
             scroll when its cards are taller than the open card (Р8). Above
             the content's band, so each band fades only its own surface. */
          <div
            className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
            data-detail-fixed-metadata-layer
          >
            <div
              className={DETAIL_PANEL_LAYER_GRID_CLASSES}
              style={layoutStyle}
              data-detail-layout-grid="metadata"
            >
              <div className="col-start-2 min-w-0" />
              <div className="relative col-start-4 flex min-w-0 flex-col" data-detail-panel-column>
                {/* As tall as its cards and insets, up to the open card's
                    height; under a short panel the content scrolls as
                    before. */}
                <div
                  ref={panelTopFade.ref}
                  className="pointer-events-auto min-h-0 overflow-y-auto overflow-x-hidden"
                  data-metadata-scroll
                  data-detail-panel-top-fade={panelTopFade.scrolled ? "true" : undefined}
                >
                  <div className={cn("pt-[var(--card-content-pad)]", DETAIL_BOTTOM_SAFE_SPACE_CLASS)}>
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
                      onOpenAuthorFeed={onOpenAuthorFeed}
                    />
                  </div>
                </div>
                <TopFadeScrim scrolled={panelTopFade.scrolled} surface="detail-panel" color="var(--background)" />
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
  onOpenAuthorFeed?: (author: string) => void;
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
  onOpenAuthorFeed,
}: MetadataPanelProps) {
  const relatedNoteRowRefs = useRef(new Map<string, HTMLElement>());
  const hoverPreviewRef = useRef<HTMLDivElement | null>(null);
  // The pointer's speed over the panel's rows: a preview waits for it to rest.
  const rowPointer = useHoverIntent();
  const rowPreviewOpener = useHoverPreviewOpener(rowPointer.isSlow);
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
  // The association blocks never repeat a Related note; they wait for the
  // full card, which knows its Related notes (SPEC_CARD_ASSOCIATIONS.md).
  const associationExclusions = useMemo(
    () => (isIndexedBlock(displayBlock) ? relatedNotes.map(baseRelatedNoteSlug) : null),
    [displayBlock, relatedNotes],
  );
  const associationGroups = useCardAssociations(displayBlock.slug, associationExclusions);
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

  const openRelatedNotePreview = useCallback((note: HoveredRelatedNote) => {
    setHoveredRelatedNote(null);
    rowPreviewOpener.request(() => setHoveredRelatedNote(note));
  }, [rowPreviewOpener]);

  const requestCloseRelatedNotePreview = useCallback(() => {
    rowPreviewOpener.hide();
    setHoveredRelatedNote(null);
  }, [rowPreviewOpener]);

  // Every card a row of the panel shows, for the row's hover preview.
  const panelRowBlocks = useMemo(() => {
    const byslug = new Map<string, LightBlock | IndexedBlock>();
    for (const [slug, relatedBlock] of relatedNoteBlocks ?? []) {
      if (relatedBlock) byslug.set(slug, relatedBlock);
    }
    for (const group of associationGroups) {
      for (const associated of group.blocks) {
        if (!byslug.has(associated.slug)) byslug.set(associated.slug, associated);
      }
    }
    return byslug;
  }, [associationGroups, relatedNoteBlocks]);
  const hoveredRelatedNoteBlock = hoveredRelatedNote
    ? panelRowBlocks.get(hoveredRelatedNote.slug) ?? null
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


  const panelRowProps: PanelRowsProps = {
    resolvedThumbsRoot,
    vaultPath,
    tags,
    currentTag,
    onToggleTag,
    onCreateAndAssign,
    onRequestRename,
    onRequestDelete,
    onOpenRow: onOpenRelatedNote,
    rowRefs: relatedNoteRowRefs,
    onRowPreviewEnter: openRelatedNotePreview,
    onRowPreviewLeave: requestCloseRelatedNotePreview,
  };

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

        <div
          // The boxes stand as far apart as the feed's cards and the page's
          // edge: the interface spacing, Display's Spacing (user's decision
          // of 08.10.2026).
          className="flex min-w-0 flex-col gap-[var(--edge-rhythm,32px)]"
          onPointerMove={(event) => rowPointer.move(null, event.clientX, event.clientY)}
          onPointerLeave={() => rowPointer.leave()}
          data-metadata-sections
        >
          <DetailPanelCard data-detail-metadata-card>
            {/* 8 px off the frame across, like the feed card's text (user's
                decision of 08.10.2026): the card's 4 and this 4. */}
            <div className="px-surface" data-detail-metadata-card-content>
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
                      onClick={() => openLinkInBrowser(displayBlock.url!)}
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
              {...panelRowProps}
            />
          )}
          {associationGroups.map((group) => (
            <CardAssociationSection
              key={group.kind}
              group={group}
              onOpenAuthorFeed={onOpenAuthorFeed}
              {...panelRowProps}
            />
          ))}
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
 * A card of the open card's panel: the metadata with its buttons, the
 * Related notes, the association blocks. The card's surface, the level of
 * the second chrome row, in both themes (user's decision of 06.10.2026).
 * Its plates (row lights, buttons) stand the surface's inset off the frame,
 * and what has no plate under it stands the plate's inset further in
 * (DESIGN_SYSTEM.md, «Система отступов поверхностей»).
 */
function DetailPanelCard({ className, style, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn("overflow-hidden rounded-[var(--radius-card)] border border-border bg-card p-surface", className)}
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
    // Buttons standing on the box, not in a row, keep 8 px off its edge like
    // the feed card's and the chrome's buttons (user's decision of
    // 08.10.2026): the box's 4 plus their own 4. Still 4 apart and 4 under
    // the last row.
    <div className="m-surface flex min-w-0 items-center gap-surface" data-detail-action-row>
      {block.url && isSafeUrl(block.url) && (
        <Button
          type="button"
          variant="default"
          size="default"
          // Opens the browser, so it carries the pointing hand; every other
          // control in this bar acts inside Mine and keeps the arrow.
          className="min-w-0 flex-1 cursor-pointer"
          onClick={() => openLinkInBrowser(block.url!)}
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
        <DropdownMenuContent widthRole="search" className={COLLECTION_PICKER_CONTENT_CLASS} align="end">
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

/** What every row list of the panel needs from the open card. */
interface PanelRowsProps {
  resolvedThumbsRoot: string;
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestRename: (block: LightBlock | IndexedBlock) => void;
  onRequestDelete: (slug: string) => void;
  /** Opens the card of a row. */
  onOpenRow: (slug: string) => void;
  rowRefs: { current: Map<string, HTMLElement> };
  onRowPreviewEnter: (note: HoveredRelatedNote) => void;
  onRowPreviewLeave: () => void;
}

/** One row of a panel list: the slug it opens and its card, `null` while the
 *  card is not read or when the link names no card. */
interface PanelRow {
  slug: string;
  block: LightBlock | IndexedBlock | null;
}

/**
 * The rows of a card of the panel: the search's own rows (`CardRow`, user's
 * decision of 07.10.2026), shared by Related notes and the association
 * blocks. Under the pointer a row lights up and shows the card's commands
 * (Connect, Source, More) at its right end, as a search result does; a press
 * elsewhere on the row opens the card. Row keys carry `listKey`, so one card
 * in two lists is two rows for the pointer, the menu and the preview.
 */
function PanelCardRows({
  listKey,
  rows,
  kind,
  resolvedThumbsRoot,
  vaultPath,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
  onOpenRow,
  rowRefs,
  onRowPreviewEnter,
  onRowPreviewLeave,
}: PanelRowsProps & {
  listKey: string;
  rows: readonly PanelRow[];
  /** Which list this is, named by its data attributes for tests. */
  kind: "related" | "association";
}) {
  const related = kind === "related";
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
    // Rows flush one under the other; the card's own inset keeps their
    // light off the frame.
    <div
      className="flex w-full min-w-0 flex-col"
      onWheel={() => setPointerRowKey(null)}
      data-related-notes-list={related ? "" : undefined}
      data-card-association-list={related ? undefined : ""}
    >
      {rows.map(({ slug, block }, index) => {
        const rowKey = `${listKey}:${index}:${slug}`;

        if (!block) {
          // Still loading, or a link to a note that is gone: the name
          // alone, dimmed, nothing to open.
          return (
            <CardRow
              key={rowKey}
              row={deriveSearchResultRow({ slug, preview_text: null })}
              preview={null}
              active={false}
              item={{ as: "static" }}
              data-related-note-item={related ? "placeholder" : undefined}
              data-card-association-item={related ? undefined : "placeholder"}
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
                rowRefs.current.set(rowKey, node);
              } else {
                rowRefs.current.delete(rowKey);
              }
            }}
            row={deriveSearchResultRow(block)}
            preview={isIndexedBlock(block)
              ? microPreviewFromIndexedBlock(block, resolvedThumbsRoot)
              : microPreviewFromLightBlock(block, resolvedThumbsRoot)}
            active={actionsShown}
            actionsReservePx={actionsShown ? cardRowActionsReservePx(block) : 0}
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
              if (menuRowKey === null) onRowPreviewEnter({ rowKey, slug });
            }}
            onMouseLeave={onRowPreviewLeave}
            item={{
              as: "button",
              props: {
                onClick: (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenRow(slug);
                },
              },
            }}
            actions={(actionsShown || pointerRowKey === rowKey) && (
              <CardRowActions
                block={block}
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
                  if (open) onRowPreviewLeave();
                }}
                onMenuCloseAutoFocus={handleMenuCloseAutoFocus}
              />
            )}
            data-related-note-item={related ? "button" : undefined}
            data-card-association-item={related ? undefined : "button"}
          />
        );
      })}
    </div>
  );
}

/**
 * The heading of a card of the panel: a row of the card at its top, the
 * text 8 px off the frame across like the feed card's text and the metadata
 * labels (user's decision of 08.10.2026), over the rows' thumbnails.
 */
const PANEL_CARD_HEADING_CLASSES = "flex h-row min-w-0 items-center px-surface";

/**
 * The open card's Related notes in a card of the panel, like the metadata
 * above it: the label inside, then the panel's rows.
 */
function RelatedNotesSection({
  relatedNotes,
  relatedNoteBlocks,
  ...rowProps
}: PanelRowsProps & {
  relatedNotes: string[];
  relatedNoteBlocks: Map<string, IndexedBlock | null> | null;
}) {
  const rows = relatedNotes.map((note) => {
    const slug = baseRelatedNoteSlug(note);
    return { slug, block: relatedNoteBlocks?.get(slug) ?? null };
  });
  return (
    <DetailPanelCard data-related-notes-block>
      <div className={cn(METADATA_LABEL_CLASSES, PANEL_CARD_HEADING_CLASSES)}>Related notes</div>
      <PanelCardRows
        listKey="related"
        rows={rows}
        kind="related"
        {...rowProps}
      />
    </DetailPanelCard>
  );
}

/**
 * One association block of the open card (SPEC_CARD_ASSOCIATIONS.md): the
 * same card of the panel as Related notes, its heading inside, then every
 * row of the group. The author heading opens the author's feed.
 */
function CardAssociationSection({
  group,
  onOpenAuthorFeed,
  ...rowProps
}: PanelRowsProps & {
  group: CardAssociationGroup;
  onOpenAuthorFeed?: (author: string) => void;
}) {
  const heading = associationHeading(group);
  const openFeed = group.kind === "author" && onOpenAuthorFeed
    ? () => onOpenAuthorFeed(group.label)
    : null;
  return (
    <DetailPanelCard aria-label={heading} data-card-association-block={group.kind}>
      <div className={PANEL_CARD_HEADING_CLASSES}>
        {openFeed ? (
          // A label that acts, like the metadata's Source value: no face of
          // its own, underlined under the pointer, the arrow cursor of an
          // action inside Mine.
          <button
            type="button"
            onClick={openFeed}
            title={authorFeedHint(group.label)}
            className={cn(METADATA_LABEL_CLASSES, "min-w-0 truncate text-left hover:underline")}
            data-card-association-heading=""
          >
            {heading}
          </button>
        ) : (
          <div
            className={cn(METADATA_LABEL_CLASSES, "min-w-0 truncate")}
            title={heading}
            data-card-association-heading=""
          >
            {heading}
          </div>
        )}
      </div>
      <PanelCardRows
        listKey={group.kind}
        rows={group.blocks.map((block) => ({ slug: block.slug, block }))}
        kind="association"
        {...rowProps}
      />
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
  referencePointer,
}: {
  references: string[];
  referenceBlocks: Map<string, IndexedBlock | null> | null;
  fallbackLabels: Map<string, string>;
  resolvedThumbsRoot: string;
  onOpenReference: (slug: string) => void;
  referenceRowRefs: { current: Map<string, HTMLElement> };
  onReferencePreviewEnter: (note: HoveredRelatedNote) => void;
  onReferencePreviewLeave: () => void;
  /** The pointer's speed over the rows, for the preview's resting pointer. */
  referencePointer: HoverIntentHandle;
}) {
  return (
    <div
      className="flex w-full min-w-0 flex-col gap-1"
      onPointerMove={(event) => referencePointer.move(null, event.clientX, event.clientY)}
      onPointerLeave={() => referencePointer.leave()}
      data-card-reference-list
    >
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
 * its right edge on the row's right edge. The preview never leaves the area.
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
    left: Math.max(minLeft, Math.min(triggerRect.right - HOVER_CARD_WIDTH, maxRight - HOVER_CARD_WIDTH)),
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
  visit(renderedMarkdownTree(preprocessWikilinks(body)));
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
  visit(renderedMarkdownTree(preprocessWikilinks(body)));
  return more;
}

/** The card's own file when it is a local video. */
function primaryLocalVideoRef(block: LightBlock | IndexedBlock): string | null {
  return block.media_file
    && !isSafeUrl(block.media_file)
    && /\.(?:mp4|webm|m4v|mov)$/i.test(block.media_file)
    ? block.media_file
    : null;
}

/** Whether the open card plays its YouTube source in the player: the card
 *  has neither a local video file nor a video in its body. */
function playsYoutubeSource(
  block: LightBlock | IndexedBlock,
  bodyVideoReferences: string[],
): boolean {
  return parseYoutubeSource(block.url) !== null
    && primaryLocalVideoRef(block) === null
    && bodyVideoReferences.length === 0;
}

/** What a media card whose content is a video leads with. */
interface VideoCardLead {
  /** Its file, or the body's first video embed. */
  sourcePath: string | null;
  /** The lead when it is the body's embed, which the body then leaves out. */
  omittedEmbed: { source: string } | null;
  /** Whether the body has more to show under the video. */
  showBody: boolean;
  /** The video's size as the record knows it (Р6). */
  size: DetailMediaSize | null;
}

function videoCardLead(
  block: LightBlock | IndexedBlock,
  content: CardContent,
  body: string,
  manifest: ReturnType<typeof normalizeDetailPreviewManifest>,
  bodyVideoReferences: string[],
): VideoCardLead {
  const sourcePath = content.media?.items.find((item) => item.isVideo)?.sourcePath
    ?? block.media_file;
  const leadIsBodyEmbed = !!sourcePath
    && sourcePath !== block.media_file
    && bodyVideoReferences.includes(sourcePath);
  const omittedEmbed = leadIsBodyEmbed && sourcePath ? { source: sourcePath } : null;
  return {
    sourcePath,
    omittedEmbed,
    showBody: !!body && (!omittedEmbed || bodyHasMoreThanEmbed(body, manifest, omittedEmbed.source)),
    size: recordedVideoSize(block, manifest, sourcePath),
  };
}

/** A video's size as the record knows it (Р6): its tile in the preview
 *  manifest, else the card's own size when it is the card's file. */
function recordedVideoSize(
  block: LightBlock | IndexedBlock,
  manifest: ReturnType<typeof normalizeDetailPreviewManifest>,
  sourcePath: string | null,
): DetailMediaSize | null {
  if (!sourcePath) return null;
  const tile = findPreviewTileForSource(manifest, sourcePath);
  return detailMediaSize(tile?.width, tile?.height)
    ?? (sourcePath === block.media_file ? detailMediaSize(block.width, block.height) : null);
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
  onLonePictureOwnSize,
  readingBody,
  onBodyWritten,
  onEditedBodyWritten,
  onBodyStale,
}: {
  block: LightBlock | IndexedBlock;
  fullBlock: IndexedBlock | null;
  /** The body the reading mode's derivations read (Л14). */
  readingBody: string;
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
  /** The lone picture corrected its record's size (Р6). */
  onLonePictureOwnSize: (own: LonePictureOwnSize) => void;
  /** A task write changed the file: the card read anew (Ч12.3). */
  onBodyWritten: (block: IndexedBlock) => void;
  /** The editor wrote its text: the card read anew (Л3.7). */
  onEditedBodyWritten: (block: IndexedBlock) => void;
  /** A task write found the file changed: read the body again. */
  onBodyStale: () => void;
}) {
  const resolvedThumbsRoot = thumbsRootPath ?? fallbackThumbsRoot(vaultPath);
  // By the manifest's text: a card read anew with the same manifest keeps it.
  const rawPreviewManifest = (fullBlock ?? block).preview_manifest;
  const previewManifest = useMemo(
    () => normalizeDetailPreviewManifest(rawPreviewManifest),
    [rawPreviewManifest],
  );
  // The record's source decides how the open card shows its media; the feed
  // card's look does not (SPEC_CARD_UNIFIED.md, Е1).
  const content = useMemo(
    () => deriveCardContent(fullBlock ?? block),
    [block, fullBlock],
  );
  // The whole text comes with the card read from its file (`fullBlock`,
  // read by Detail, which reports a read that fails); until then the feed's
  // start of it. While the editor writes the text, the reading mode keeps
  // the body it read (Л14).
  const body = readingBody;
  const description = "description" in block ? (block as IndexedBlock).description : null;
  const displayTitle = getDisplayTitle(block);
  const navigationLabel = getNavigationLabel(block);
  const sourceVideo = parseYoutubeSource(block.url);
  const bodyVideoReferences = useMemo(() => localBodyVideoReferences(body, previewManifest), [body, previewManifest]);
  const mainVideoIsInBody = !!block.media_file && bodyVideoReferences.some((source) => (
    source === block.media_file || (!source.includes("/") && block.media_file?.endsWith(`/${source}`))
  ));
  const primaryLocalVideo = resolveDetailMediaReference(vaultPath, primaryLocalVideoRef(block));
  const sourcePlayer = sourceVideo && playsYoutubeSource(block, bodyVideoReferences) ? (
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
            // Centred over the text like the body's media (Р5); the space
            // under it lies outside the frame, which holds the picture only.
            <div className="mb-6 flex justify-center" data-detail-lead-video>
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
                <DetailVideo
                  key={primaryLocalVideo}
                  src={primaryLocalVideo}
                  recordedSize={recordedVideoSize(block, previewManifest, block.media_file)}
                  controls
                />
              </MediaAssetActionFrame>
            </div>
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
            onBodyWritten={onBodyWritten}
            onEditedBodyWritten={onEditedBodyWritten}
            onBodyStale={onBodyStale}
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
              onBodyWritten={onBodyWritten}
              onEditedBodyWritten={onEditedBodyWritten}
              onBodyStale={onBodyStale}
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
      return (
        <DetailLinkPage
          block={block}
          previewManifest={previewManifest}
          vaultPath={vaultPath}
          thumbsRootPath={resolvedThumbsRoot}
          showPicture={content.source === "link" && previewManifest?.kind !== "text"}
          title={displayTitle}
          description={description}
          onOpenImagePreview={onOpenImagePreview}
        />
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
                previewSlug={block.slug}
                contentInCloud={isContentInCloud(block)}
                mediaRef={block.media_file}
                alt={navigationLabel}
                className="block max-h-[var(--detail-media-max-height)] max-w-full object-contain"
                onOwnSize={(size) => onLonePictureOwnSize({ slug: block.slug, mediaRef: block.media_file, size })}
              />
            </MediaAssetActionFrame>
          </div>
        );
      }

      if (content.source === "link") {
        return (
          <DetailLinkPage
            block={block}
            previewManifest={previewManifest}
            vaultPath={vaultPath}
            thumbsRootPath={resolvedThumbsRoot}
            showPicture
            title={displayTitle}
            description={description}
            onOpenImagePreview={onOpenImagePreview}
          />
        );
      }

      if (content.source === "video") {
        // The lead video is either the primary file or the body's first video
        // embed. In the second case the body below must not show it again.
        const {
          sourcePath: videoSourcePath,
          omittedEmbed,
          showBody,
          size: videoSize,
        } = videoCardLead(block, content, body, previewManifest, bodyVideoReferences);
        const localSrc = resolveDetailMediaReference(vaultPath, videoSourcePath);
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
                    ? omittedEmbed
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
                  <DetailVideo
                    key={localSrc}
                    src={localSrc}
                    recordedSize={videoSize}
                    controls
                    autoPlay
                    muted
                    loop
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
                  onBodyWritten={onBodyWritten}
                  onEditedBodyWritten={onEditedBodyWritten}
                  onBodyStale={onBodyStale}
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

/**
 * A saved page in the open card: its page picture, when it has one, then its
 * title and description. One path for the link card and for a media card
 * that shows a link (SPEC_FRONTEND.md, «Раскладка открытой карточки», Р9).
 */
function DetailLinkPage({
  block,
  previewManifest,
  vaultPath,
  thumbsRootPath,
  showPicture,
  title,
  description,
  onOpenImagePreview,
}: {
  block: LightBlock | IndexedBlock;
  previewManifest: ReturnType<typeof normalizeDetailPreviewManifest>;
  vaultPath: string;
  thumbsRootPath: string;
  showPicture: boolean;
  title: string | null;
  description: string | null;
  onOpenImagePreview: (preview: ImagePreviewRequest) => void;
}) {
  const src = showPicture
    ? detailPreviewImageSource({ block, previewManifest, vaultPath, thumbsRootPath })
    : null;
  return (
    <div>
      {src && (
        <DetailLinkPicture
          key={src}
          src={src}
          sourceWidth={block.width ?? previewManifest?.width}
          sourceHeight={block.height ?? previewManifest?.height}
          onOpenImagePreview={onOpenImagePreview}
        />
      )}
      <div className="py-4">
        {title && (
          <h2 className="text-lg font-semibold text-foreground">
            {title}
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

/**
 * A link's page picture in the one media frame (Р6, Р9): its own proportion,
 * the size the card's picture takes (the record's, else the preview
 * manifest's, else the first loaded version's), centred in the column. It is
 * no media asset, so ⤢ and a click are its only controls. A picture that will
 * not load leaves with its frame and its controls. Callers key it by `src`.
 */
function DetailLinkPicture({
  src,
  sourceWidth,
  sourceHeight,
  onOpenImagePreview,
}: {
  src: string;
  sourceWidth?: number | null;
  sourceHeight?: number | null;
  onOpenImagePreview: (preview: ImagePreviewRequest) => void;
}) {
  const [unavailable, setUnavailable] = useState(false);
  if (unavailable) return null;
  return (
    <div className="flex justify-center" data-detail-link-picture>
      <ExpandableImageFrame src={src} onOpenImagePreview={onOpenImagePreview}>
        <DetailImage
          src={src}
          sourceWidth={sourceWidth}
          sourceHeight={sourceHeight}
          previewSrc={null}
          alt=""
          className="block max-h-[var(--detail-media-max-height)] max-w-full object-contain"
          onUnavailable={() => setUnavailable(true)}
        />
      </ExpandableImageFrame>
    </div>
  );
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
        className={cn(DETAIL_MEDIA_ACTION_FRAME_CLASSES, className)}
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
              DETAIL_MEDIA_ACTION_FRAME_CLASSES,
              "group/detail-media",
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
              const origin = event.currentTarget;
              // What a click on the picture means is decided with the
              // editor's (SPEC_EDITING.md, Л11.1).
              actOnReadingElement({ kind: "image" }, clickEvent(event), {
                openImagePreview: () => onOpenImagePreview({
                  src: fullSizeImageSrc,
                  mediaRef: asset.media_ref,
                  siblings: collectCardImages(origin),
                }),
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
                className={mediaControlsClasses(controlsVisible)}
                data-detail-media-action-menu
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.stopPropagation()}
              >
                {canOpenImagePreview && fullSizeImageSrc && (
                  <ExpandImageButton
                    onExpand={(origin) => {
                      onOpenImagePreview({
                        src: fullSizeImageSrc,
                        mediaRef: asset.media_ref,
                        siblings: collectCardImages(origin),
                      });
                    }}
                  />
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

/** The box round a picture or a video of the open card that its controls
 *  stand in: no wider than its column, no taller than the height limit (Р7),
 *  shrunk to the medium's frame, so the controls sit at the picture's corner. */
const DETAIL_MEDIA_ACTION_FRAME_CLASSES =
  "not-prose relative inline-flex max-h-[var(--detail-media-max-height)] max-w-full overflow-hidden align-top leading-none [&_img]:m-0 [&_img]:block [&_video]:m-0 [&_video]:block";

/** ⤢: opens the picture in the viewer over the window. */
function ExpandImageButton({ onExpand }: { onExpand: (origin: HTMLElement) => void }) {
  return (
    <Button
      type="button"
      variant="default"
      size="icon"
      aria-label="Expand image"
      data-detail-media-expand-button
      onClick={(event) => onExpand(event.currentTarget)}
    >
      <Expand className="size-[13px]" />
    </Button>
  );
}

/**
 * A picture of the open card that is no media asset: a link's page picture,
 * the preview the cache made of the page's image (SPEC_MEDIA_ASSET_ACTIONS.md,
 * «Картинка страницы у ссылки»). It stands in the same box as a media asset's
 * picture and opens in the viewer by ⤢ or a click, without Copy Media there.
 * It has no media menu, no right click menu and no drag: those act on a local
 * media file, and this picture names none.
 */
function ExpandableImageFrame({
  src,
  onOpenImagePreview,
  children,
}: {
  src: string;
  onOpenImagePreview: (preview: ImagePreviewRequest) => void;
  children: ReactNode;
}) {
  const open = () => onOpenImagePreview({ src, mediaRef: null });
  return (
    <div
      className={cn(DETAIL_MEDIA_ACTION_FRAME_CLASSES, "group/detail-media")}
      data-detail-media-action-frame
      onClick={(event) => {
        actOnReadingElement({ kind: "image" }, clickEvent(event), { openImagePreview: open });
      }}
    >
      {children}
      <div
        className={mediaControlsClasses(false)}
        data-detail-media-action-menu
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <ExpandImageButton onExpand={open} />
      </div>
    </div>
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
  SubContent: ComponentType<{
    widthRole?: FloatingMenuWidth;
    className?: string;
    children?: ReactNode;
  }>;
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
        <SubContent widthRole="search" className={COLLECTION_PICKER_CONTENT_CLASS}>
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

      <Item onSelect={() => revealInFinder(mediaPath)}>
        <MenuIconSlot />
        Reveal in Finder
      </Item>
      <Item onSelect={() => copyTextToClipboard(mediaPath, COPY_PATH_FAILED_TITLE)}>
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
        <div className="px-plate py-1.5 text-sm text-destructive">
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
        innerClassName="px-surface py-0.5"
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

export function RenameMediaAssetDialog({
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename media</DialogTitle>
          <DialogDescription>
            Rename only the media file. Elements and notes keep their filenames.
          </DialogDescription>
        </DialogHeader>
        {/* As Rename file: the field opens on the current name and the
            extension, which stays, stands after it. */}
        <div className="grid gap-2">
          <div className="flex items-center gap-2">
            <Input
              aria-label="Filename"
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
            {extension && (
              <span className="shrink-0 text-base text-muted-foreground">.{extension}</span>
            )}
          </div>
          {error && <p className={MODAL_ERROR_CLASS}>{error}</p>}
        </div>
        <DialogFooter>
          <DialogCancel disabled={submitting}>Cancel</DialogCancel>
          <Button onClick={() => void submit()} disabled={!value.trim() || submitting}>
            {submitting ? "Renaming…" : "Rename"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RemoveMediaAssetFromCardDialog({
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
          <AlertDialogTitle>Remove media from element?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes only this media reference from the current element. The media file stays in the space.
          </AlertDialogDescription>
          <div className={MODAL_DETAIL_CLASS}>{asset.media_ref}</div>
        </AlertDialogHeader>
        {error && <p className={MODAL_ERROR_CLASS}>{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          {/* Breaks a link and keeps the file: the detach colour, as the
              menu item that opened this (DESIGN_SYSTEM.md, «Два уровня
              опасных действий»). */}
          <AlertDialogAction
            className="text-detach"
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
            {submitting ? "Removing…" : "Remove from Element"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The description of `Delete media file?` (DESIGN_SYSTEM.md, «Тексты окон»):
 *  the file goes to the Trash, and the references cleared from the elements
 *  stay cleared even when the file comes back. An element that shows the file
 *  as its main media (`frontmatter_file`) shows nothing in its place. Until the
 *  plan names the elements, only what is true of every file is said. */
export function deleteMediaFileDescription(
  references: DeleteMediaAssetPlan["referenced_by"] | null,
): string {
  const trash = "The file goes to the Trash.";
  if (references === null || references.length === 0) return trash;
  const cleared = `${trash} Its references are removed from the elements below and do not come back if you restore the file.`;
  const showsAsMain = references.some((reference) =>
    reference.reference_kinds.includes("frontmatter_file"),
  );
  return showsAsMain
    ? `${cleared} Elements that show it as their main media will show nothing in its place.`
    : cleared;
}

export function DeleteMediaAssetDialog({
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
      <AlertDialogContent widthRole="content" className="min-w-0 overflow-hidden" data-delete-media-dialog="">
        <AlertDialogHeader className="min-w-0">
          <AlertDialogTitle>Delete media file?</AlertDialogTitle>
          <AlertDialogDescription>
            {deleteMediaFileDescription(plan?.referenced_by ?? null)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex min-w-0">
          <div className="flex h-24 w-32 items-center justify-center overflow-hidden rounded-1 border border-border bg-component-fill">
            {asset.media_kind === "image" ? (
              // A file that will not load keeps the tile's fill (Е6.8).
              <MissingAwareImage
                src={previewSrc}
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
              <span className="px-3 text-center text-sm text-muted-foreground">
                Media file
              </span>
            )}
          </div>
        </div>
        {/* A label over what it names, 8px apart, as a title over its
            description. */}
        <div className="grid min-w-0 gap-2">
          <div className={METADATA_LABEL_CLASSES}>Connected elements</div>
          <div
            className="min-w-0 overflow-y-auto pr-1"
            style={{ maxHeight: DELETE_MEDIA_CONNECTED_CARDS_MAX_HEIGHT_PX }}
            data-delete-media-connected-cards-scroll
            data-visible-card-count={DELETE_MEDIA_CONNECTED_CARDS_VISIBLE_COUNT}
          >
            {planLoading ? (
              <div className="text-sm text-muted-foreground">
                Checking elements…
              </div>
            ) : planError ? null : references.length > 0 ? (
              <MediaAssetReferenceCards
                references={references}
                vaultPath={vaultPath}
                thumbsRootPath={resolvedThumbsRoot}
                onOpenRelatedNote={onOpenRelatedNote}
              />
            ) : (
              <div className="text-sm text-muted-foreground">
                No elements use this file.
              </div>
            )}
          </div>
        </div>
        {planError && <p className={MODAL_ERROR_CLASS}>{planError}</p>}
        {error && <p className={MODAL_ERROR_CLASS}>{error}</p>}
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
            {submitting ? "Deleting…" : "Delete media"}
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
  const referencePointer = useHoverIntent();
  const referencePreviewOpener = useHoverPreviewOpener(referencePointer.isSlow);
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

  const openRelatedNotePreview = useCallback((note: HoveredRelatedNote) => {
    setHoveredRelatedNote(null);
    referencePreviewOpener.request(() => setHoveredRelatedNote(note));
  }, [referencePreviewOpener]);

  const requestCloseRelatedNotePreview = useCallback(() => {
    referencePreviewOpener.hide();
    setHoveredRelatedNote(null);
  }, [referencePreviewOpener]);

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
        referencePointer={referencePointer}
      />
    </>
  );
}

// ─── Markdown renderer for article body ─────────────────────────────────────

/** The editor, its own part of the bundle, loaded when it is first shown
 *  (SPEC_EDITING.md, Л0.6). */
const NoteEditor = lazy(async () => {
  const module = await import("./editing/NoteEditor");
  return { default: module.NoteEditor };
});

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
  onBodyWritten,
  onEditedBodyWritten,
  onBodyStale,
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
  /** The part after `#` of the link the card was opened by (`Heading`,
   *  `A#B`, `^block`): the article scrolls to that place (Ч11.8). */
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
  /** A task write changed the file: the card read anew (Ч12.3). */
  onBodyWritten: (block: IndexedBlock) => void;
  /** The editor wrote its text: the card read anew (Л3.7); the body the
   *  article reads stays (Л14). */
  onEditedBodyWritten: (block: IndexedBlock) => void;
  /** A task write found the file changed: the card reads its body again. */
  onBodyStale: () => void;
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

  // Phase 18.H.2: wikilinks are rewritten into standard markdown before
  // the pipeline reads the body (`ArticleMarkdown`); the lead video's image
  // is found in the same rendered text.
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
  const noteEmbeds = useNoteEmbedLookups(sourceSlug);
  const tasks = useTaskToggles(sourceSlug, sourceBodyHash ?? null, {
    onWritten: onBodyWritten,
    onStale: onBodyStale,
  });

  // The place the card opened at, once jumped to: a body written later (a
  // task box) keeps the reader where they are.
  const jumpedAnchorRef = useRef<string | null>(null);
  useEffect(() => {
    const anchor = scrollAnchor ? parseArticleAnchor(scrollAnchor) : null;
    const jump = `${sourceSlug ?? ""}\u0000${scrollAnchor ?? ""}`;
    if (!anchor || !articleRef.current || jumpedAnchorRef.current === jump) return;
    const root = articleRef.current;
    let frame: number | null = null;
    let current = true;
    // The embeds' first answers move what stands under them, and WebKit
    // keeps no scroll anchor: the jump waits for them (Ч11.4). The body may
    // still be the feed's start of it: the jump is tried again with the
    // whole body, and a place the note has not stays at the top (Ч11.8).
    void noteEmbeds.settled().then(() => {
      if (!current) return;
      frame = window.requestAnimationFrame(() => {
        const element = findArticleAnchor(root, body, anchor);
        if (!element) return;
        jumpedAnchorRef.current = jump;
        element.scrollIntoView?.({ block: "center", behavior: scrollBehavior() });
        element.setAttribute("data-scroll-anchor-hit", "true");
        window.setTimeout(() => {
          element.removeAttribute("data-scroll-anchor-hit");
        }, 1400);
      });
    });
    return () => {
      current = false;
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [body, noteEmbeds, scrollAnchor, sourceSlug]);

  const media = useMemo<ArticleMediaState>(
    () => ({
      body,
      vaultPath,
      thumbsRootPath,
      previewManifest,
      sourceSlug,
      tags,
      currentTag,
      omittedImageOffset,
      onCreateMediaAssetCard,
      onCreateChannelAndMediaAssetCard,
      onRenameMediaAsset,
      onRemoveMediaAssetFromCard,
      onDeleteMediaAsset,
      onOpenImagePreview,
      onOpenRelatedNote,
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

  const article = (
    <ArticleMarkdown
      rootRef={articleRef}
      onMouseUp={scheduleTextSelectionHandleUpdate}
      onKeyUp={scheduleTextSelectionHandleUpdate}
      data-article-body
      data-content-font=""
      body={body}
      sourceSlug={sourceSlug}
      vaultPath={vaultPath}
      thumbsRootPath={thumbsRootPath}
      noteEmbeds={noteEmbeds}
      tasks={tasks}
      image={ArticleBodyImage}
      onOpenNote={onOpenRelatedNote}
    >
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
    </ArticleMarkdown>
  );
  // The editor takes the article's place once the switch is on and the card's
  // whole body has come (SPEC_EDITING.md, Л1, Л2.1); until it opens, and when
  // the note cannot be edited, the article stays. The editor follows its note
  // through a rename by itself (Л4.8): it is not keyed by the slug.
  const editing = useContext(NoteEditingSwitch);
  // Where the lead video's embed starts in the body as written: the editor
  // takes it once, when its session opens (Л2.7).
  const omittedEmbedOffset = useMemo(
    () => (omittedImageOffset === null ? null : markdownSourceOffset(body, omittedImageOffset)),
    [body, omittedImageOffset],
  );
  // The editor's selection shows the same action bar, without Delete Text:
  // deleting is an edit there (Л11.2). While the bar is pressed or its menu
  // is open, a newer selection waits.
  const [editorSelection, setEditorSelection] = useState<EditorTextSelection | null>(null);
  const waitingEditorSelectionRef = useRef<EditorTextSelection | null | undefined>(undefined);
  const handleEditorSelection = useCallback((selection: EditorTextSelection | null) => {
    if (selectionHandleLockedRef.current || selectionMenuOpenRef.current) {
      waitingEditorSelectionRef.current = selection;
      return;
    }
    setEditorSelection(selection);
  }, []);
  const releaseEditorSelection = useCallback(() => {
    selectionHandleLockedRef.current = false;
    window.removeEventListener("pointerup", releaseEditorSelection, true);
    window.removeEventListener("pointercancel", releaseEditorSelection, true);
    const waiting = waitingEditorSelectionRef.current;
    waitingEditorSelectionRef.current = undefined;
    if (waiting !== undefined && !selectionMenuOpenRef.current) setEditorSelection(waiting);
  }, []);
  const holdEditorSelection = useCallback(() => {
    selectionHandleLockedRef.current = true;
    window.addEventListener("pointerup", releaseEditorSelection, true);
    window.addEventListener("pointercancel", releaseEditorSelection, true);
  }, [releaseEditorSelection]);
  const editorSelectionState = useMemo<TextSelectionHandleState | null>(() => (
    editorSelection
      ? {
        payload: editorSelection.payload,
        anchorRect: textSelectionAnchorRect(editorSelection.rect),
        safeBounds: textSelectionSafeBounds(editorSelection.root),
      }
      : null
  ), [editorSelection]);
  return (
    <ArticleMediaContext.Provider value={media}>
      {editing && sourceSlug && sourceBodyHash ? (
        <>
          <Suspense fallback={article}>
            <NoteEditor
              slug={sourceSlug}
              body={body}
              bodyHash={sourceBodyHash}
              fileName={`${sourceSlug.split("/").pop() ?? sourceSlug}.md`}
              vaultPath={vaultPath}
              thumbsRootPath={thumbsRootPath}
              noteEmbeds={noteEmbeds}
              image={ArticleBodyImage}
              onOpenNote={onOpenRelatedNote}
              onSaved={onEditedBodyWritten}
              omittedEmbed={omittedEmbedOffset}
              scrollAnchor={scrollAnchor}
              onTextSelection={hasTextSelectionActions ? handleEditorSelection : undefined}
              fallback={article}
            />
          </Suspense>
          {editorSelection && editorSelectionState && (
            <TextSelectionActionBar
              state={editorSelectionState}
              tags={tags}
              currentTag={currentTag}
              onCreateCard={onTextSelectionDrop}
              onCreateChannelAndCard={onCreateChannelAndTextSelectionCard}
              onInteractionStart={holdEditorSelection}
              onMenuOpenChange={(open) => {
                selectionMenuOpenRef.current = open;
                if (!open) releaseEditorSelection();
              }}
              onDismiss={() => {
                editorSelection.dismiss();
                setEditorSelection(null);
              }}
            />
          )}
        </>
      ) : article}
    </ArticleMediaContext.Provider>
  );
}

/** What a picture or video of the body needs of its article: the body for
 *  its place among the body's images, the card's media and their actions. */
interface ArticleMediaState {
  body: string;
  vaultPath: string;
  thumbsRootPath: string;
  previewManifest: ReturnType<typeof normalizeDetailPreviewManifest>;
  sourceSlug?: string;
  tags: TagCount[];
  currentTag?: string;
  /** Where the lead video's image starts in the rendered body: not drawn. */
  omittedImageOffset: number | null;
  onCreateMediaAssetCard: (asset: MediaAssetRef, tag: string) => Promise<void>;
  onCreateChannelAndMediaAssetCard: (asset: MediaAssetRef, tag: string) => Promise<void>;
  onRenameMediaAsset: (asset: MediaAssetRef, newStem: string) => Promise<void>;
  onRemoveMediaAssetFromCard: (asset: MediaAssetRef) => Promise<void>;
  onDeleteMediaAsset: (asset: MediaAssetRef) => Promise<void>;
  onOpenImagePreview: (preview: ImagePreviewRequest) => void;
  onOpenRelatedNote: (slug: string) => void;
}

const ArticleMediaContext = createContext<ArticleMediaState | null>(null);

/** A picture or a video of the body, with its media actions (Р5, Р6,
 *  SPEC_MEDIA_ASSET_ACTIONS.md). One component for every article: what
 *  changes comes from the context, so a new body does not remount it. */
function ArticleBodyImage({ node, src, alt, ...props }: ComponentProps<"img"> & ExtraProps) {
  const media = useContext(ArticleMediaContext);
  // Drawn in the editor's widget: its place is the editor's to count.
  const editorPlacement = useContext(EditorImagePlacementContext);
  if (!media) return null;
  const {
    body,
    vaultPath,
    thumbsRootPath,
    previewManifest,
    sourceSlug,
    tags,
    currentTag,
    omittedImageOffset,
    onCreateMediaAssetCard,
    onCreateChannelAndMediaAssetCard,
    onRenameMediaAsset,
    onRemoveMediaAssetFromCard,
    onDeleteMediaAsset,
    onOpenImagePreview,
    onOpenRelatedNote,
  } = media;
  const decodedSrc = decodeLocalMarkdownUrl(src ?? "");
  const previewTile = findPreviewTileForSource(previewManifest, decodedSrc);
  const resolvedSrc = previewTile?.sourcePath ?? decodedSrc;
  const originalSrc = resolveImageSrc(resolvedSrc, vaultPath);
  // Where this image stands among the body's `![`: Remove takes away
  // this one image and no other of the same file (Г1.4). In the editor the
  // place is counted from its document when Remove asks, not from the body
  // on every write (SPEC_EDITING.md, Л11.3, Л14); the editor draws the lead
  // video's embed as source, never here (Л2.7).
  const nodeStartOffset = node?.position?.start.offset;
  const occurrenceIndex = editorPlacement === null && typeof nodeStartOffset === "number"
    ? inlineMediaOccurrenceIndex(body, nodeStartOffset) ?? undefined
    : undefined;
  if (editorPlacement === null && omittedImageOffset !== null && nodeStartOffset === omittedImageOffset) {
    return null;
  }
  const removeFromCard = editorPlacement === null
    ? onRemoveMediaAssetFromCard
    : (asset: MediaAssetRef) => onRemoveMediaAssetFromCard({ ...asset, occurrence_index: editorPlacement.occurrenceIndex() });
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
        onRemoveMediaAssetFromCard={removeFromCard}
        onDeleteMediaAsset={onDeleteMediaAsset}
        onOpenRelatedNote={onOpenRelatedNote}
      >
        <DetailVideo
          key={originalSrc}
          src={originalSrc}
          recordedSize={detailMediaSize(previewTile?.width, previewTile?.height)}
          controls
          autoPlay
          muted
          loop
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
      onRemoveMediaAssetFromCard={removeFromCard}
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
        previewSlug={sourceSlug}
        alt={alt ?? ""}
        className="rounded-0"
        {...props}
      />
    </MediaAssetActionFrame>
  );
}

type TextSelectionHandleState = {
  payload: MineTextSelectionDragPayload;
  anchorRect: TextSelectionAnchorRect;
  safeBounds: TextSelectionSafeBounds;
};

function textSelectionAnchorRect(rect: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height">): TextSelectionAnchorRect {
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
            widthRole="search"
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

/// The small preview drawn under the original while the original loads. Its
/// file may not be there yet (a card saved a moment ago): the backing then
/// hides and the frame keeps its loading look instead of the browser's
/// broken-image icon, and loads again once this card's preview is ready
/// (SPEC_THUMBNAILS.md, «Нет файла миниатюры»).
function DetailPreviewBacking({
  src: previewSrc,
  slug,
  className,
  onLoad,
}: {
  src: string;
  slug: string | null | undefined;
  className: string;
  onLoad: (image: HTMLImageElement) => void;
}) {
  const { src, missing, markMissing } = usePreviewFileRetry(previewSrc, slug);
  if (missing) return null;
  return (
    <img
      src={src}
      alt=""
      className={className}
      onLoad={event => onLoad(event.currentTarget)}
      onError={markMissing}
      loading="eager"
      draggable={false}
      aria-hidden="true"
      data-detail-preview-backing=""
    />
  );
}

function DetailImage({
  src,
  sourceWidth,
  sourceHeight,
  previewSrc,
  previewSlug = null,
  contentInCloud = false,
  mediaRef = null,
  alt,
  className,
  onOwnSize,
  onUnavailable,
  ...imgProps
}: {
  src: string;
  sourceWidth?: number | null;
  sourceHeight?: number | null;
  previewSrc: string | null;
  /// The card whose preview `previewSrc` is: a missing preview file loads
  /// again when this card's preview is ready.
  previewSlug?: string | null;
  /// Whether this file's contents are held in iCloud rather than on this Mac.
  contentInCloud?: boolean;
  /// The card's media reference, for asking the system about its download.
  mediaRef?: string | null;
  alt: string;
  /// Called with the picture's own size when it replaces a recorded size of
  /// another proportion (Р6), so the content's width can follow the frame.
  onOwnSize?: (size: DetailMediaSize) => void;
  /// Called when the picture will not load and nothing stands in for it (no
  /// preview behind it, not held in iCloud): a caller that must not leave an
  /// empty frame removes it.
  onUnavailable?: () => void;
} & React.ImgHTMLAttributes<HTMLImageElement>) {
  const [originalReady, setOriginalReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Source geometry owns layout; loading changes pixels, never the box.
  // Legacy records without dimensions lock the first usable image geometry.
  // The one exception is a wrong size: when the original's own proportion
  // differs from the frame's, the frame takes the original's size (Р6, as a
  // video's frame does).
  const [recordedSize] = useState<DetailMediaSize | null>(() => detailMediaSize(sourceWidth, sourceHeight));
  const [size, setSize] = useState<DetailMediaSize | null>(recordedSize);
  // Two versions may load before the next render: the size they compare
  // with is the latest one set, not the one rendered.
  const sizeRef = useRef(size);
  const rememberSize = (image: HTMLImageElement, isOriginal: boolean) => {
    const natural = detailMediaSize(image.naturalWidth, image.naturalHeight);
    if (!natural) return;
    const current = sizeRef.current;
    // Only the original corrects a size: a preview's sides are rounded, and
    // a thin one would read as another proportion.
    if (current && (!isOriginal || sameMediaProportion(current, natural))) return;
    sizeRef.current = natural;
    setSize(natural);
    // Past the check above a recorded size is always one being corrected.
    if (recordedSize) onOwnSize?.(natural);
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

  const requestedSrc = withRetry(src, attempt);
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
    <DetailMediaFrame size={size} data-detail-image="">
      {previewSrc && !originalReady && (
        <DetailPreviewBacking
          src={previewSrc}
          slug={previewSlug}
          className={cn("block max-w-full rounded-0", className, size && DETAIL_MEDIA_FILL_CLASSES)}
          onLoad={(image) => rememberSize(image, false)}
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
          size && DETAIL_MEDIA_FILL_CLASSES,
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
          rememberSize(image, true);
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
            onUnavailable?.();
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
    </DetailMediaFrame>
  );
}

/**
 * The open card's one frame for a picture or a video (SPEC_FRONTEND.md,
 * «Раскладка открытой карточки», Р6). Once the medium's size is known the
 * frame takes its width and proportion (`detailMediaFrameStyle`) and the
 * medium fills it (`DETAIL_MEDIA_FILL_CLASSES`), so the element's box is the
 * drawn picture: no bars, and a video's own controls no wider than it.
 */
function DetailMediaFrame({
  size,
  className,
  ...props
}: { size: DetailMediaSize | null } & Omit<HTMLAttributes<HTMLDivElement>, "style">) {
  return (
    <div
      className={cn("relative max-w-full overflow-hidden leading-none", className)}
      style={size ? detailMediaFrameStyle(size) : undefined}
      {...props}
    />
  );
}

/**
 * A video of the open card in the one media frame. The record's size draws
 * the frame from the start; without one, or when the video's own proportion
 * differs from the record's (a phone video turned by its rotation), the frame
 * takes the size the video reports with its metadata (Р6). A new source is a
 * new element: callers key it by `src`.
 */
function DetailVideo({
  src,
  recordedSize,
  controls = false,
  autoPlay = false,
  muted = false,
  loop = false,
}: {
  src: string;
  recordedSize: DetailMediaSize | null;
  controls?: boolean;
  autoPlay?: boolean;
  muted?: boolean;
  loop?: boolean;
}) {
  const [size, setSize] = useState<DetailMediaSize | null>(recordedSize);
  return (
    <DetailMediaFrame size={size} data-detail-video="">
      <VideoFromBlob
        src={src}
        controls={controls}
        autoPlay={autoPlay}
        muted={muted}
        loop={loop}
        className={cn(
          "block max-w-full rounded-0",
          size ? DETAIL_MEDIA_FILL_CLASSES : "h-auto max-h-[var(--detail-media-max-height)]",
        )}
        onLoadedMetadata={(video) => {
          const own = detailMediaSize(video.videoWidth, video.videoHeight);
          if (!own) return;
          setSize((current) => (current && sameMediaProportion(current, own) ? current : own));
        }}
      />
    </DetailMediaFrame>
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
