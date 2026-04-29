import { useEffect, useRef, useState, useMemo } from "react";
import { useDraggable } from "@dnd-kit/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { X } from "lucide-react";
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
import { getBlock } from "@/lib/commands";
import type { DetailTopMenuMode } from "@/lib/appPreferences";
import {
  findPreviewTileForSource,
  normalizeFeedPreviewManifest,
} from "@/lib/feedPreview";
import { VideoFromBlob } from "./VideoFromBlob";
import { ArticleAudioControls } from "./ArticleAudioControls";
import { CardMoreMenu } from "./CardHoverMenu";

// Layout constants — shared between scroll layer and metadata layer
const CLASSIC_LAYOUT_CLASSES = "mx-auto flex max-w-[58rem] gap-8 px-6 pt-12";
const ISLANDS_LAYOUT_CLASSES = "mx-auto flex max-w-[58rem] gap-8 px-6 pt-20";

interface DetailProps {
  block: LightBlock | IndexedBlock;
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
}

type DetailInlineMediaExtraction = {
  sourceSlug: string;
  mediaRef: string;
  title: string | null;
};

function isIndexedBlock(block: LightBlock | IndexedBlock): block is IndexedBlock {
  return "tags" in block;
}

export function Detail({
  block,
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
          <div className={layoutClasses}>
            <div className="min-w-0 flex-1">
              <BlockContent
                block={block}
                fullBlock={fullBlock}
                vaultPath={vaultPath}
                thumbsRootPath={thumbsRootPath}
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
      relatedNotes.map(async (slug) => ({ slug, block: await getBlock(slug) })),
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

function isTwitterUrl(url: string): boolean {
  const lc = url.toLowerCase();
  return (lc.includes("twitter.com/") || lc.includes("x.com/")) && lc.includes("/status/");
}

// ─── Block content renderers ────────────────────────────────────────────────

function BlockContent({
  block,
  fullBlock,
  vaultPath,
  thumbsRootPath,
}: {
  block: LightBlock | IndexedBlock;
  fullBlock: IndexedBlock | null;
  vaultPath: string;
  thumbsRootPath?: string;
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

  switch (block.block_type) {
    case "image": {
      const src = block.media_file
        ? mediaUrl(vaultPath, block.media_file)
        : thumbnailUrl(resolvedThumbsRoot, block.slug);
      return (
        <div className="flex min-h-full items-center justify-center">
          <img
            src={src}
            alt={block.title ?? block.slug}
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
            <h2 className="text-lg font-semibold text-foreground">
              {block.title ?? block.slug}
            </h2>
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
      const isTwitter = block.url ? isTwitterUrl(block.url) : false;
      return (
        <div>
          {!isTwitter && (
            <h2 className="text-lg font-semibold text-foreground">
              {block.title ?? block.slug}
            </h2>
          )}
          {block.author && (
            <p className={isTwitter ? "text-base text-muted-foreground" : "mt-1 text-base text-muted-foreground"}>
              {block.author}
            </p>
          )}
          <ArticleBody
            body={body}
            vaultPath={vaultPath}
            thumbsRootPath={resolvedThumbsRoot}
            previewManifest={previewManifest}
            sourceSlug={block.slug}
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
            {block.title ?? block.slug}
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
}: {
  body: string;
  vaultPath: string;
  thumbsRootPath: string;
  previewManifest: ReturnType<typeof normalizeFeedPreviewManifest>;
  sourceSlug?: string;
}) {
  const components: Components = useMemo(
    () => ({
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
              title: alt?.trim() ? alt.trim() : null,
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
    [previewManifest, thumbsRootPath, vaultPath],
  );

  // Phase 18.H.2: rewrite Obsidian wikilinks into standard markdown
  // before passing to react-markdown. The raw `.md` file stays in
  // wikilink form for Obsidian; only the render pipeline sees the
  // transformed markdown.
  const processedBody = useMemo(() => preprocessWikilinks(body), [body]);

  return (
    <div className="prose prose-sm mt-4 max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {processedBody}
      </ReactMarkdown>
    </div>
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
          title: extraction.title,
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

function isExtractableLocalImage(src: string): boolean {
  if (src.startsWith("http://") || src.startsWith("https://")) {
    return false;
  }
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(src);
}
