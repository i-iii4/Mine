import { useEffect, useState, useCallback } from "react";
import type { IndexedBlock } from "@/types";
import { thumbnailUrl, mediaUrl, domainFromUrl } from "@/lib/assets";
import { addTag, removeTag } from "@/lib/commands";

interface DetailProps {
  block: IndexedBlock;
  vaultPath: string;
  onClose: () => void;
  onNavigate: (direction: "prev" | "next") => void;
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

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onNavigate("prev");
      else if (e.key === "ArrowRight") onNavigate("next");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, onNavigate]);

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
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="relative mx-4 flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute right-3 top-3 z-10 rounded-full bg-neutral-100/80 p-1.5 text-neutral-600 transition-colors hover:bg-neutral-200 dark:bg-neutral-800/80 dark:text-neutral-400 dark:hover:bg-neutral-700"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <BlockContent block={block} vaultPath={vaultPath} />
        </div>

        {/* Metadata */}
        <div className="border-t border-neutral-200 px-6 py-4 dark:border-neutral-800">
          {/* Tags */}
          <div className="flex flex-wrap items-center gap-1.5">
            {tags.map((tag) => (
              <span
                key={tag}
                className="group inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
              >
                {tag}
                <button
                  onClick={() => handleRemoveTag(tag)}
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
                  </svg>
                </button>
              </span>
            ))}
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddTag();
              }}
              placeholder="+ tag"
              className="w-20 bg-transparent text-xs text-neutral-500 outline-none placeholder:text-neutral-400"
            />
          </div>

          {/* Info row */}
          <div className="mt-3 flex items-center gap-4 text-xs text-neutral-500">
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
      </div>
    </div>
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
        <div className="flex items-center justify-center bg-neutral-100 dark:bg-neutral-950">
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
          <div className="aspect-video bg-neutral-100 dark:bg-neutral-950">
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
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              {block.title ?? block.slug}
            </h2>
            {block.description && (
              <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
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
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            {block.title ?? block.slug}
          </h2>
          {block.author && (
            <p className="mt-1 text-sm text-neutral-500">{block.author}</p>
          )}
          <div className="prose prose-sm mt-4 max-w-none text-neutral-700 dark:prose-invert dark:text-neutral-300">
            {block.body.split("\n").map((line, i) => (
              <p key={i}>{line || "\u00A0"}</p>
            ))}
          </div>
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
            <div className="flex aspect-video items-center justify-center text-neutral-500">
              No video file
            </div>
          )}
        </div>
      );
    }
    case "file":
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-12">
          <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-neutral-100 text-lg font-bold text-neutral-500 dark:bg-neutral-800">
            {block.media_file?.split(".").pop()?.toUpperCase() ?? "FILE"}
          </div>
          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {block.title ?? block.slug}
          </p>
          {block.media_file && (
            <p className="text-xs text-neutral-500">{block.media_file}</p>
          )}
        </div>
      );
  }
}
