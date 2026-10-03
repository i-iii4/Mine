import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { MoreHorizontal, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuIconSlot } from "@/components/ui/menu-icon-slot";
import {
  addKnownVault,
  forgetKnownVault,
  listSpaces,
  reorderKnownVaults,
  showSpace,
  spacesInTabs,
  spaceStats,
} from "@/lib/commands";
import { formatBytes } from "@/lib/formatBytes";
import { cn } from "@/lib/utils";
import type { SpaceEntry, SpaceMovedPayload, SpaceStats } from "@/types";
import { basename } from "./useOpenSpaces";

type SpaceStatsState = SpaceStats | "error";

// Pure reorder step for a drag-end: null when the drop changes nothing.
// Exported for tests — dnd-kit gestures are not reproducible in jsdom.
export function reorderedPaths(
  paths: string[],
  activeId: string,
  overId: string,
): string[] | null {
  if (activeId === overId) return null;
  const oldIndex = paths.indexOf(activeId);
  const newIndex = paths.indexOf(overId);
  if (oldIndex < 0 || newIndex < 0) return null;
  return arrayMove(paths, oldIndex, newIndex);
}

// Metric order goes from the product entity to the disk: elements (the thing
// Mine is about) → markdown → media → files → size as the closing total.
// Bare numbers — the project's counter language (Р-5, SPEC_SETTINGS_WINDOW.md).
function statsSummary(stats: SpaceStatsState | undefined): string {
  if (stats === undefined) return "…";
  if (stats === "error") return "—";
  const elements = stats.element_count === null ? "—" : String(stats.element_count);
  return `${elements} elements · ${stats.markdown_count} markdown · ${stats.media_count} media · ${stats.file_count} files · ${formatBytes(stats.total_bytes)}`;
}

interface SpaceRowProps {
  path: string;
  /// Some tab shows this space (SPEC_TABS.md, В69); several rows may be.
  isOpen: boolean;
  stats: SpaceStatsState | undefined;
  /// The folder is there and is this space; an unavailable space stays
  /// listed and marked (SPEC_VAULT_LIFECYCLE.md, П26) but cannot be opened.
  available: boolean;
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
}

function SpaceRow({ path, isOpen, stats, available, onOpen, onRemove }: SpaceRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } =
    useSortable({ id: path });

  return (
    <li
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group/space rounded-1 border border-border px-3 py-2",
        isOpen ? "bg-active" : "bg-accent hover:bg-active",
        isDragging && "opacity-30",
      )}
      aria-disabled={available ? undefined : "true"}
      data-space-row=""
      data-space-open={isOpen ? "" : undefined}
      data-space-row-unavailable={available ? undefined : ""}
      onClick={(event) => {
        // dnd-kit prevents the click that follows a completed drag.
        if (event.defaultPrevented || !available) return;
        onOpen(path);
      }}
      onKeyDown={(event) => {
        if (available && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onOpen(path);
        }
      }}
    >
      <div className="flex items-center gap-s2">
        <p className={cn("min-w-0 flex-1 truncate text-base", !available && "text-muted-foreground")}>
          {basename(path)}
          {/* The background says it to the eye (Р-12); this says it aloud. */}
          {isOpen && <span className="sr-only">, open in a tab</span>}
        </p>
        {/* Fixed-size slot: ⋯ fades in on hover/focus, geometry never jumps
            (opacity canon of card hover actions). Clicks must not bubble into
            the row's open action. */}
        <div
          className="flex size-8 shrink-0 items-center justify-center"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Space actions for ${basename(path)}`}
                className={cn(
                  menuOpen
                    ? "opacity-100"
                    : "opacity-0 group-hover/space:opacity-100 group-focus-within/space:opacity-100",
                )}
              >
                <MoreHorizontal className="size-[13px]" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="detach" onSelect={() => onRemove(path)}>
                <MenuIconSlot>
                  <Unlink className="size-[13px]" />
                </MenuIconSlot>
                <span className="flex flex-col">
                  <span>Remove Space</span>
                  <span className="text-sm text-muted-foreground">Files stay on disk</span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <p className="truncate text-sm text-muted-foreground">{path}</p>
      <p className="text-sm text-muted-foreground" data-space-summary="">
        {available
          ? statsSummary(stats)
          : "Folder unavailable: renamed, moved or on a disconnected drive"}
      </p>
    </li>
  );
}

export function SpacesSection() {
  const [knownVaults, setKnownVaults] = useState<string[]>([]);
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(() => new Set());
  // The identity of each listed space, to match rows against the open set.
  const [idByPath, setIdByPath] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Identities of the spaces some tab shows (SPEC_TABS.md, В69).
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [statsByPath, setStatsByPath] = useState<Record<string, SpaceStatsState>>({});
  const [error, setError] = useState<string | null>(null);
  // Paths already scanned: refreshing the list does not walk them again.
  const statsRequested = useRef(new Set<string>());

  const sensors = useSensors(
    // distance 8 keeps plain clicks as opens; only a real drag reorders.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  // Per-row async stats (Р-4): the path list renders instantly from config,
  // a slow volume degrades only its own row.
  const loadStats = useCallback((paths: string[]) => {
    for (const path of paths) {
      if (statsRequested.current.has(path)) continue;
      statsRequested.current.add(path);
      void spaceStats(path)
        .then((stats) => {
          setStatsByPath((previous) => ({ ...previous, [path]: stats }));
        })
        .catch(() => {
          setStatsByPath((previous) => ({ ...previous, [path]: "error" }));
        });
    }
  }, []);

  const applySpaces = useCallback(
    (spaces: SpaceEntry[]) => {
      setKnownVaults(spaces.map((space) => space.path));
      setUnavailable(new Set(spaces.filter((space) => !space.available).map((space) => space.path)));
      setIdByPath(
        new Map(
          spaces.flatMap((space): [string, string][] =>
            space.vault_id === null ? [] : [[space.path, space.vault_id]],
          ),
        ),
      );
      loadStats(spaces.filter((space) => space.available).map((space) => space.path));
    },
    [loadStats],
  );

  const reload = useCallback(async () => {
    try {
      const [spaces, shown] = await Promise.all([listSpaces(), spacesInTabs()]);
      applySpaces(spaces);
      setOpenIds(new Set(shown));
    } catch (e) {
      setError(String(e));
    }
  }, [applySpaces]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    // Tabs open and close spaces from any window.
    const stopOpen = listen<string[]>("spaces-open-changed", (event) => {
      if (cancelled) return;
      setOpenIds(new Set(event.payload));
      // A space created or added from a tab is new to the list.
      void listSpaces()
        .then((spaces) => {
          if (!cancelled) applySpaces(spaces);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(String(e));
        });
    });
    // The space moved to a new folder (В73): its row follows the new path.
    const stopMoved = listen<SpaceMovedPayload>("space-moved", () => {
      if (cancelled) return;
      void reload();
    });
    return () => {
      cancelled = true;
      void stopOpen.then((stop) => stop());
      void stopMoved.then((stop) => stop());
    };
  }, [applySpaces, reload]);

  // Shows the space's tab used last, or opens it in a new tab of the last
  // window (В69). The highlight follows spaces-open-changed.
  const handleOpen = useCallback((path: string) => {
    setError(null);
    void showSpace(path, false).catch((e: unknown) => setError(String(e)));
  }, []);

  // Forgetting is always allowed (В70): the backend sends the tabs of the
  // forgotten space to the space picker.
  const handleRemove = useCallback((path: string) => {
    setError(null);
    void forgetKnownVault(path)
      .then((paths) => {
        statsRequested.current.delete(path);
        setKnownVaults(paths);
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;
      const next = reorderedPaths(knownVaults, String(active.id), String(over.id));
      if (!next) return;
      setKnownVaults(next); // optimistic — config write follows
      void reorderKnownVaults(next)
        .then(setKnownVaults)
        .catch((e) => {
          setError(String(e));
          void reload();
        });
    },
    [knownVaults, reload],
  );

  const handleAddSpace = async () => {
    setError(null);
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;
    try {
      const vaults = await addKnownVault(selected);
      setKnownVaults(vaults);
      loadStats([selected]);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <section className="flex flex-col gap-s3">
      <h1 className="text-lg font-semibold">Spaces</h1>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={knownVaults} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-1">
            {knownVaults.map((path) => {
              const vaultId = idByPath.get(path);
              return (
                <SpaceRow
                  key={path}
                  path={path}
                  isOpen={vaultId !== undefined && openIds.has(vaultId)}
                  stats={statsByPath[path]}
                  available={!unavailable.has(path)}
                  onOpen={handleOpen}
                  onRemove={handleRemove}
                />
              );
            })}
            {knownVaults.length === 0 && (
              <li className="py-8 text-center text-sm text-muted-foreground">
                No known spaces
              </li>
            )}
          </ul>
        </SortableContext>
      </DndContext>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div>
        <Button variant="default" onClick={() => void handleAddSpace()}>
          Add Space
        </Button>
      </div>
    </section>
  );
}
