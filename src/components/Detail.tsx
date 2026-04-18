import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { IndexedBlock, LightBlock } from "@/types";
import { openUrl } from "@tauri-apps/plugin-opener";
import { thumbnailUrl, mediaUrl, domainFromUrl, isSafeUrl, legacyThumbsRoot } from "@/lib/assets";
import { addTag, removeTag, getBlock } from "@/lib/commands";
import { VideoFromBlob } from "./VideoFromBlob";

// Layout constants — shared between scroll layer and metadata layer
const LAYOUT_CLASSES = "mx-auto flex max-w-[58rem] gap-8 px-6 pt-16";

interface DetailProps {
  block: LightBlock | IndexedBlock;
  vaultPath: string;
  thumbsRootPath?: string;
  onClose: () => void;
  onNavigate: (direction: "prev" | "next" | "up" | "down") => void;
  onTagsChanged: () => void;
}

function isIndexedBlock(block: LightBlock | IndexedBlock): block is IndexedBlock {
  return "tags" in block;
}

export function Detail({
  block,
  vaultPath,
  thumbsRootPath,
  onClose,
  onNavigate,
  onTagsChanged,
}: DetailProps) {
  const [fullBlock, setFullBlock] = useState<IndexedBlock | null>(
    isIndexedBlock(block) ? block : null,
  );
  const displayBlock = fullBlock ?? block;
  const [tags, setTags] = useState<string[]>(fullBlock?.tags ?? []);
  const [tagInput, setTagInput] = useState("");

  useEffect(() => {
    setFullBlock(isIndexedBlock(block) ? block : null);
    setTags(isIndexedBlock(block) ? block.tags : []);
    setTagInput("");
  }, [block]);

  useEffect(() => {
    if (isIndexedBlock(block)) return;
    let cancelled = false;
    void getBlock(block.slug).then((full) => {
      if (!cancelled && full) {
        setFullBlock(full);
        setTags(full.tags);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [block]);

  const handleAddTag = useCallback(async () => {
    const tag = tagInput.trim();
    if (!tag || tags.includes(tag)) return;
    try {
      await addTag(block.slug, tag);
      setTags((prev) => [...prev, tag]);
      setTagInput("");
      onTagsChanged();
    } catch (err) {
      console.error("Failed to add tag:", err);
    }
  }, [tagInput, tags, block.slug, onTagsChanged]);

  const handleRemoveTag = useCallback(
    async (tag: string) => {
      try {
        await removeTag(block.slug, tag);
        setTags((prev) => prev.filter((t) => t !== tag));
        onTagsChanged();
      } catch (err) {
        console.error("Failed to remove tag:", err);
      }
    },
    [block.slug, onTagsChanged],
  );

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
      className="absolute inset-0 z-10 flex bg-background outline-none"
      role="dialog"
      aria-modal="false"
    >
      <Button
        variant="ghost"
        size="icon"
        onClick={onClose}
        className="absolute top-10 right-4 text-muted-foreground hover:text-foreground"
      >
        <X className="size-4" />
        <span className="sr-only">Close</span>
      </Button>

      {/* Layer 1: Scrollable content + invisible spacer */}
      <div ref={panelRef} tabIndex={-1} className="h-full w-full overflow-y-auto outline-none">
        <div className={LAYOUT_CLASSES}>
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
        <div className={LAYOUT_CLASSES}>
          <div className="flex-1" />
          <div className="pointer-events-auto w-56 shrink-0 overflow-y-auto">
            <MetadataPanel
              block={block}
              fullBlock={fullBlock}
              filename={filename}
              formattedDate={formattedDate}
              tags={tags}
              tagInput={tagInput}
              onTagInputChange={setTagInput}
              onAddTag={handleAddTag}
              onRemoveTag={handleRemoveTag}
            />
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
  filename: string;
  formattedDate: string;
  tags: string[];
  tagInput: string;
  onTagInputChange: (value: string) => void;
  onAddTag: () => void;
  onRemoveTag: (tag: string) => void;
}

function MetadataPanel({
  block,
  fullBlock,
  filename,
  formattedDate,
  tags,
  tagInput,
  onTagInputChange,
  onAddTag,
  onRemoveTag,
}: MetadataPanelProps) {
  const displayBlock = fullBlock ?? block;
  return (
    <div className="flex flex-col gap-5 font-mono">
      {displayBlock.width != null && displayBlock.height != null && (
        <MetadataField label="RESOLUTION" value={`${displayBlock.width} \u00d7 ${displayBlock.height}`} />
      )}

      <MetadataField label="FILENAME" value={filename} />

      <MetadataField label="DATE" value={formattedDate} />

      <MetadataField label="TYPE" value={displayBlock.block_type.toUpperCase()} />

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

      {/* Tags */}
      <div>
        <div className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
          TAGS
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <Badge
              key={tag}
              variant="secondary"
              className="group gap-1 font-mono text-muted-foreground"
            >
              {tag}
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => onRemoveTag(tag)}
                className="size-3.5 opacity-0 group-hover:opacity-100"
              >
                <X className="size-2.5" />
              </Button>
            </Badge>
          ))}
          <Input
            type="text"
            value={tagInput}
            onChange={(e) => onTagInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onAddTag();
            }}
            placeholder="+ tag"
            className="h-auto w-20 border-none bg-transparent px-0 py-0 font-mono text-sm shadow-none focus-visible:ring-0"
          />
        </div>
      </div>
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
          <ArticleBody body={body} vaultPath={vaultPath} />
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
              <ArticleBody body={body} vaultPath={vaultPath} />
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
}: {
  body: string;
  vaultPath: string;
}) {
  const components: Components = useMemo(
    () => ({
      img: ({ src, alt, ...props }) => {
        const resolved = resolveImageSrc(src ?? "", vaultPath);
        // Video/GIF (downloaded MP4) — render as inline video with controls
        if (/\.mp4(\?|$)|\.webm(\?|$)/i.test(src ?? "")) {
          return <VideoFromBlob src={resolved} controls className="rounded-0" />;
        }
        return (
          <img
            src={resolved}
            alt={alt ?? ""}
            className="rounded-0"
            loading="lazy"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
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
    [vaultPath],
  );

  return (
    <div className="prose prose-sm mt-4 max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {body}
      </ReactMarkdown>
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
