import { useState } from "react";
import type { IndexedBlock } from "@/types";
import { thumbnailUrl, mediaUrl, domainFromUrl } from "@/lib/assets";

interface CardProps {
  block: IndexedBlock;
  vaultPath: string;
  onClick: (block: IndexedBlock) => void;
}

export function Card({ block, vaultPath, onClick }: CardProps) {
  const handleClick = () => onClick(block);
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick(block);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className="group cursor-pointer overflow-hidden rounded-lg border border-neutral-200 bg-white transition-shadow hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900"
    >
      <CardContent block={block} vaultPath={vaultPath} />
    </div>
  );
}

function CardContent({
  block,
  vaultPath,
}: {
  block: IndexedBlock;
  vaultPath: string;
}) {
  switch (block.block_type) {
    case "image":
      return <ImageCard block={block} vaultPath={vaultPath} />;
    case "link":
      return <LinkCard block={block} vaultPath={vaultPath} />;
    case "article":
      return <ArticleCard block={block} />;
    case "video":
      return <VideoCard block={block} vaultPath={vaultPath} />;
    case "file":
      return <FileCard block={block} />;
  }
}

function ImageCard({
  block,
  vaultPath,
}: {
  block: IndexedBlock;
  vaultPath: string;
}) {
  const [error, setError] = useState(false);
  const src = block.media_file
    ? mediaUrl(vaultPath, block.media_file)
    : thumbnailUrl(vaultPath, block.slug);

  if (error) {
    return (
      <div className="flex aspect-square items-center justify-center bg-neutral-100 dark:bg-neutral-800">
        <div className="text-center">
          <BrokenImageIcon />
          <p className="mt-1 text-xs text-neutral-400">
            {block.title ?? block.slug}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <img
        src={src}
        alt={block.title ?? block.slug}
        className="w-full"
        loading="lazy"
        onError={() => setError(true)}
      />
      {block.title && (
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-3 opacity-0 transition-opacity group-hover:opacity-100">
          <p className="truncate text-sm text-white">{block.title}</p>
        </div>
      )}
    </div>
  );
}

const LINK_COLORS = [
  "bg-blue-900", "bg-emerald-900", "bg-violet-900", "bg-amber-900",
  "bg-rose-900", "bg-cyan-900", "bg-indigo-900", "bg-teal-900",
];

function LinkCard({
  block,
  vaultPath,
}: {
  block: IndexedBlock;
  vaultPath: string;
}) {
  const [thumbLoaded, setThumbLoaded] = useState(false);
  const [thumbError, setThumbError] = useState(false);
  const thumb = thumbnailUrl(vaultPath, block.slug);
  const domain = block.url ? domainFromUrl(block.url) : null;

  // No thumbnail — compact card (title + domain only)
  if (thumbError) {
    return (
      <div className="p-3">
        <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
          {block.title ?? block.slug}
        </p>
        {domain && (
          <p className="mt-0.5 truncate text-xs text-neutral-500">{domain}</p>
        )}
      </div>
    );
  }

  const initial = (domain ?? block.slug).charAt(0).toUpperCase();
  const colorIdx = block.slug.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const bgColor = LINK_COLORS[colorIdx % LINK_COLORS.length]!;

  return (
    <div className="flex flex-col">
      <div className={`relative aspect-video ${bgColor}`}>
        {!thumbLoaded && (
          <div className="flex h-full flex-col items-center justify-center gap-1">
            <span className="text-3xl font-bold text-white/40">{initial}</span>
            {domain && (
              <span className="text-xs text-white/30">{domain}</span>
            )}
          </div>
        )}
        <img
          src={thumb}
          alt=""
          className={`absolute inset-0 h-full w-full object-cover transition-opacity ${thumbLoaded ? "opacity-100" : "opacity-0"}`}
          onLoad={() => setThumbLoaded(true)}
          onError={() => setThumbError(true)}
        />
      </div>
      <div className="p-3">
        <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
          {block.title ?? block.slug}
        </p>
        {domain && (
          <p className="mt-0.5 truncate text-xs text-neutral-500">{domain}</p>
        )}
      </div>
    </div>
  );
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/\[(.+?)\]\(.*?\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^---+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function ArticleCard({ block }: { block: IndexedBlock }) {
  const preview = stripMarkdown(block.body).slice(0, 400).trim();

  return (
    <div className="p-4">
      <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
        {block.title ?? block.slug}
      </p>
      {preview && (
        <p className="mt-1.5 line-clamp-8 text-xs leading-relaxed text-neutral-500">
          {preview}
        </p>
      )}
      {block.author && (
        <p className="mt-2 text-xs text-neutral-400">{block.author}</p>
      )}
    </div>
  );
}

function VideoCard({
  block,
  vaultPath,
}: {
  block: IndexedBlock;
  vaultPath: string;
}) {
  const thumb = thumbnailUrl(vaultPath, block.slug);

  return (
    <div className="relative aspect-video">
      <img
        src={thumb}
        alt=""
        className="h-full w-full object-cover"
        loading="lazy"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = "none";
        }}
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4 2.5v11l10-5.5L4 2.5z" />
          </svg>
        </div>
      </div>
      {block.title && (
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-3">
          <p className="truncate text-sm text-white">{block.title}</p>
        </div>
      )}
    </div>
  );
}

function FileCard({ block }: { block: IndexedBlock }) {
  const ext = block.media_file
    ?.split(".")
    .pop()
    ?.toUpperCase();

  return (
    <div className="flex items-center gap-3 p-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-xs font-semibold text-neutral-500 dark:bg-neutral-800">
        {ext ?? "FILE"}
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
          {block.title ?? block.slug}
        </p>
        {block.media_file && (
          <p className="truncate text-xs text-neutral-500">
            {block.media_file}
          </p>
        )}
      </div>
    </div>
  );
}

function BrokenImageIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mx-auto text-neutral-300 dark:text-neutral-600"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 16l5-5 4 4" />
      <path d="M14 14l2-2 5 5" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}
