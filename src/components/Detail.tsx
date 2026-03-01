import { useEffect, useState, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DialogContent, DialogClose } from "@/components/ui/dialog";
import type { IndexedBlock } from "@/types";
import { thumbnailUrl, mediaUrl, domainFromUrl } from "@/lib/assets";
import { addTag, removeTag } from "@/lib/commands";

// Layout constants — shared between scroll layer and metadata layer
const LAYOUT_CLASSES = "mx-auto flex max-w-[58rem] gap-8 px-6 pt-16";

interface DetailProps {
  block: IndexedBlock;
  vaultPath: string;
  onNavigate: (direction: "prev" | "next") => void;
  onTagsChanged: () => void;
}

export function Detail({
  block,
  vaultPath,
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

  const filename = block.media_file ?? `${block.slug}.md`;
  const formattedDate = new Date(block.saved_at).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <DialogContent
      className="top-0 right-0 bottom-0 left-[240px] flex w-auto max-w-none sm:max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-none bg-background p-0 shadow-none data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
      overlayClassName="left-[240px]"
      showCloseButton={false}
      onOpenAutoFocus={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement) return;
        if (e.key === "ArrowLeft") onNavigate("prev");
        if (e.key === "ArrowRight") onNavigate("next");
      }}
    >
      {/* Window drag region — sits above dialog overlay */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-20 h-7" />

      {/* Close button */}
      <DialogClose asChild>
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-3 right-3 z-10 size-8 text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </Button>
      </DialogClose>

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
    </DialogContent>
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

      {block.url && (
        <div>
          <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            SOURCE
          </div>
          <a
            href={block.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 block text-xs text-foreground hover:underline"
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
        <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
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
                className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100"
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
            className="h-auto w-20 border-none bg-transparent px-0 py-0 font-mono text-xs shadow-none focus-visible:ring-0"
          />
        </div>
      </div>
    </div>
  );
}

function MetadataField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-xs text-foreground">{value}</div>
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
              <p className="mt-2 text-sm text-muted-foreground">
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
            <p className="mt-1 text-sm text-muted-foreground">{block.author}</p>
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
          <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-muted text-lg font-bold text-muted-foreground">
            {block.media_file?.split(".").pop()?.toUpperCase() ?? "FILE"}
          </div>
          <p className="text-sm font-medium text-foreground">
            {block.title ?? block.slug}
          </p>
          {block.media_file && (
            <p className="text-xs text-muted-foreground">{block.media_file}</p>
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
            className="rounded-lg"
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
