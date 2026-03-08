import { useState } from "react";
import { Trash2, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import type { LightBlock, TagCount } from "@/types";
import { getRecentTags } from "@/lib/recentTags";

interface CardTagMenuProps {
  block: LightBlock;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestDelete: (slug: string) => void;
}

/** Convert a normalized tag slug to a display title: `web-design` -> `Web Design` */
function titleFromTag(tag: string): string {
  return tag
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Renders ContextMenuContent with tag management UI.
 * Must be used inside a <ContextMenu> wrapper.
 */
export function CardTagMenu({
  block,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestDelete,
}: CardTagMenuProps) {
  const [search, setSearch] = useState("");

  // Sort tags: current channel > assigned > recent > alphabetical
  const recentTags = getRecentTags();
  const recentSet = new Set(recentTags);

  const sortedTags = [...tags].sort((a, b) => {
    if (currentTag) {
      const aCur = a.tag === currentTag;
      const bCur = b.tag === currentTag;
      if (aCur !== bCur) return aCur ? -1 : 1;
    }

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

  const lc = search.toLowerCase();
  const filtered = lc
    ? sortedTags.filter((tc) => titleFromTag(tc.tag).toLowerCase().includes(lc))
    : sortedTags;

  const trimmed = search.trim();
  const canCreate = trimmed.length > 0 && filtered.length === 0;

  return (
    <ContextMenuContent className="flex w-64 max-h-80 flex-col overflow-hidden p-0">
      {/* Search — fixed at top, stopPropagation prevents ContextMenu typeahead */}
      <div className="shrink-0 p-2 pb-1" onKeyDown={(e) => e.stopPropagation()}>
        <Input
          autoFocus
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search channels..."
          className="h-auto py-1.5"
        />
      </div>

      {/* Tag list — scrollable, custom buttons (don't close menu) */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-1 py-0.5">
        {filtered.map((tc) => {
          const hasTag = block.tags.includes(tc.tag);
          return (
            <button
              key={tc.tag}
              onClick={() => onToggleTag(block.slug, tc.tag, hasTag)}
              className="flex w-full items-center gap-2 rounded-1 px-2 py-1.5 text-base hover:bg-accent"
            >
              <Checkbox
                checked={hasTag}
                tabIndex={-1}
                className="pointer-events-none"
              />
              <span className="flex-1 truncate text-left text-foreground">
                {titleFromTag(tc.tag)}
              </span>
              <span className="shrink-0 text-sm text-muted-foreground">
                {tc.count}
              </span>
            </button>
          );
        })}

        {canCreate && (
          <button
            onClick={() => {
              onCreateAndAssign(trimmed, block.slug);
              setSearch("");
            }}
            className="flex w-full items-center gap-2 rounded-1 px-2 py-1.5 text-base font-semibold text-foreground hover:bg-accent"
          >
            <Plus className="size-4 shrink-0" />
            <span>
              Create &ldquo;{trimmed}&rdquo;
            </span>
          </button>
        )}

        {filtered.length === 0 && !canCreate && (
          <p className="px-2 py-3 text-center text-sm text-muted-foreground">
            No channels
          </p>
        )}
        </div>
      </div>

      {/* Delete — fixed at bottom, hidden while searching */}
      {!search && (
        <div className="shrink-0">
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onSelect={() => onRequestDelete(block.slug)}
          >
            <Trash2 className="size-3" />
            Delete card
          </ContextMenuItem>
        </div>
      )}
    </ContextMenuContent>
  );
}
