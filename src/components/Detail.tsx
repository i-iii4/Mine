import { useCallback, useEffect, useRef, useState, useMemo, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useDraggable } from "@dnd-kit/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { GripVertical, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { getDisplayTitle, getNavigationLabel } from "@/lib/displayTitle";
import { getBlock } from "@/lib/commands";
import type { DetailTopMenuMode } from "@/lib/appPreferences";
import {
  findPreviewTileForSource,
  normalizeFeedPreviewManifest,
} from "@/lib/feedPreview";
import {
  setActiveMineTextSelectionDragPayload,
  type MineTextSelectionDragPayload,
} from "@/lib/textSelectionDrag";
import { VideoFromBlob } from "./VideoFromBlob";
import { ArticleAudioControls } from "./ArticleAudioControls";
import { CardMoreMenu } from "./CardHoverMenu";

// Layout constants — shared between scroll layer and metadata layer
const CLASSIC_LAYOUT_CLASSES = "mx-auto flex max-w-[58rem] gap-8 px-6 pt-12";
const ISLANDS_LAYOUT_CLASSES = "mx-auto flex max-w-[58rem] gap-8 px-6 pt-20";
const DETAIL_BOTTOM_SAFE_SPACE_CLASS = "pb-20";
const ARTICLE_H1_CLASSES = "mt-0 mb-4 text-lg leading-6 font-semibold";
const ARTICLE_SECTION_HEADING_CLASSES = "mt-6 mb-2 text-base leading-5 font-semibold";

interface DetailProps {
  block: LightBlock | IndexedBlock;
  scrollAnchor?: string | null;
  vaultPath: string;
  thumbsRootPath?: string;
  detailTopMenuMode?: DetailTopMenuMode;
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

export function Detail({
  block,
  scrollAnchor = null,
  vaultPath,
  thumbsRootPath,
  detailTopMenuMode = "island",
  onClose,
  onNavigate,
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
    if (isIndexedBlock(block)) return;
    let cancelled = false;
    void getBlock(block.slug).then((full) => {
      if (!cancelled && full) {
        setFullBlock(full);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [block]);

  const panelRef = useRef<HTMLDivElement>(null);

  // ESC to close, left/right arrows to navigate cards
  // Up/Down arrows left for native scroll of Detail content
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.metaKey || e.altKey || e.ctrlKey) return;
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        onNavigate(e.key === "ArrowLeft" ? "prev" : "next");
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [onClose, onNavigate]);

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
        "absolute inset-0 z-10 bg-background outline-none",
        !isFloatingTopMenu && "flex flex-col",
      )}
      role="dialog"
      aria-modal="false"
    >
      {isFloatingTopMenu ? (
        <header
          data-detail-top-menu={detailTopMenuMode}
          className={cn(
            "absolute left-1/2 top-4 z-20 flex h-8 w-[calc(100%-3rem)] max-w-[58rem] -translate-x-1/2 items-center",
            "gap-3 rounded-1 border border-border bg-accent/80 pl-3 pr-1 backdrop-blur-sm backdrop-saturate-150",
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
      ) : (
        <header
          className="flex h-8 shrink-0 items-center gap-3 border-b border-border bg-accent px-8"
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
        </header>
      )}
      <div className={cn("relative min-h-0", isFloatingTopMenu ? "h-full" : "flex-1")}>
        {/* Layer 1: Scrollable content + invisible spacer */}
        <div
          ref={panelRef}
          tabIndex={-1}
          className="h-full w-full overflow-y-auto outline-none"
          data-detail-scroll
        >
          <div className={cn(layoutClasses, DETAIL_BOTTOM_SAFE_SPACE_CLASS)}>
            <div className="min-w-0 flex-1">
              <BlockContent
                block={block}
                fullBlock={fullBlock}
                scrollAnchor={scrollAnchor}
                vaultPath={vaultPath}
                thumbsRootPath={thumbsRootPath}
                onTextSelectionDrop={onTextSelectionDrop}
              />
            </div>
            <div className="w-56 shrink-0" aria-hidden="true" />
          </div>
        </div>

        {/* Layer 2: Fixed metadata (same layout, doesn't scroll) */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className={layoutClasses}>
            <div className="flex-1" />
            <div className="pointer-events-auto w-56 shrink-0 overflow-y-auto" data-metadata-scroll>
              <MetadataPanel
                block={block}
                fullBlock={fullBlock}
                formattedDate={formattedDate}
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
  onOpenRelatedNote: (slug: string) => void;
}

function MetadataPanel({
  block,
  fullBlock,
  formattedDate,
  onOpenRelatedNote,
}: MetadataPanelProps) {
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
  const [availableRelatedNotes, setAvailableRelatedNotes] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (relatedNotes.length === 0) {
      setAvailableRelatedNotes(null);
      return;
    }
    let cancelled = false;
    setAvailableRelatedNotes(null);
    void Promise.all(
      relatedNotes.map(async (slug) => {
        const baseSlug = baseRelatedNoteSlug(slug);
        return { slug, block: await getBlock(baseSlug) };
      }),
    ).then((results) => {
      if (cancelled) return;
      setAvailableRelatedNotes(new Set(results.filter((item) => item.block).map((item) => item.slug)));
    });
    return () => {
      cancelled = true;
    };
  }, [relatedNotes, relatedNotesKey]);

  return (
    <div className="flex flex-col gap-5 font-mono">
      <ArticleAudioControls
        slug={displayBlock.slug}
        blockType={displayBlock.block_type}
        url={displayBlock.url}
      />

      {displayBlock.width != null && displayBlock.height != null && (
        <MetadataField label="RESOLUTION" value={`${displayBlock.width} \u00d7 ${displayBlock.height}`} />
      )}
      <MetadataField label="DATE" value={formattedDate} />

      <MetadataField label="TYPE" value={displayBlock.block_type.toUpperCase()} />

      {indexWarning && (
        <MetadataField label="WARNING" value={formatIndexWarning(indexWarning)} />
      )}

      {displayBlock.url && isSafeUrl(displayBlock.url) && (
        <div>
          <div className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
            SOURCE
          </div>
          <button
            onClick={() => openUrl(displayBlock.url!)}
            className="mt-1 block text-sm text-foreground hover:underline text-left"
          >
            {domainFromUrl(displayBlock.url)}
          </button>
        </div>
      )}

      {displayBlock.author && (
        <MetadataField label="AUTHOR" value={displayBlock.author} />
      )}

      {relatedNotes.length > 0 && (
        <div>
          <div className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
            RELATED NOTES
          </div>
          <div className="mt-1 flex flex-col items-start gap-1">
            {relatedNotes.map((slug) => {
              const isAvailable = availableRelatedNotes?.has(slug) ?? false;
              return isAvailable ? (
                <button
                  key={slug}
                  onClick={() => onOpenRelatedNote(slug)}
                  className="block text-left text-sm text-foreground hover:underline"
                >
                  {slug}
                </button>
              ) : (
                <span key={slug} className="text-sm text-muted-foreground">
                  {slug}
                </span>
              );
            })}
          </div>
        </div>
      )}

    </div>
  );
}

function MetadataField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm text-foreground">{value}</div>
    </div>
  );
}

function getIndexWarning(block: LightBlock | IndexedBlock): string | null {
  return "index_warning" in block ? block.index_warning ?? null : null;
}

function baseRelatedNoteSlug(target: string): string {
  return target.split("#", 1)[0] ?? target;
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

  switch (block.block_type) {
    case "image": {
      const src = block.media_file
        ? mediaUrl(vaultPath, block.media_file)
        : thumbnailUrl(resolvedThumbsRoot, block.slug);
      return (
        <div className="flex min-h-full items-center justify-center">
          <img
            src={src}
            alt={navigationLabel}
            className="max-h-[85vh] object-contain"
          />
        </div>
      );
    }
    case "link": {
      const src = block.media_file
        ? mediaUrl(vaultPath, block.media_file)
        : thumbnailUrl(resolvedThumbsRoot, block.slug);
      return (
        <div>
          <div className="aspect-video bg-accent">
            <img
              src={src}
              alt=""
              className="h-full w-full object-contain"
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
    case "article": {
      return (
        <div>
          {block.author && (
            <p className="text-base text-muted-foreground">
              {block.author}
            </p>
          )}
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
    case "video": {
      const embedUrl = block.url ? youtubeEmbedUrl(block.url) : null;
      const localSrc = block.media_file
        ? mediaUrl(vaultPath, block.media_file)
        : null;
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
              <video controls className="max-h-[85vh]">
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
    case "file":
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
        <p {...markdownBlockPositionProps(node)} {...props} />
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
      className="prose prose-sm mt-4 max-w-none"
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

  return (
    <div
      ref={setDragRef}
      {...(extraction ? dragAttributes : {})}
      {...(extraction ? dragListeners : {})}
      className={cn(
        "relative overflow-hidden",
        extraction && "cursor-grab active:cursor-grabbing",
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

type MarkdownPositionedNode = {
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
};

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
