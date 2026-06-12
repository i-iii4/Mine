import { useCallback, useEffect, useState } from "react";
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
  getVaultPath,
  listKnownVaults,
  reorderKnownVaults,
  selectVault,
  spaceStats,
} from "@/lib/commands";
import { formatBytes } from "@/lib/formatBytes";
import { cn } from "@/lib/utils";
import type { SpaceStats } from "@/types";

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

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
  isActive: boolean;
  stats: SpaceStatsState | undefined;
  onSwitch: (path: string) => void;
  onRemove: (path: string) => void;
}

function SpaceRow({ path, isActive, stats, onSwitch, onRemove }: SpaceRowProps) {
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
        "group/space cursor-pointer rounded-1 border border-border px-3 py-2",
        isActive ? "bg-active" : "bg-accent hover:bg-active",
        isDragging && "opacity-30",
      )}
      aria-current={isActive ? "true" : undefined}
      data-space-row=""
      onClick={(event) => {
        // dnd-kit prevents the click that follows a completed drag.
        if (event.defaultPrevented) return;
        onSwitch(path);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSwitch(path);
        }
      }}
    >
      <div className="flex items-center gap-s2">
        <p className="min-w-0 flex-1 truncate text-base">{basename(path)}</p>
        {/* Fixed-size slot: ⋯ fades in on hover/focus, geometry never jumps
            (opacity canon of card hover actions). Clicks must not bubble into
            the row switch. */}
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
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="detach" onSelect={() => onRemove(path)}>
                <MenuIconSlot>
                  <Unlink className="size-3" />
                </MenuIconSlot>
                Remove Space
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <p className="truncate text-sm text-muted-foreground">{path}</p>
      <p className="text-sm text-muted-foreground" data-space-summary="">
        {statsSummary(stats)}
      </p>
    </li>
  );
}

export function SpacesSection() {
  const [knownVaults, setKnownVaults] = useState<string[]>([]);
  const [activeVault, setActiveVault] = useState<string | null>(null);
  const [statsByPath, setStatsByPath] = useState<Record<string, SpaceStatsState>>({});
  const [error, setError] = useState<string | null>(null);

  const sensors = useSensors(
    // distance 8 keeps plain clicks as switches; only a real drag reorders.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  // Per-row async stats (Р-4): the path list renders instantly from config,
  // a slow volume degrades only its own row.
  const loadStats = useCallback((paths: string[]) => {
    for (const path of paths) {
      void spaceStats(path)
        .then((stats) => {
          setStatsByPath((previous) => ({ ...previous, [path]: stats }));
        })
        .catch(() => {
          setStatsByPath((previous) => ({ ...previous, [path]: "error" }));
        });
    }
  }, []);

  const reload = useCallback(async () => {
    try {
      const [vaults, active] = await Promise.all([listKnownVaults(), getVaultPath()]);
      setKnownVaults(vaults);
      setActiveVault(active);
      loadStats(vaults);
    } catch (e) {
      setError(String(e));
    }
  }, [loadStats]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A switch may originate anywhere (this list, the main-window switcher) —
  // the backend broadcasts every select_vault.
  useEffect(() => {
    let cancelled = false;
    const unlisten = listen<{ path: string }>("vault-selected", (event) => {
      if (cancelled) return;
      setActiveVault(event.payload.path);
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, []);

  const handleSwitch = useCallback(
    (path: string) => {
      if (path === activeVault) return;
      setError(null);
      void selectVault(path)
        .then(() => setActiveVault(path))
        .catch((e) => setError(String(e)));
    },
    [activeVault],
  );

  // Removing the active space switches to the next one first, so the config
  // invariant "active ∈ known" never breaks (Р-6). The sole remaining space
  // is simply forgotten — the app keeps running on it.
  const handleRemove = useCallback(
    (path: string) => {
      setError(null);
      void (async () => {
        try {
          if (path === activeVault) {
            const next = knownVaults.find((candidate) => candidate !== path);
            if (next) {
              await selectVault(next);
              setActiveVault(next);
            }
          }
          setKnownVaults(await forgetKnownVault(path));
        } catch (e) {
          setError(String(e));
        }
      })();
    },
    [activeVault, knownVaults],
  );

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
      <p className="text-sm text-muted-foreground">
        Click a space to switch to it. Drag to reorder. Remove Space forgets a
        space from this list — files on disk are not touched.
      </p>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={knownVaults} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-1">
            {knownVaults.map((path) => (
              <SpaceRow
                key={path}
                path={path}
                isActive={path === activeVault}
                stats={statsByPath[path]}
                onSwitch={handleSwitch}
                onRemove={handleRemove}
              />
            ))}
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
