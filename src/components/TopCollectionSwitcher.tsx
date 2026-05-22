import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useTopChromeTriggerInteraction } from "@/hooks/useTopChromeTriggerInteraction";
import {
  filterAndRankChannelSearch,
  normalizeChannelSearchText,
} from "@/lib/channelSearch";
import { collectionRefLabel } from "@/lib/collections";
import { cn } from "@/lib/utils";
import type { TagCount } from "@/types";

type CollectionSwitcherItem = {
  key: string;
  label: string;
  tag?: string;
};

interface TopCollectionSwitcherProps {
  currentTag?: string;
  orderedTags: readonly TagCount[];
  compact?: boolean;
  onNavigate: (tag?: string) => void;
  onCreateCollection: (tag: string) => void | Promise<void>;
}

function currentCollectionLabel(currentTag?: string): string {
  return currentTag ? collectionRefLabel(currentTag) : "Everything";
}

function collectionKey(tag?: string): string {
  return tag ? `tag:${tag}` : "__all__";
}

export function TopCollectionSwitcher({
  currentTag,
  orderedTags,
  compact = false,
  onNavigate,
  onCreateCollection,
}: TopCollectionSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const topChromeTrigger = useTopChromeTriggerInteraction({
    deferPointerOpen: true,
    onPointerOpen: () => setOpen((current) => !current),
  });
  const currentKey = collectionKey(currentTag);
  const label = currentCollectionLabel(currentTag);
  const trimmedQuery = query.trim().replace(/\s+/g, " ");

  const items = useMemo<CollectionSwitcherItem[]>(() => {
    const allItems: CollectionSwitcherItem[] = [
      { key: "__all__", label: "Everything" },
      ...orderedTags.map((tag) => ({
        key: `tag:${tag.tag}`,
        label: collectionRefLabel(tag.tag),
        tag: tag.tag,
      })),
    ];
    return allItems.filter((item) => item.key !== currentKey);
  }, [currentKey, orderedTags]);

  const visibleItems = useMemo(() => (
    filterAndRankChannelSearch(
      items.map((item) => ({
        item,
        texts: item.tag ? [item.label, item.tag] : [item.label, "__all__", "all"],
      })),
      query,
    )
  ), [items, query]);

  const normalizedExistingItems = useMemo(() => (
    new Set([
      normalizeChannelSearchText("Everything"),
      normalizeChannelSearchText("__all__"),
      ...orderedTags.flatMap((tag) => [
        normalizeChannelSearchText(tag.tag),
        normalizeChannelSearchText(collectionRefLabel(tag.tag)),
      ]),
    ])
  ), [orderedTags]);
  const canCreate = trimmedQuery.length > 0
    && !normalizedExistingItems.has(normalizeChannelSearchText(trimmedQuery));

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
      searchInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
  }, []);

  const handleSelect = useCallback((item: CollectionSwitcherItem) => {
    setOpen(false);
    onNavigate(item.tag);
  }, [onNavigate]);

  const handleCreate = useCallback(async () => {
    if (!canCreate || creating) return;
    setCreating(true);
    try {
      await onCreateCollection(trimmedQuery);
      setOpen(false);
      setQuery("");
    } catch (error) {
      console.error("Failed to create collection:", error);
    } finally {
      setCreating(false);
    }
  }, [canCreate, creating, onCreateCollection, trimmedQuery]);

  const handleSearchKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (query) {
        setQuery("");
      } else {
        setOpen(false);
      }
      return;
    }

    if (event.key !== "Enter") return;
    const firstItem = visibleItems[0];
    if (!firstItem && canCreate) {
      event.preventDefault();
      event.stopPropagation();
      void handleCreate();
      return;
    }
    if (!firstItem) return;
    event.preventDefault();
    event.stopPropagation();
    handleSelect(firstItem);
  }, [canCreate, handleCreate, handleSelect, query, visibleItems]);

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Switch collection: ${label}`}
          data-top-collection-switcher=""
          {...topChromeTrigger.triggerProps}
          className={cn(
            "group inline-flex h-full min-w-0 max-w-[50%] flex-none cursor-pointer items-center overflow-hidden rounded-0 bg-transparent text-base text-foreground outline-0",
            compact ? "px-3" : "px-6",
          )}
        >
          <span
            className={cn(
              "inline-flex h-6 min-w-0 max-w-full items-center rounded-1 px-2 text-foreground group-hover:bg-active group-data-[state=open]:bg-active",
              topChromeTrigger.keyboardFocus && "bg-active",
            )}
          >
            <span className="min-w-0 truncate text-left">
              {label}
            </span>
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={4}
        widthRole="selector"
        onCloseAutoFocus={topChromeTrigger.handleCloseAutoFocus}
        className="overflow-hidden p-0"
      >
        <div className="border-b border-border p-1">
          <Input
            ref={searchInputRef}
            aria-label="Search collections"
            placeholder="Search collections..."
            variant="ghost"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            className="h-8 rounded-0 px-2 py-0 hover:placeholder:text-muted-foreground focus:placeholder:text-muted-foreground"
            data-top-collection-search=""
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1" data-top-collection-list="">
          {visibleItems.length > 0 ? (
            visibleItems.map((item) => (
              <DropdownMenuItem
                key={item.key}
                onSelect={() => handleSelect(item)}
              >
                <span className="min-w-0 truncate">
                  {item.label}
                </span>
              </DropdownMenuItem>
            ))
          ) : (
            <div className="px-2 py-1.5 text-base text-muted-foreground">
              No collections
            </div>
          )}
        </div>
        <div className="border-t border-border p-1" data-top-collection-create="">
          <DropdownMenuItem
            disabled={!canCreate || creating}
            onSelect={(event) => {
              event.preventDefault();
              void handleCreate();
            }}
          >
            <span className="min-w-0 truncate">
              {trimmedQuery ? `Create "${trimmedQuery}"` : "Create New Channel"}
            </span>
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
