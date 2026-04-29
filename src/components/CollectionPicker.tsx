import { useState } from "react";
import { Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import type { TagCount } from "@/types";
import { getRecentTags } from "@/lib/recentTags";

/** Convert a collection ref to a compact display title. */
export function titleFromTag(tag: string): string {
  const parts = tag.split("/");
  const label = (parts[parts.length - 1] ?? tag).trim();
  return label.charAt(0).toUpperCase() + label.slice(1);
}

interface CollectionPickerProps {
  blockSlug: string;
  selectedTags: string[];
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  /** Prevent parent menu typeahead from capturing keystrokes */
  stopKeyPropagation?: boolean;
}

/**
 * Reusable tag picker UI: search + checkbox list + create.
 * Used in both ContextMenu and DropdownMenu.
 */
export function CollectionPicker({
  blockSlug,
  selectedTags,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  stopKeyPropagation = false,
}: CollectionPickerProps) {
  const [search, setSearch] = useState("");

  const recentTags = getRecentTags();
  const recentSet = new Set(recentTags);

  const sortedTags = [...tags].sort((a, b) => {
    if (currentTag) {
      const aCur = a.tag === currentTag;
      const bCur = b.tag === currentTag;
      if (aCur !== bCur) return aCur ? -1 : 1;
    }

    const aHas = selectedTags.includes(a.tag);
    const bHas = selectedTags.includes(b.tag);
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
    <>
      {/* Search */}
      <div
        className="shrink-0 p-2 pb-1"
        onKeyDown={stopKeyPropagation ? (e) => e.stopPropagation() : undefined}
      >
        <Input
          autoFocus
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search channels..."
          className="h-auto py-1.5"
        />
      </div>

      {/* Tag list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-1 py-0.5">
          {filtered.map((tc) => {
            const hasTag = selectedTags.includes(tc.tag);
            return (
              <button
                key={tc.tag}
                onClick={() => onToggleTag(blockSlug, tc.tag, hasTag)}
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
                onCreateAndAssign(trimmed, blockSlug);
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
    </>
  );
}
