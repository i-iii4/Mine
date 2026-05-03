import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { TagCount } from "@/types";
import { getRecentTags } from "@/lib/recentTags";
import { cn } from "@/lib/utils";

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
 * Reusable tag picker UI: search + connection action list + create.
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
  const [optimisticTags, setOptimisticTags] = useState(selectedTags);
  const selectedTagsKey = selectedTags.join("\0");

  useEffect(() => {
    setOptimisticTags(selectedTags);
  }, [blockSlug, selectedTagsKey]);

  const recentTags = getRecentTags();
  const recentSet = new Set(recentTags);

  const sortedTags = [...tags].sort((a, b) => {
    if (currentTag) {
      const aCur = a.tag === currentTag;
      const bCur = b.tag === currentTag;
      if (aCur !== bCur) return aCur ? -1 : 1;
    }

    const aHas = optimisticTags.includes(a.tag);
    const bHas = optimisticTags.includes(b.tag);
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

  const toggleTag = (tag: string, hasTag: boolean) => {
    setOptimisticTags((current) => (
      hasTag
        ? current.filter((item) => item !== tag)
        : current.includes(tag) ? current : [...current, tag]
    ));
    onToggleTag(blockSlug, tag, hasTag);
  };

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
            const hasTag = optimisticTags.includes(tc.tag);
            const actionLabel = hasTag ? "Disconnect" : "Connect";
            const title = titleFromTag(tc.tag);
            return (
              <div
                key={tc.tag}
                className="group flex w-full items-center gap-2 rounded-1 px-2 py-1.5 text-base hover:bg-accent focus-within:bg-accent"
              >
                <span className="flex-1 truncate text-left text-foreground">
                  {title}
                </span>
                <div className="relative flex h-6 w-[10ch] shrink-0 items-center justify-end">
                  <span
                    className={cn(
                      "absolute right-0 text-sm text-muted-foreground transition-opacity duration-[160ms]",
                      hasTag
                        ? "opacity-0"
                        : "opacity-100 group-hover:opacity-0 group-focus-within:opacity-0",
                    )}
                  >
                    {tc.count}
                  </span>
                  <button
                    type="button"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      toggleTag(tc.tag, hasTag);
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                    }}
                    className={cn(
                      "absolute right-0 inline-flex h-6 w-[10ch] cursor-pointer items-center justify-center rounded-1 bg-component-fill px-[1ch] font-sans text-sm font-semibold text-foreground outline-0 outline-transparent transition-opacity duration-[160ms] hover:outline-1 hover:-outline-offset-1 hover:outline-component-fill-hover focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-component-fill-hover",
                      hasTag
                        ? "opacity-100"
                        : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
                    )}
                    aria-label={`${actionLabel} ${title}`}
                  >
                    {hasTag ? (
                      <>
                        <span className="group-hover:hidden group-focus-within:hidden">Connected</span>
                        <span className="hidden text-destructive group-hover:inline group-focus-within:inline">Disconnect</span>
                      </>
                    ) : (
                      "Connect"
                    )}
                  </button>
                </div>
              </div>
            );
          })}

          {canCreate && (
            <button
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setOptimisticTags((current) => (
                  current.includes(trimmed) ? current : [...current, trimmed]
                ));
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
