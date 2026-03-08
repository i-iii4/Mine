import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { IndexedBlock } from "@/types";
import { thumbnailUrl, mediaUrl, domainFromUrl, isSafeUrl } from "@/lib/assets";
import { addTag, removeTag } from "@/lib/commands";

// Layout constants — shared between scroll layer and metadata layer
const LAYOUT_CLASSES = "mx-auto flex max-w-[58rem] gap-8 px-6 pt-16";

interface DetailProps {
  block: IndexedBlock;
  vaultPath: string;
  onClose: () => void;
  onNavigate: (direction: "prev" | "next" | "up" | "down") => void;
  onTagsChanged: () => void;
}

export function Detail({
  block,
  vaultPath,
  onClose,
  onNavigate,
  onTagsChanged,
}: DetailProps) {
  const [tags, setTags] = useState(block.tags);
  const [tagInput, setTagInput] = useState("");

  useEffect(() => {
    setTags(block.tags);
    setTagInput("");
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
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        onNavigate(e.key === "ArrowUp" ? "up" : "down");
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [onClose, onNavigate]);

  // Auto-focus the panel so keyboard events work immediately
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, [block]);

  const filename = block.media_file ?? `${block.slug}.md`;
  const formattedDate = new Date(block.saved_at).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="absolute inset-0 z-10 flex bg-background outline-none"
      role="dialog"
      aria-modal="false"
    >
      <Button
        variant="ghost"
        size="icon"
        onClick={onClose}
        className="absolute top-10 right-4 size-8 text-muted-foreground hover:text-foreground"
      >
        <X className="size-4" />
        <span className="sr-only">Close</span>
      </Button>

      {/* Layer 1: Scrollable content + invisible spacer */}
      <div className="h-full w-full overflow-y-auto">
        <div className={LAYOUT_CLASSES}>
          <div className="min-w-0 flex-1">
            <BlockContent block={block} vaultPath={vaultPath} />
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
  block: IndexedBlock;
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
  filename,
  formattedDate,
  tags,
  tagInput,
  onTagInputChange,
  onAddTag,
  onRemoveTag,
}: MetadataPanelProps) {
  return (
    <div className="flex flex-col gap-5 font-mono">
      {block.width != null && block.height != null && (
        <MetadataField label="RESOLUTION" value={`${block.width} \u00d7 ${block.height}`} />
      )}

      <MetadataField label="FILENAME" value={filename} />

      <MetadataField label="DATE" value={formattedDate} />

      <MetadataField label="TYPE" value={block.block_type.toUpperCase()} />

      {block.url && isSafeUrl(block.url) && (
        <div>
          <div className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
            SOURCE
          </div>
          <a
            href={block.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 block text-sm text-foreground hover:underline"
          >
            {domainFromUrl(block.url)}
          </a>
        </div>
      )}

      {block.author && (
        <MetadataField label="AUTHOR" value={block.author} />
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

// ─── Block content renderers ────────────────────────────────────────────────

function BlockContent({
  block,
  vaultPath,
}: {
  block: IndexedBlock;
  vaultPath: string;
}) {
  switch (block.block_type) {
    case "image": {
      const src = block.media_file
        ? mediaUrl(vaultPath, block.media_file)
        : thumbnailUrl(vaultPath, block.slug);
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
      const thumb = thumbnailUrl(vaultPath, block.slug);
      return (
        <div>
          <div className="aspect-video bg-muted">
            <img
              src={thumb}
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
            {block.description && (
              <p className="mt-2 text-base text-muted-foreground">
                {block.description}
              </p>
            )}
          </div>
        </div>
      );
    }
    case "article":
      return (
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            {block.title ?? block.slug}
          </h2>
          {block.author && (
            <p className="mt-1 text-base text-muted-foreground">{block.author}</p>
          )}
          <ArticleBody body={block.body} vaultPath={vaultPath} />
        </div>
      );
    case "video": {
      const src = block.media_file
        ? mediaUrl(vaultPath, block.media_file)
        : null;
      return (
        <div className="flex min-h-full items-center justify-center bg-black">
          {src ? (
            <video controls className="max-h-[85vh]">
              <source src={src} />
            </video>
          ) : (
            <div className="flex aspect-video items-center justify-center text-muted-foreground">
              No video file
            </div>
          )}
        </div>
      );
    }
    case "file":
      return (
        <div className="flex min-h-full flex-col items-center justify-center gap-3">
          <div className="flex h-16 w-16 items-center justify-center rounded-1 bg-muted text-lg font-semibold text-muted-foreground">
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
        return (
          <img
            src={resolved}
            alt={alt ?? ""}
            className="rounded-0"
            loading="lazy"
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
    <div className="prose prose-sm prose-neutral mt-4 max-w-none dark:prose-invert">
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
