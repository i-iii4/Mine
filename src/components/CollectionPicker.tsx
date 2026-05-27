import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Plus } from "lucide-react";
import { QuantizedMenuScrollArea } from "@/components/QuantizedMenuScrollArea";
import { SearchMenuInput } from "@/components/SearchMenuInput";
import type { TagCount } from "@/types";
import { collectionRefLabel } from "@/lib/collections";
import { cn } from "@/lib/utils";

interface CollectionPickerProps {
  blockSlug: string;
  selectedTags: string[];
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void | Promise<void>;
  onCreateAndAssign: (tag: string, blockSlug: string) => void | Promise<void>;
  /** Prevent parent menu typeahead from capturing keystrokes */
  stopKeyPropagation?: boolean;
  onRequestClose?: () => void;
  autoFocusSearch?: boolean;
  layout?: "menu" | "edge";
  className?: string;
}

interface BatchCollectionPickerProps {
  selectedSlugs: string[];
  tags: TagCount[];
  tagLookup: ReadonlyMap<string, readonly string[]>;
  onBatchSetTag: (slugs: string[], tag: string, connected: boolean) => void | Promise<void>;
  onCreateAndAssign: (tag: string) => void | Promise<void>;
  onRequestClose?: () => void;
}

type BatchMembershipState = "all" | "not-all";

export const COLLECTION_PICKER_CONTENT_CLASS =
  "flex flex-col overflow-hidden p-0";

export const COLLECTION_PICKER_INLINE_SURFACE_CLASS =
  "bg-popover text-popover-foreground flex flex-col overflow-hidden rounded-1 border p-0 shadow-md";

function isPrintableKeyboardKey(event: ReactKeyboardEvent): boolean {
  return event.key.length === 1 && !event.metaKey && !event.altKey && !event.ctrlKey;
}

function applyPendingMembership(
  selectedTags: readonly string[],
  pendingStates: ReadonlyMap<string, boolean>,
): string[] {
  if (pendingStates.size === 0) return [...selectedTags];
  const next = new Set(selectedTags);
  for (const [tag, connected] of pendingStates) {
    if (connected) {
      next.add(tag);
    } else {
      next.delete(tag);
    }
  }
  return [...next];
}

function batchMembershipState(
  selectedSlugs: readonly string[],
  tagLookup: ReadonlyMap<string, readonly string[]>,
  pendingStates: ReadonlyMap<string, boolean>,
  tag: string,
): BatchMembershipState {
  const pendingConnected = pendingStates.get(tag);
  if (pendingConnected !== undefined) return pendingConnected ? "all" : "not-all";

  for (const slug of selectedSlugs) {
    if (!tagLookup.get(slug)?.includes(tag)) {
      return "not-all";
    }
  }
  return "all";
}

function closeKeyForSubmenuSide(side: string | null): string | null {
  if (side === "right") return "ArrowLeft";
  if (side === "left") return "ArrowRight";
  if (side === "bottom") return "ArrowUp";
  if (side === "top") return "ArrowDown";
  return null;
}

type MembershipInteractionMode = "keyboard" | "pointer";
type PointerPosition = {
  x: number;
  y: number;
  pointerId: number;
};

function pointerPosition(event: ReactPointerEvent): PointerPosition {
  return {
    x: event.clientX,
    y: event.clientY,
    pointerId: event.pointerId,
  };
}

function isSamePointerPosition(
  first: PointerPosition | null,
  second: PointerPosition,
): boolean {
  return (
    first !== null &&
    first.pointerId === second.pointerId &&
    first.x === second.x &&
    first.y === second.y
  );
}

/**
 * Reusable tag picker UI: search + connection action list + create.
 * Used in both ContextMenu and DropdownMenu.
 */
export function CollectionPicker({
  blockSlug,
  selectedTags,
  tags,
  onToggleTag,
  onCreateAndAssign,
  stopKeyPropagation = false,
  onRequestClose,
  autoFocusSearch = true,
  layout = "menu",
  className,
}: CollectionPickerProps) {
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [interactionMode, setInteractionMode] = useState<MembershipInteractionMode>("keyboard");
  const [pendingMembership, setPendingMembership] = useState<{
    blockSlug: string;
    states: Map<string, boolean>;
  }>(() => ({ blockSlug, states: new Map() }));
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const lastPointerPositionRef = useRef<PointerPosition | null>(null);
  const blockedPointerPositionRef = useRef<PointerPosition | null>(null);
  const selectedTagsKey = selectedTags.join("\0");
  const pendingStates = pendingMembership.blockSlug === blockSlug
    ? pendingMembership.states
    : new Map<string, boolean>();
  const optimisticTags = useMemo(
    () => applyPendingMembership(selectedTags, pendingStates),
    [pendingStates, selectedTags, selectedTagsKey],
  );

  useEffect(() => {
    setPendingMembership((current) => (
      current.blockSlug === blockSlug ? current : { blockSlug, states: new Map() }
    ));
  }, [blockSlug]);

  useEffect(() => {
    setPendingMembership((current) => {
      if (current.blockSlug !== blockSlug || current.states.size === 0) return current;
      let changed = false;
      const nextStates = new Map(current.states);
      for (const [tag, connected] of current.states) {
        if (selectedTags.includes(tag) === connected) {
          nextStates.delete(tag);
          changed = true;
        }
      }
      return changed ? { blockSlug, states: nextStates } : current;
    });
  }, [blockSlug, selectedTags, selectedTagsKey]);

  const lc = search.toLowerCase();
  const filtered = lc
    ? tags.filter((tc) => collectionRefLabel(tc.tag).toLowerCase().includes(lc))
    : tags;

  const trimmed = search.trim();
  const canCreate = trimmed.length > 0 && filtered.length === 0;
  const createActionIndex = filtered.length;
  const actionCount = filtered.length + (canCreate ? 1 : 0);
  const boundedActiveIndex =
    actionCount > 0 ? Math.min(activeIndex, actionCount - 1) : -1;
  const activeTag = boundedActiveIndex >= 0 && boundedActiveIndex < filtered.length
    ? filtered[boundedActiveIndex]
    : null;
  const createActive = canCreate && boundedActiveIndex === createActionIndex;
  const rowSize = layout === "edge" ? "clipper" : "default";
  const listPadding = layout === "edge" ? "default" : "compact";
  const listRowCount = Math.max(actionCount, 1);

  useEffect(() => {
    setActiveIndex(0);
  }, [search]);

  useEffect(() => {
    if (actionCount === 0 && activeIndex !== 0) {
      setActiveIndex(0);
    } else if (actionCount > 0 && activeIndex > actionCount - 1) {
      setActiveIndex(actionCount - 1);
    }
  }, [activeIndex, actionCount]);

  useEffect(() => {
    if (interactionMode !== "keyboard" || boundedActiveIndex < 0) return;
    const tag = activeTag?.tag;
    if (!tag) return;
    rowRefs.current.get(tag)?.scrollIntoView?.({ block: "nearest" });
  }, [activeTag, boundedActiveIndex, interactionMode]);

  const toggleTag = (tag: string, hasTag: boolean) => {
    const nextConnected = !hasTag;
    setPendingMembership((current) => {
      const states = current.blockSlug === blockSlug
        ? new Map(current.states)
        : new Map<string, boolean>();
      states.set(tag, nextConnected);
      return { blockSlug, states };
    });
    void onToggleTag(blockSlug, tag, hasTag);
  };

  const createAndAssign = () => {
    if (!canCreate) return;
    setPendingMembership((current) => {
      const states = current.blockSlug === blockSlug
        ? new Map(current.states)
        : new Map<string, boolean>();
      states.set(trimmed, true);
      return { blockSlug, states };
    });
    void onCreateAndAssign(trimmed, blockSlug);
    setSearch("");
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (onRequestClose) {
        event.preventDefault();
        event.stopPropagation();
        onRequestClose();
      }
      return;
    }

    const submenuCloseKey = closeKeyForSubmenuSide(
      event.currentTarget
        .closest("[data-slot='dropdown-menu-sub-content']")
        ?.getAttribute("data-side") ?? null,
    );
    if (onRequestClose && event.key === submenuCloseKey) {
      event.preventDefault();
      event.stopPropagation();
      onRequestClose();
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (actionCount > 0) {
        event.preventDefault();
        event.stopPropagation();
        blockedPointerPositionRef.current = lastPointerPositionRef.current;
        setInteractionMode("keyboard");
        setActiveIndex((current) => {
          const start = Math.min(current, actionCount - 1);
          if (event.key === "ArrowDown") {
            return (start + 1) % actionCount;
          }
          return (start - 1 + actionCount) % actionCount;
        });
      } else if (stopKeyPropagation) {
        event.stopPropagation();
      }
      return;
    }

    if (event.key === "Enter") {
      if (activeTag) {
        event.preventDefault();
        event.stopPropagation();
        toggleTag(activeTag.tag, optimisticTags.includes(activeTag.tag));
      } else if (createActive) {
        event.preventDefault();
        event.stopPropagation();
        createAndAssign();
      } else if (stopKeyPropagation) {
        event.stopPropagation();
      }
      return;
    }

    if (isPrintableKeyboardKey(event) && event.target !== inputRef.current) {
      event.preventDefault();
      event.stopPropagation();
      setSearch((current) => `${current}${event.key}`);
      inputRef.current?.focus();
      return;
    }

    if (stopKeyPropagation) {
      event.stopPropagation();
    }
  };

  const handleRowPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
    rowIndex: number,
  ) => {
    const nextPointerPosition = pointerPosition(event);
    const blockedPointerPosition = blockedPointerPositionRef.current;
    lastPointerPositionRef.current = nextPointerPosition;

    if (isSamePointerPosition(blockedPointerPosition, nextPointerPosition)) {
      return;
    }

    blockedPointerPositionRef.current = null;
    if (boundedActiveIndex === rowIndex && interactionMode === "pointer") return;
    setInteractionMode("pointer");
    setActiveIndex(rowIndex);
  };

  const handleCreatePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!canCreate) return;
    const nextPointerPosition = pointerPosition(event);
    const blockedPointerPosition = blockedPointerPositionRef.current;
    lastPointerPositionRef.current = nextPointerPosition;

    if (isSamePointerPosition(blockedPointerPosition, nextPointerPosition)) {
      return;
    }

    blockedPointerPositionRef.current = null;
    if (createActive && interactionMode === "pointer") return;
    setInteractionMode("pointer");
    setActiveIndex(createActionIndex);
  };

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col", className)}
      data-collection-picker=""
      onKeyDownCapture={handleKeyDown}
    >
      <SearchMenuInput
        ref={inputRef}
        autoFocus={autoFocusSearch}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search channels..."
        controlSize={layout === "edge" ? "clipper" : "default"}
        inputClassName={layout === "edge" ? "px-3" : undefined}
      />

      {/* Tag list */}
      <QuantizedMenuScrollArea
        rowCount={listRowCount}
        rowSize={rowSize}
        paddingY={listPadding}
        className="min-h-0 flex-1"
        innerClassName={cn(layout === "edge" ? "p-1" : "px-1 py-0.5")}
      >
        {filtered.map((tc, rowIndex) => {
          const hasTag = optimisticTags.includes(tc.tag);
          const isActive = rowIndex === boundedActiveIndex;
          const actionLabel = hasTag ? "Disconnect" : "Connect";
          const buttonVisible = hasTag || isActive;
          const title = collectionRefLabel(tc.tag);
          return (
            <div
              key={tc.tag}
              ref={(node) => {
                if (node) {
                  rowRefs.current.set(tc.tag, node);
                } else {
                  rowRefs.current.delete(tc.tag);
                }
              }}
              className={cn(
                "flex h-[var(--menu-row-height)] w-full items-center gap-2 rounded-1 px-2 text-base",
                isActive && "bg-active",
              )}
              data-collection-picker-row=""
              data-collection-picker-row-active={isActive ? "true" : undefined}
              data-collection-picker-interaction-mode={isActive ? interactionMode : undefined}
              onPointerMove={(event) => handleRowPointerMove(event, rowIndex)}
            >
              <span className="flex-1 truncate text-left text-foreground">
                {title}
              </span>
              <div className="relative flex h-6 w-[10ch] shrink-0 items-center justify-end">
                <span
                  className={cn(
                    "absolute right-0 text-sm text-muted-foreground",
                    buttonVisible ? "opacity-0" : "opacity-100",
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
                    "absolute right-0 inline-flex h-6 w-[10ch] cursor-pointer items-center justify-center rounded-1 bg-component-fill px-[1ch] font-sans text-sm font-semibold text-foreground outline-0 outline-transparent hover:outline-1 hover:-outline-offset-1 hover:outline-component-fill-hover focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-component-fill-hover",
                    buttonVisible ? "opacity-100" : "pointer-events-none opacity-0",
                    hasTag && isActive && "text-destructive",
                  )}
                  aria-label={`${actionLabel} ${title}`}
                >
                  {hasTag ? (isActive ? "Disconnect" : "Connected") : "Connect"}
                </button>
              </div>
            </div>
          );
        })}

        {canCreate && (
          <button
            type="button"
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onPointerMove={handleCreatePointerMove}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              createAndAssign();
            }}
            className={cn(
              "flex h-[var(--menu-row-height)] w-full items-center gap-2 rounded-1 px-2 text-base font-semibold text-foreground hover:bg-active",
              createActive && "bg-active",
            )}
            data-collection-picker-create=""
            data-collection-picker-create-active={createActive ? "true" : undefined}
          >
            <Plus className="size-4 shrink-0" />
            <span>
              Create &ldquo;{trimmed}&rdquo;
            </span>
          </button>
        )}

        {filtered.length === 0 && !canCreate && (
          <p className="flex h-[var(--menu-row-height)] items-center justify-center px-2 text-sm text-muted-foreground">
            No channels
          </p>
        )}
      </QuantizedMenuScrollArea>
    </div>
  );
}

export function BatchCollectionPicker({
  selectedSlugs,
  tags,
  tagLookup,
  onBatchSetTag,
  onCreateAndAssign,
  onRequestClose,
}: BatchCollectionPickerProps) {
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [interactionMode, setInteractionMode] = useState<MembershipInteractionMode>("keyboard");
  const [pendingStates, setPendingStates] = useState<Map<string, boolean>>(() => new Map());
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const lastPointerPositionRef = useRef<PointerPosition | null>(null);
  const blockedPointerPositionRef = useRef<PointerPosition | null>(null);

  const lc = search.toLowerCase();
  const filtered = lc
    ? tags.filter((tc) => collectionRefLabel(tc.tag).toLowerCase().includes(lc))
    : tags;
  const trimmed = search.trim();
  const canCreate = trimmed.length > 0 && filtered.length === 0;
  const createActionIndex = filtered.length;
  const actionCount = filtered.length + (canCreate ? 1 : 0);
  const boundedActiveIndex =
    actionCount > 0 ? Math.min(activeIndex, actionCount - 1) : -1;
  const activeTag = boundedActiveIndex >= 0 && boundedActiveIndex < filtered.length
    ? filtered[boundedActiveIndex]
    : null;
  const createActive = canCreate && boundedActiveIndex === createActionIndex;
  const listRowCount = Math.max(actionCount, 1);

  useEffect(() => {
    setActiveIndex(0);
  }, [search]);

  useEffect(() => {
    if (actionCount === 0 && activeIndex !== 0) {
      setActiveIndex(0);
    } else if (actionCount > 0 && activeIndex > actionCount - 1) {
      setActiveIndex(actionCount - 1);
    }
  }, [activeIndex, actionCount]);

  useEffect(() => {
    if (interactionMode !== "keyboard" || boundedActiveIndex < 0) return;
    const tag = activeTag?.tag;
    if (!tag) return;
    rowRefs.current.get(tag)?.scrollIntoView?.({ block: "nearest" });
  }, [activeTag, boundedActiveIndex, interactionMode]);

  const toggleTag = (tag: string) => {
    const membership = batchMembershipState(selectedSlugs, tagLookup, pendingStates, tag);
    const nextConnected = membership !== "all";
    setPendingStates((current) => {
      const next = new Map(current);
      next.set(tag, nextConnected);
      return next;
    });
    void onBatchSetTag(selectedSlugs, tag, nextConnected);
  };

  const createAndAssign = () => {
    if (!canCreate) return;
    setPendingStates((current) => {
      const next = new Map(current);
      next.set(trimmed, true);
      return next;
    });
    void onCreateAndAssign(trimmed);
    setSearch("");
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (onRequestClose) {
        event.preventDefault();
        event.stopPropagation();
        onRequestClose();
      }
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (actionCount > 0) {
        event.preventDefault();
        event.stopPropagation();
        blockedPointerPositionRef.current = lastPointerPositionRef.current;
        setInteractionMode("keyboard");
        setActiveIndex((current) => {
          const start = Math.min(current, actionCount - 1);
          if (event.key === "ArrowDown") return (start + 1) % actionCount;
          return (start - 1 + actionCount) % actionCount;
        });
      }
      return;
    }

    if (event.key === "Enter") {
      if (activeTag) {
        event.preventDefault();
        event.stopPropagation();
        toggleTag(activeTag.tag);
      } else if (createActive) {
        event.preventDefault();
        event.stopPropagation();
        createAndAssign();
      }
      return;
    }

    if (isPrintableKeyboardKey(event) && event.target !== inputRef.current) {
      event.preventDefault();
      event.stopPropagation();
      setSearch((current) => `${current}${event.key}`);
      inputRef.current?.focus();
      return;
    }

    event.stopPropagation();
  };

  const handleRowPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
    rowIndex: number,
  ) => {
    const nextPointerPosition = pointerPosition(event);
    const blockedPointerPosition = blockedPointerPositionRef.current;
    lastPointerPositionRef.current = nextPointerPosition;

    if (isSamePointerPosition(blockedPointerPosition, nextPointerPosition)) {
      return;
    }

    blockedPointerPositionRef.current = null;
    if (boundedActiveIndex === rowIndex && interactionMode === "pointer") return;
    setInteractionMode("pointer");
    setActiveIndex(rowIndex);
  };

  const handleCreatePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!canCreate) return;
    const nextPointerPosition = pointerPosition(event);
    const blockedPointerPosition = blockedPointerPositionRef.current;
    lastPointerPositionRef.current = nextPointerPosition;

    if (isSamePointerPosition(blockedPointerPosition, nextPointerPosition)) {
      return;
    }

    blockedPointerPositionRef.current = null;
    if (createActive && interactionMode === "pointer") return;
    setInteractionMode("pointer");
    setActiveIndex(createActionIndex);
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-batch-collection-picker=""
      data-collection-picker=""
      onKeyDownCapture={handleKeyDown}
    >
      <SearchMenuInput
        ref={inputRef}
        autoFocus
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search channels..."
      />

      <QuantizedMenuScrollArea
        rowCount={listRowCount}
        paddingY="compact"
        className="min-h-0 flex-1"
        innerClassName="px-1 py-0.5"
      >
        {filtered.map((tc, rowIndex) => {
          const membership = batchMembershipState(selectedSlugs, tagLookup, pendingStates, tc.tag);
          const isActive = rowIndex === boundedActiveIndex;
          const actionLabel = membership === "all" ? "Disconnect" : "Connect";
          const buttonVisible = membership === "all" || isActive;
          const title = collectionRefLabel(tc.tag);

          return (
            <div
              key={tc.tag}
              ref={(node) => {
                if (node) {
                  rowRefs.current.set(tc.tag, node);
                } else {
                  rowRefs.current.delete(tc.tag);
                }
              }}
              className={cn(
                "flex h-[var(--menu-row-height)] w-full items-center gap-2 rounded-1 px-2 text-base",
                isActive && "bg-active",
              )}
              data-batch-collection-row=""
              data-batch-collection-row-state={membership}
              data-collection-picker-row=""
              data-collection-picker-row-active={isActive ? "true" : undefined}
              data-collection-picker-interaction-mode={isActive ? interactionMode : undefined}
              onPointerMove={(event) => handleRowPointerMove(event, rowIndex)}
            >
              <span className="flex-1 truncate text-left text-foreground">
                {title}
              </span>
              <div className="relative flex h-6 w-[10ch] shrink-0 items-center justify-end">
                <span
                  className={cn(
                    "absolute right-0 text-sm text-muted-foreground",
                    buttonVisible ? "opacity-0" : "opacity-100",
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
                    toggleTag(tc.tag);
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                  }}
                  className={cn(
                    "absolute right-0 inline-flex h-6 w-[10ch] cursor-pointer items-center justify-center rounded-1 bg-component-fill px-[1ch] font-sans text-sm font-semibold text-foreground outline-0 outline-transparent hover:outline-1 hover:-outline-offset-1 hover:outline-component-fill-hover focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-component-fill-hover",
                    buttonVisible ? "opacity-100" : "pointer-events-none opacity-0",
                    membership === "all" && isActive && "text-destructive",
                  )}
                  aria-label={`${actionLabel} ${title}`}
                >
                  {membership === "all" ? (isActive ? "Disconnect" : "Connected") : "Connect"}
                </button>
              </div>
            </div>
          );
        })}

        {canCreate && (
          <button
            type="button"
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onPointerMove={handleCreatePointerMove}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              createAndAssign();
            }}
            className={cn(
              "flex h-[var(--menu-row-height)] w-full items-center gap-2 rounded-1 px-2 text-base font-semibold text-foreground hover:bg-active",
              createActive && "bg-active",
            )}
            data-collection-picker-create=""
            data-collection-picker-create-active={createActive ? "true" : undefined}
          >
            <Plus className="size-4 shrink-0" />
            <span>
              Create &ldquo;{trimmed}&rdquo;
            </span>
          </button>
        )}

        {filtered.length === 0 && !canCreate && (
          <p className="flex h-[var(--menu-row-height)] items-center justify-center px-2 text-sm text-muted-foreground">
            No channels
          </p>
        )}
      </QuantizedMenuScrollArea>
    </div>
  );
}
