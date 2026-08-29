import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MenuTextTrigger } from "@/components/MenuTextTrigger";
import { QuantizedMenuScrollArea } from "@/components/QuantizedMenuScrollArea";
import { SearchMenuAction } from "@/components/SearchMenuAction";
import { SearchMenuInput } from "@/components/SearchMenuInput";
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
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createNameError, setCreateNameError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const actionIdPrefix = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const topChromeTrigger = useTopChromeTriggerInteraction({
    deferPointerOpen: true,
    onPointerOpen: () => setOpen((current) => !current),
  });
  // The menu lines up with the trigger's label, not with its box, so the
  // offset has to equal the trigger's own horizontal padding. It is measured
  // from the trigger instead of restated as a number: the copy was 24 because
  // the padding once was, and it stayed behind the moment the chrome inset
  // stopped following the feed rhythm, leaving the menu 16px adrift.
  const [menuAlignOffset, setMenuAlignOffset] = useState(compact ? 12 : 24);
  useLayoutEffect(() => {
    if (!open) return;
    const node = topChromeTrigger.triggerProps.ref.current;
    if (!node) return;
    const padding = Number.parseFloat(getComputedStyle(node).paddingLeft);
    if (Number.isFinite(padding)) setMenuAlignOffset(padding);
  }, [compact, open, topChromeTrigger.triggerProps.ref]);
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

  const normalizedExistingCollections = useMemo(() => (
    new Set([
      normalizeChannelSearchText("Everything"),
      normalizeChannelSearchText("__all__"),
      ...orderedTags.flatMap((tag) => [
        normalizeChannelSearchText(tag.tag),
        normalizeChannelSearchText(collectionRefLabel(tag.tag)),
      ]),
    ])
  ), [orderedTags]);
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
    setCreateNameError(null);
    setCreateDialogOpen(true);
  }, [trimmedQuery]);

  const handleCreateSubmit = useCallback(async () => {
    if (creating) return;
    const nextName = createName.trim().replace(/\s+/g, " ");
    if (!nextName) {
      setCreateNameError("Enter a channel name");
      return;
    }
    if (normalizedExistingCollections.has(normalizeChannelSearchText(nextName))) {
      setCreateNameError("Channel already exists");
      return;
    }
    setCreating(true);
    try {
      await onCreateCollection(nextName);
      setCreateDialogOpen(false);
      setCreateName("");
      setCreateNameError(null);
      setQuery("");
    } catch (error) {
      console.error("Failed to create collection:", error);
      setCreateNameError("Could not create channel");
    } finally {
      setCreating(false);
    }
  }, [createName, creating, normalizedExistingCollections, onCreateCollection]);

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
        <DropdownMenuTrigger asChild>
          <MenuTextTrigger
            aria-label={`Switch collection: ${label}`}
            label={label}
            surface="topChrome"
            keyboardFocus={topChromeTrigger.keyboardFocus}
            data-top-collection-switcher=""
            {...topChromeTrigger.triggerProps}
            className={cn(
              "max-w-[50%]",
              // Label text = this padding + 8px inner pill padding; the alt
              // design keeps it flush with the grid's card edge (16px).
              compact ? "px-3" : "px-[var(--top-collection-pad-x)]",
            )}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          alignOffset={menuAlignOffset}
          side="bottom"
          sideOffset={4}
          widthRole="selector"
          onCloseAutoFocus={topChromeTrigger.handleCloseAutoFocus}
          className="overflow-hidden p-0"
          data-top-collection-menu=""
          data-top-collection-menu-align-offset={menuAlignOffset}
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
            innerClassName="p-1"
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
              <div className="flex h-[var(--menu-row-height)] items-center px-2 text-base text-muted-foreground">
                No collections
              </div>
            )}
          </QuantizedMenuScrollArea>
          <div className="border-t border-border p-1" data-top-collection-create="">
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

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreateSubmit();
            }}
          >
            <DialogHeader>
              <DialogTitle>Create collection</DialogTitle>
            </DialogHeader>
            <div className="grid gap-2">
              <Input
                aria-label="Channel name"
                autoFocus
                variant="default"
                value={createName}
                onChange={(event) => {
                  setCreateName(event.target.value);
                  setCreateNameError(null);
                }}
              />
              {createNameError && (
                <p role="alert" className="text-sm text-destructive">
                  {createNameError}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setCreateDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
