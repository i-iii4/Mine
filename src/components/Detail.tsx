import { useEffect, useState, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DialogContent } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { IndexedBlock } from "@/types";
import { thumbnailUrl, mediaUrl, domainFromUrl } from "@/lib/assets";
import { addTag, removeTag } from "@/lib/commands";

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
    } catch {
      // Silently fail — user will see tag didn't appear
    }
  }, [tagInput, tags, block.slug, onTagsChanged]);

  const handleRemoveTag = useCallback(
    async (tag: string) => {
      try {
        await removeTag(block.slug, tag);
        setTags((prev) => prev.filter((t) => t !== tag));
        onTagsChanged();
      } catch {
        // Silently fail
      }
    },
    [block.slug, onTagsChanged],
  );

  return (
    <DialogContent
      className="flex max-h-[90vh] max-w-3xl flex-col gap-0 overflow-hidden p-0"
      onOpenAutoFocus={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        // Arrow navigation only when not typing in an input
        if (e.target instanceof HTMLInputElement) return;
        if (e.key === "ArrowLeft") onNavigate("prev");
        if (e.key === "ArrowRight") onNavigate("next");
      }}
    >
      {/* Content */}
      <ScrollArea className="flex-1">
        <BlockContent block={block} vaultPath={vaultPath} />
      </ScrollArea>

      {/* Metadata */}
      <div className="border-t border-border px-6 py-4">
        {/* Tags */}
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((tag) => (
            <Badge
              key={tag}
              variant="secondary"
              className="group gap-1 text-muted-foreground"
            >
              {tag}
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => handleRemoveTag(tag)}
                className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100"
              >
                <X className="size-2.5" />
              </Button>
            </Badge>
          ))}
          <Input
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddTag();
            }}
            placeholder="+ tag"
            className="h-auto w-20 border-none bg-transparent px-0 py-0 text-xs shadow-none focus-visible:ring-0"
          />
        </div>

        {/* Info row */}
        <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
          <span>{block.block_type}</span>
          <span>{new Date(block.saved_at).toLocaleDateString()}</span>
          {block.source && <span>{block.source}</span>}
          {block.url && (
            <a
              href={block.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 hover:underline"
            >
              {domainFromUrl(block.url)}
            </a>
          )}
        </div>
      </div>
    </DialogContent>
  );
}

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
        <div className="flex items-center justify-center bg-muted">
          <img
            src={src}
            alt={block.title ?? block.slug}
            className="max-h-[60vh] object-contain"
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
          <div className="px-6 py-4">
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
        <div className="px-6 py-6">
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
        <div className="bg-black">
          {src ? (
            <video controls className="mx-auto max-h-[60vh]">
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
        <div className="flex flex-col items-center justify-center gap-3 py-12">
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
