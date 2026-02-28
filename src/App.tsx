import { useState, useEffect, useCallback, useRef } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Outlet,
  useParams,
  useOutletContext,
  useNavigate,
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

/** Center the DragOverlay on the cursor rather than on the dragged element's origin. */
const snapToCursor: Modifier = ({ activatorEvent, draggingNodeRect, overlayNodeRect, transform }) => {
  if (!activatorEvent || !draggingNodeRect) return transform;
  const e = activatorEvent as PointerEvent;
  const ow = overlayNodeRect?.width ?? 0;
  const oh = overlayNodeRect?.height ?? 0;
  return {
    ...transform,
    x: transform.x + (e.clientX - draggingNodeRect.left) - ow / 2,
    y: transform.y + (e.clientY - draggingNodeRect.top) - oh / 2,
  };
};

import type { IndexedBlock, TagCount } from "@/types";
import {
  getVaultPath,
  listBlocks,
  listTags,
  renameTag,
  deleteTagFromAll,
  addTag,
  removeTag,
  deleteBlock,
} from "@/lib/commands";
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

  const [blocks, setBlocks] = useState<IndexedBlock[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selectedBlock, setSelectedBlock] = useState<IndexedBlock | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [activeDragBlock, setActiveDragBlock] = useState<IndexedBlock | null>(null);

  // ── dnd-kit sensors ────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const loadData = useCallback(async () => {
    const [b, t] = await Promise.all([listBlocks(), listTags()]);
    setBlocks(b);
    setTags(t);
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
      await loadData();
    },
    [loadData],
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
      const slug = String(event.active.id);
      const block = blocks.find((b) => b.slug === slug);
      if (block) setActiveDragBlock(block);
    },
    [blocks],
  );

  const handleDndEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragBlock(null);
      const { active, over } = event;
      if (!over) return;
      const overId = String(over.id);
      if (!overId.startsWith("tag:")) return;
      const tag = overId.slice(4);
      const slug = String(active.id);
      handleCardDrop(slug, tag);
    },
    [handleCardDrop],
  );

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
    >
    <div className="flex h-screen w-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <Sidebar
        tags={tags}
        totalBlocks={blocks.length}
        onSearchOpen={() => setSearchOpen(true)}
        onImportOpen={() => setImportOpen(true)}
        onDeleteTag={handleDeleteTagFromAll}
        onRenameTag={handleRenameTag}
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

      <DropZone onBlocksCreated={loadData} />

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
