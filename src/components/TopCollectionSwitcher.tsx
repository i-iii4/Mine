import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CreateCollectionDialog } from "@/components/CreateCollectionDialog";
import type { CollectionNameCheck } from "@/hooks/useCollectionNameRefusal";
import { MenuTextTrigger } from "@/components/MenuTextTrigger";
import { QuantizedMenuScrollArea } from "@/components/QuantizedMenuScrollArea";
import { SearchMenuAction } from "@/components/SearchMenuAction";
import { SearchMenuInput } from "@/components/SearchMenuInput";
import { useTopChromeTriggerInteraction } from "@/hooks/useTopChromeTriggerInteraction";
import { filterAndRankChannelSearch } from "@/lib/channelSearch";
import { collectionRefLabel } from "@/lib/collections";
import { cn } from "@/lib/utils";
import type { TagCount } from "@/types";

type CollectionSwitcherItem = {
  key: string;
  label: string;
  tag?: string;
};

interface TopCollectionSwitcherProps {
  /// False while an open card's name stands in its place (topRowPath.ts):
  /// the switcher fades out where it stands and back in, and nothing of it
  /// answers meanwhile (global.css, «The top rows' motion»).
  shown?: boolean;
  /// Out of the row's flow, at its start: the card's name has the place's
  /// room while the switcher fades.
  overlay?: boolean;
  currentTag?: string;
  /// The author whose cards the feed shows, as written on the card the
  /// person came from: the path names it, and no listed place is current
  /// (SPEC_CARD_ASSOCIATIONS.md, «Лента автора»).
  currentAuthor?: string;
  orderedTags: readonly TagCount[];
  onNavigate: (tag?: string) => void;
  /** Makes the collection the window named; a refusal rejects, and the
   *  window shows why (SPEC_DEEP_AUDIT.md, Е6.2). */
  onCreateCollection: (tag: string) => Promise<unknown>;
  /** The check of a new collection's name as it is typed. */
  onCheckCollectionName?: CollectionNameCheck;
  /// The path goes on after it with no padding of its own: an open card's
  /// name stands past a line the half over the feed draws, the feed's own
  /// controls at the far right. Outer padding stands only toward a boundary,
  /// a line or the end of the row; the line before it is always there.
  joinsNext?: boolean;
}

function currentPlaceLabel(currentTag?: string, currentAuthor?: string): string {
  if (currentAuthor !== undefined) return currentAuthor;
  return currentTag ? collectionRefLabel(currentTag) : "Everything";
}

function currentPlaceKey(currentTag?: string, currentAuthor?: string): string {
  if (currentAuthor !== undefined) return `author:${currentAuthor}`;
  return currentTag ? `tag:${currentTag}` : "__all__";
}

export function TopCollectionSwitcher({
  currentTag,
  currentAuthor,
  orderedTags,
  onNavigate,
  onCreateCollection,
  onCheckCollectionName,
  joinsNext = false,
  shown = true,
  overlay = false,
}: TopCollectionSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const actionIdPrefix = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const topChromeTrigger = useTopChromeTriggerInteraction({
    deferPointerOpen: true,
    onPointerOpen: () => setOpen((current) => !current),
  });
  const currentKey = currentPlaceKey(currentTag, currentAuthor);
  const label = currentPlaceLabel(currentTag, currentAuthor);
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

  const actionCount = visibleItems.length + 1;
  const createActionIndex = visibleItems.length;
  const activeActionId = activeIndex === null
    ? undefined
    : `${actionIdPrefix}-collection-action-${activeIndex}`;

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(null);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
      searchInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    setActiveIndex((current) => {
      if (current === null) return current;
      if (current < actionCount) return current;
      return actionCount > 0 ? actionCount - 1 : null;
    });
  }, [actionCount]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
  }, []);

  const handleSelect = useCallback((item: CollectionSwitcherItem) => {
    setOpen(false);
    onNavigate(item.tag);
  }, [onNavigate]);

  const restoreSearchFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
    });
  }, []);

  const openCreateDialog = useCallback(() => {
    setOpen(false);
    setActiveIndex(null);
    setCreateName(trimmedQuery);
    setCreateDialogOpen(true);
  }, [trimmedQuery]);

  const moveActiveIndex = useCallback((direction: 1 | -1) => {
    if (actionCount <= 0) return;
    setActiveIndex((current) => {
      if (current === null) {
        return direction > 0 ? 0 : actionCount - 1;
      }
      const nextIndex = current + direction;
      if (nextIndex < 0) return 0;
      if (nextIndex >= actionCount) return actionCount - 1;
      return nextIndex;
    });
  }, [actionCount]);

  const activateIndex = useCallback((index: number | null) => {
    if (index === null) return;
    const item = visibleItems[index];
    if (item) {
      handleSelect(item);
      return;
    }
    if (index === createActionIndex) {
      openCreateDialog();
    }
  }, [createActionIndex, handleSelect, openCreateDialog, visibleItems]);

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

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      moveActiveIndex(event.key === "ArrowDown" ? 1 : -1);
      restoreSearchFocus();
      return;
    }

    if (event.key !== "Enter") return;
    if (activeIndex === null) return;
    event.preventDefault();
    event.stopPropagation();
    activateIndex(activeIndex);
  }, [activateIndex, activeIndex, moveActiveIndex, query, restoreSearchFocus]);

  return (
    <>
      <DropdownMenu open={open} onOpenChange={handleOpenChange}>
        <div
          className={cn(
            "flex h-full min-w-0 max-w-[50%] shrink-0",
            overlay && "absolute inset-y-0 left-0",
          )}
          data-top-collection-switcher-slot=""
          data-top-row-fade=""
          data-entered={shown ? "true" : "false"}
          inert={!shown}
          aria-hidden={shown ? undefined : true}
        >
        <DropdownMenuTrigger asChild>
          <MenuTextTrigger
            aria-label={`Switch collection: ${label}`}
            label={label}
            surface="topChrome"
            showChevron
            keyboardFocus={topChromeTrigger.keyboardFocus}
            data-top-collection-switcher=""
            {...topChromeTrigger.triggerProps}
            className={cn(
              "max-w-full",
              // Label text = this padding + 8px inner pill padding: 16 px
              // from the line before it, the sidebar open or collapsed
              // (11.10.2026), like the space switcher's from the window edge.
              "pl-[var(--top-collection-pad-x)]",
              joinsNext ? "pr-0" : "pr-[var(--top-collection-pad-x)]",
            )}
          />
        </DropdownMenuTrigger>
        </div>
        <DropdownMenuContent
          align="start"
          side="bottom"
          widthRole="search"
          onCloseAutoFocus={topChromeTrigger.handleCloseAutoFocus}
          className="overflow-hidden p-0"
          data-top-collection-menu=""
        >
          <SearchMenuInput
            ref={searchInputRef}
            aria-label="Search collections"
            aria-activedescendant={activeActionId}
            placeholder="Search collections..."
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(null);
            }}
            onKeyDown={handleSearchKeyDown}
            data-top-collection-search=""
          />
          <QuantizedMenuScrollArea
            rowCount={Math.max(visibleItems.length, 1)}
            maxRows={8}
            innerClassName="p-surface"
          >
            {visibleItems.length > 0 ? (
              visibleItems.map((item, index) => (
                <SearchMenuAction
                  id={`${actionIdPrefix}-collection-action-${index}`}
                  key={item.key}
                  active={activeIndex === index}
                  onActive={() => setActiveIndex(index)}
                  onPress={() => handleSelect(item)}
                >
                  <span className="min-w-0 truncate">
                    {item.label}
                  </span>
                </SearchMenuAction>
              ))
            ) : (
              <div className="flex h-[var(--menu-row-height)] items-center px-plate text-base text-muted-foreground">
                No collections
              </div>
            )}
          </QuantizedMenuScrollArea>
          <div className="border-t border-border p-surface" data-top-collection-create="">
            <SearchMenuAction
              id={`${actionIdPrefix}-collection-action-${createActionIndex}`}
              active={activeIndex === createActionIndex}
              onActive={() => setActiveIndex(createActionIndex)}
              onPress={openCreateDialog}
            >
              <span className="min-w-0 truncate">
                Create collection
              </span>
            </SearchMenuAction>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateCollectionDialog
        open={createDialogOpen}
        initialName={createName}
        onOpenChange={setCreateDialogOpen}
        onCheckName={onCheckCollectionName}
        onCreate={async (name) => {
          await onCreateCollection(name);
          setQuery("");
        }}
      />
    </>
  );
}
