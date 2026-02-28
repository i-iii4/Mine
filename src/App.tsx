import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Outlet,
  useParams,
  useOutletContext,
  useNavigate,
  useLocation,
} from "react-router";
import { listen } from "@tauri-apps/api/event";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";

/** Convert a normalized tag slug to a display title: `web-design` -> `Web Design` */
function titleFromTag(tag: string): string {
  return tag
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Pin the DragOverlay so the cursor tip sits just outside the top-left corner. */
const snapToCursor: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!activatorEvent || !draggingNodeRect) return transform;
  const e = activatorEvent as PointerEvent;
  const INSET = 4; // cursor tip peeks past the border-radius
  return {
    ...transform,
    x: transform.x + (e.clientX - draggingNodeRect.left) - INSET,
    y: transform.y + (e.clientY - draggingNodeRect.top) - INSET,
  };
};

import type { IndexedBlock, TagCount, ChannelDto } from "@/types";
import {
  getVaultPath,
  listBlocks,
  listTags,
  listChannels,
  createChannel,
  deleteChannel,
  reorderChannels,
  renameTag,
  deleteTagFromAll,
  addTag,
  removeTag,
  deleteBlock,
} from "@/lib/commands";
import { setInternalDragActive } from "@/lib/drag";
import { VaultPicker } from "@/components/VaultPicker";
import { Sidebar } from "@/components/Sidebar";
import { Grid } from "@/components/Grid";
import { Search } from "@/components/Search";
import { Detail } from "@/components/Detail";
import { DropZone } from "@/components/DropZone";
import { ImportDialog } from "@/components/ImportDialog";
import { CardContextMenu } from "@/components/CardContextMenu";

// ─── Root ──────────────────────────────────────────────────────────────────

export function App() {
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getVaultPath()
      .then((path) => setVaultPath(path))
      .catch(() => setVaultPath(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-neutral-50 dark:bg-neutral-950">
        <p className="text-sm text-neutral-400">Loading...</p>
      </div>
    );
  }

  if (!vaultPath) {
    return <VaultPicker onVaultSelected={setVaultPath} />;
  }

  return (
    <BrowserRouter>
      <AppWithVault vaultPath={vaultPath} />
    </BrowserRouter>
  );
}

// ─── Main app (vault selected) ─────────────────────────────────────────────

interface ContextMenuState {
  block: IndexedBlock;
  x: number;
  y: number;
}

function AppWithVault({ vaultPath }: { vaultPath: string }) {
  const navigate = useNavigate();
  const location = useLocation();

  const currentTag = location.pathname.startsWith("/channel/")
    ? decodeURIComponent(location.pathname.slice("/channel/".length))
    : undefined;

  const [blocks, setBlocks] = useState<IndexedBlock[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selectedBlock, setSelectedBlock] = useState<IndexedBlock | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [activeDragBlock, setActiveDragBlock] = useState<IndexedBlock | null>(null);
  const [activeDragTag, setActiveDragTag] = useState<string | null>(null);

  // ── dnd-kit sensors ────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const loadData = useCallback(async () => {
    const [b, t, ch] = await Promise.all([listBlocks(), listTags(), listChannels()]);
    setBlocks(b);
    setTags(t);
    setChannels(ch);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Listen for vault-changed events from file watcher (with debounce)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const unlisten = listen("vault-changed", () => {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(loadData, 500);
    });
    return () => {
      unlisten.then((fn) => fn());
      clearTimeout(debounceRef.current);
    };
  }, [loadData]);

  // Global Cmd+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ── Block navigation ──────────────────────────────────────────────────────

  const handleBlockClick = useCallback((block: IndexedBlock) => {
    setSelectedBlock(block);
  }, []);

  const handleDetailNavigate = useCallback(
    (direction: "prev" | "next") => {
      if (!selectedBlock) return;
      const idx = blocks.findIndex((b) => b.id === selectedBlock.id);
      if (idx === -1) return;
      const newIdx = direction === "prev" ? idx - 1 : idx + 1;
      if (newIdx >= 0 && newIdx < blocks.length) {
        setSelectedBlock(blocks[newIdx]!);
      }
    },
    [selectedBlock, blocks],
  );

  // ── Tag management ──────────────────────────────────────────────────────

  const handleRenameTag = useCallback(
    async (oldTag: string, newTag: string) => {
      await renameTag(oldTag, newTag);
      await loadData();
      const currentPath = window.location.pathname;
      if (currentPath === `/channel/${encodeURIComponent(oldTag)}`) {
        navigate(`/channel/${encodeURIComponent(newTag)}`);
      }
    },
    [loadData, navigate],
  );

  const handleDeleteTagFromAll = useCallback(
    async (tag: string) => {
      await deleteTagFromAll(tag);
      await deleteChannel(tag).catch(() => {});
      await loadData();
    },
    [loadData],
  );

  // ── Ordered tags: channels by position, then remaining alphabetically ──

  const orderedTags = useMemo(() => {
    const channelPositions = new Map(channels.map((c) => [c.tag, c.position]));
    const withPos: (TagCount & { pos: number })[] = [];
    const noPos: TagCount[] = [];

    for (const tc of tags) {
      const pos = channelPositions.get(tc.tag);
      if (pos !== undefined) {
        withPos.push({ ...tc, pos });
      } else {
        noPos.push(tc);
      }
    }

    // Channels that exist but have no blocks yet
    for (const ch of channels) {
      if (!tags.some((tc) => tc.tag === ch.tag)) {
        withPos.push({ tag: ch.tag, count: 0, pos: ch.position });
      }
    }

    withPos.sort((a, b) => a.pos - b.pos);
    noPos.sort((a, b) => a.tag.localeCompare(b.tag));

    return [...withPos, ...noPos].map(({ tag, count }) => ({ tag, count }));
  }, [tags, channels]);

  // ── Channel management ─────────────────────────────────────────────────

  const handleCreateChannel = useCallback(
    async (tag: string) => {
      await createChannel(tag);
      await loadData();
    },
    [loadData],
  );

  const handleReorderTag = useCallback(
    async (activeTag: string, overTag: string) => {
      const currentOrder = orderedTags.map((t) => t.tag);
      const oldIndex = currentOrder.indexOf(activeTag);
      const newIndex = currentOrder.indexOf(overTag);
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

      const newOrder = arrayMove(currentOrder, oldIndex, newIndex);
      const items = newOrder.map((tag, i) => ({ tag, position: i }));
      await reorderChannels(items);
      await loadData();
    },
    [orderedTags, loadData],
  );

  // ── Card drag-to-tag (dnd-kit) ──────────────────────────────────────────

  const handleCardDrop = useCallback(
    async (slug: string, tag: string) => {
      await addTag(slug, tag);
      await loadData();
    },
    [loadData],
  );

  const handleDndStart = useCallback(
    (event: DragStartEvent) => {
      setInternalDragActive(true);
      const id = String(event.active.id);
      if (id.startsWith("tag:")) {
        setActiveDragTag(id.slice(4));
        setActiveDragBlock(null);
      } else {
        const block = blocks.find((b) => b.slug === id);
        if (block) setActiveDragBlock(block);
        setActiveDragTag(null);
      }
    },
    [blocks],
  );

  const handleDndEnd = useCallback(
    (event: DragEndEvent) => {
      setInternalDragActive(false);
      setActiveDragBlock(null);
      setActiveDragTag(null);
      const { active, over } = event;
      if (!over) return;

      const activeId = String(active.id);
      const overId = String(over.id);

      // Tag reorder in sidebar
      if (activeId.startsWith("tag:") && overId.startsWith("tag:")) {
        handleReorderTag(activeId.slice(4), overId.slice(4));
        return;
      }

      // Card dropped on tag
      if (!activeId.startsWith("tag:") && overId.startsWith("tag:")) {
        handleCardDrop(activeId, overId.slice(4));
      }
    },
    [handleCardDrop, handleReorderTag],
  );

  const handleDndCancel = useCallback(() => {
    setInternalDragActive(false);
    setActiveDragBlock(null);
    setActiveDragTag(null);
  }, []);

  // ── Context menu ──────────────────────────────────────────────────────────

  const handleContextMenu = useCallback(
    (block: IndexedBlock, x: number, y: number) => {
      setContextMenu({ block, x, y });
    },
    [],
  );

  const handleToggleTag = useCallback(
    async (slug: string, tag: string, hasTag: boolean) => {
      if (hasTag) {
        await removeTag(slug, tag);
      } else {
        await addTag(slug, tag);
      }
      // Optimistic update of context menu block tags
      setContextMenu((prev) => {
        if (!prev || prev.block.slug !== slug) return prev;
        const newTags = hasTag
          ? prev.block.tags.filter((t) => t !== tag)
          : [...prev.block.tags, tag];
        return { ...prev, block: { ...prev.block, tags: newTags } };
      });
      await loadData();
    },
    [loadData],
  );

  const handleCreateTagFromMenu = useCallback(
    async (tag: string, blockSlug: string) => {
      await addTag(blockSlug, tag);
      setContextMenu((prev) => {
        if (!prev || prev.block.slug !== blockSlug) return prev;
        return { ...prev, block: { ...prev.block, tags: [...prev.block.tags, tag] } };
      });
      await loadData();
    },
    [loadData],
  );

  const handleDeleteBlock = useCallback(
    async (slug: string) => {
      await deleteBlock(slug);
      setContextMenu(null);
      await loadData();
    },
    [loadData],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      autoScroll={{ canScroll: (el) => el.hasAttribute("data-sidebar-scroll") }}
      onDragStart={handleDndStart}
      onDragEnd={handleDndEnd}
      onDragCancel={handleDndCancel}
    >
    <div className="flex h-screen w-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <Sidebar
        orderedTags={orderedTags}
        totalBlocks={blocks.length}
        isCardDragging={activeDragBlock !== null}
        onSearchOpen={() => setSearchOpen(true)}
        onImportOpen={() => setImportOpen(true)}
        onDeleteTag={handleDeleteTagFromAll}
        onRenameTag={handleRenameTag}
        onCreateChannel={handleCreateChannel}
      />

      <main className="flex-1 overflow-hidden">
        <Routes>
          <Route
            element={
              <PageShell
                blocks={blocks}
                vaultPath={vaultPath}
                onBlockClick={handleBlockClick}
                onContextMenu={handleContextMenu}
              />
            }
          >
            <Route index element={<AllBlocksPage />} />
            <Route path="channel/:tag" element={<ChannelPage />} />
          </Route>
        </Routes>
      </main>

      <Search
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelect={(block) => {
          setSelectedBlock(block);
          setSearchOpen(false);
        }}
      />

      <DropZone currentTag={currentTag} onBlocksCreated={loadData} />

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImportComplete={loadData}
      />

      {selectedBlock && (
        <Detail
          block={selectedBlock}
          vaultPath={vaultPath}
          onClose={() => setSelectedBlock(null)}
          onNavigate={handleDetailNavigate}
          onTagsChanged={loadData}
        />
      )}

      {contextMenu && (
        <CardContextMenu
          block={contextMenu.block}
          x={contextMenu.x}
          y={contextMenu.y}
          tags={tags}
          onToggleTag={handleToggleTag}
          onCreateAndAssign={handleCreateTagFromMenu}
          onDelete={handleDeleteBlock}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>

    <DragOverlay dropAnimation={null} modifiers={[snapToCursor]}>
      {activeDragBlock && (
        <div className="pointer-events-none rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm shadow-lg dark:border-neutral-600 dark:bg-neutral-800">
          {activeDragBlock.title ?? activeDragBlock.slug}
        </div>
      )}
      {activeDragTag && (
        <div className="pointer-events-none rounded-md bg-neutral-200 px-3 py-1.5 text-sm font-medium shadow-lg dark:bg-neutral-700">
          {titleFromTag(activeDragTag)}
        </div>
      )}
    </DragOverlay>
    </DndContext>
  );
}

// ─── Route context ─────────────────────────────────────────────────────────

interface RouteContext {
  blocks: IndexedBlock[];
  vaultPath: string;
  onBlockClick: (block: IndexedBlock) => void;
  onContextMenu: (block: IndexedBlock, x: number, y: number) => void;
}

function PageShell({
  blocks,
  vaultPath,
  onBlockClick,
  onContextMenu,
}: RouteContext) {
  return <Outlet context={{ blocks, vaultPath, onBlockClick, onContextMenu }} />;
}

function useRouteCtx(): RouteContext {
  return useOutletContext<RouteContext>();
}

// ─── Pages ─────────────────────────────────────────────────────────────────

function AllBlocksPage() {
  const { blocks, vaultPath, onBlockClick, onContextMenu } = useRouteCtx();
  return (
    <Grid
      blocks={blocks}
      vaultPath={vaultPath}
      onBlockClick={onBlockClick}
      onContextMenu={onContextMenu}
    />
  );
}

function ChannelPage() {
  const { tag } = useParams<{ tag: string }>();
  const { blocks, vaultPath, onBlockClick, onContextMenu } = useRouteCtx();

  const filtered = blocks.filter(
    (b) => tag && b.tags.includes(decodeURIComponent(tag)),
  );

  return (
    <Grid
      blocks={filtered}
      vaultPath={vaultPath}
      onBlockClick={onBlockClick}
      onContextMenu={onContextMenu}
    />
  );
}
