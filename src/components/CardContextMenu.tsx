import { useEffect, useRef, useLayoutEffect, useState } from "react";
import type { IndexedBlock, TagCount } from "@/types";
import { getRecentTags } from "@/lib/recentTags";

interface CardContextMenuProps {
  block: IndexedBlock;
  x: number;
  y: number;
  tags: TagCount[];
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onDelete: (slug: string) => void;
  onClose: () => void;
}

/** Convert a normalized tag slug to a display title: `web-design` -> `Web Design` */
function titleFromTag(tag: string): string {
  return tag
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function CardContextMenu({
  block,
  x,
  y,
  tags,
  onToggleTag,
  onCreateAndAssign,
  onDelete,
  onClose,
}: CardContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [search, setSearch] = useState("");

  // Adjust position to stay within viewport (runs before paint)
  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let ax = x;
    let ay = y;
    if (rect.right > vw) ax = vw - rect.width - 8;
    if (rect.bottom > vh) ay = vh - rect.height - 8;
    if (ax < 0) ax = 8;
    if (ay < 0) ay = 8;
    if (ax !== x || ay !== y) setPos({ x: ax, y: ay });
  }, [x, y]);

  // Focus search input on open
  useEffect(() => {
    const t = setTimeout(() => searchRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  // Close on click outside or Escape
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Sort tags: assigned first, then recent, then alphabetical
  const recentTags = getRecentTags();
  const recentSet = new Set(recentTags);

  const sortedTags = [...tags].sort((a, b) => {
    const aHas = block.tags.includes(a.tag);
    const bHas = block.tags.includes(b.tag);
    if (aHas !== bHas) return aHas ? -1 : 1;

    const aRecent = recentSet.has(a.tag);
    const bRecent = recentSet.has(b.tag);
    if (aRecent !== bRecent) return aRecent ? -1 : 1;
    if (aRecent && bRecent) {
      return recentTags.indexOf(a.tag) - recentTags.indexOf(b.tag);
    }

    return a.tag.localeCompare(b.tag);
  });

  // Filter by search
  const lc = search.toLowerCase();
  const filtered = lc
    ? sortedTags.filter((tc) => titleFromTag(tc.tag).toLowerCase().includes(lc))
    : sortedTags;

  // Offer to create when search has no matches
  const trimmed = search.trim();
  const canCreate = trimmed.length > 0 && filtered.length === 0;

  return (
    <div
      ref={ref}
      className="fixed z-50 w-64 rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
      style={{ left: pos.x, top: pos.y }}
    >
      {/* Search */}
      <div className="p-2 pb-1">
        <input
          ref={searchRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search channels..."
          className="w-full rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 dark:border-neutral-600 dark:bg-neutral-900 dark:focus:border-neutral-500"
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      {/* Tag list */}
      <div className="max-h-48 overflow-y-auto px-1 py-0.5">
        {filtered.map((tc) => {
          const hasTag = block.tags.includes(tc.tag);
          return (
            <button
              key={tc.tag}
              onClick={(e) => {
                e.stopPropagation();
                onToggleTag(block.slug, tc.tag, hasTag);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700"
            >
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                  hasTag
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                    : "border-neutral-300 dark:border-neutral-600"
                }`}
              >
                {hasTag && "\u2713"}
              </span>
              <span className="flex-1 truncate text-left text-neutral-700 dark:text-neutral-200">
                {titleFromTag(tc.tag)}
              </span>
              <span className="shrink-0 text-xs text-neutral-400">
                {tc.count}
              </span>
            </button>
          );
        })}

        {canCreate && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCreateAndAssign(trimmed, block.slug);
              setSearch("");
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-700"
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-xs">
              +
            </span>
            <span>
              Create &ldquo;{trimmed}&rdquo;
            </span>
          </button>
        )}

        {filtered.length === 0 && !canCreate && (
          <p className="px-2 py-3 text-center text-xs text-neutral-400">
            No channels
          </p>
        )}
      </div>

      {/* Delete — hidden while searching */}
      {!search && (
        <div className="border-t border-neutral-200 px-1 py-0.5 dark:border-neutral-700">
          {confirmingDelete ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(block.slug);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
            >
              <TrashIcon />
              <span>Confirm delete</span>
            </button>
          ) : (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setConfirmingDelete(true);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
            >
              <TrashIcon />
              <span>Delete card</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TrashIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M1.5 3h9M4 3V2a1 1 0 011-1h2a1 1 0 011 1v1M9.5 3v7a1 1 0 01-1 1h-5a1 1 0 01-1-1V3" />
    </svg>
  );
}
