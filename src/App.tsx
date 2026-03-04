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

import type { IndexedBlock, TagCount, ChannelDto, PreviewCard } from "@/types";
import { thumbnailUrl } from "@/lib/assets";
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
import { pushRecentTag } from "@/lib/recentTags";
import { VaultPicker } from "@/components/VaultPicker";
import { Sidebar } from "@/components/Sidebar";
import { Grid } from "@/components/Grid";
import { Search } from "@/components/Search";
import { Dialog } from "@/components/ui/dialog";
import { Detail } from "@/components/Detail";
import { DropZone } from "@/components/DropZone";
import { ImportDialog } from "@/components/ImportDialog";

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
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <p className="text-base text-muted-foreground">Loading...</p>
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
      await deleteChannel(tag).catch((err) => console.error("Failed to delete channel:", err));
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

  // ── Channel preview cards (sidebar icons) ──────────────────────────────

  const channelPreviews = useMemo(() => {
    const map = new Map<string, PreviewCard[]>();
    // Index blocks by tag once
    const blocksByTag = new Map<string, IndexedBlock[]>();
    for (const b of blocks) {
      for (const t of b.tags) {
        const arr = blocksByTag.get(t);
        if (arr) arr.push(b);
        else blocksByTag.set(t, [b]);
      }
    }

    for (const tc of orderedTags) {
      const tagBlocks = blocksByTag.get(tc.tag) ?? [];
      const withThumb: IndexedBlock[] = [];
      const textOnly: IndexedBlock[] = [];

      for (const b of tagBlocks) {
        if (b.block_type === "image" || b.block_type === "link" || b.block_type === "video") {
          withThumb.push(b);
        } else {
          textOnly.push(b);
        }
      }

      const cards: PreviewCard[] = [];
      for (const b of withThumb) {
        if (cards.length >= 3) break;
        cards.push({ type: "image", url: thumbnailUrl(vaultPath, b.slug) });
      }
      for (const _ of textOnly) {
        if (cards.length >= 3) break;
        cards.push({ type: "text" });
      }

      map.set(tc.tag, cards);
    }

    return map;
  }, [blocks, orderedTags, vaultPath]);

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

  // ── Card tag management (context menu) ───────────────────────────────────

  const handleToggleTag = useCallback(
    async (slug: string, tag: string, hasTag: boolean) => {
      if (hasTag) {
        await removeTag(slug, tag);
      } else {
        await addTag(slug, tag);
        pushRecentTag(tag);
      }
      await loadData();
    },
    [loadData],
  );

  const handleCreateTagFromMenu = useCallback(
    async (tag: string, blockSlug: string) => {
      await addTag(blockSlug, tag);
      pushRecentTag(tag);
      await loadData();
    },
    [loadData],
  );

  const handleDeleteBlock = useCallback(
    async (slug: string) => {
      await deleteBlock(slug);
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
    <div className="flex h-screen w-screen bg-background text-foreground">
      {/* Window drag handle — replaces native title bar in Overlay mode */}
      <div
        data-tauri-drag-region
        className="fixed inset-x-0 top-0 z-50 h-7"
      />
      <Sidebar
        orderedTags={orderedTags}
        channelPreviews={channelPreviews}
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
                tags={tags}
                currentTag={currentTag}
                onBlockClick={handleBlockClick}
                onToggleTag={handleToggleTag}
                onCreateAndAssign={handleCreateTagFromMenu}
                onDeleteBlock={handleDeleteBlock}
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

      <Dialog
        open={selectedBlock !== null}
        onOpenChange={(isOpen) => { if (!isOpen) setSelectedBlock(null); }}
      >
        {selectedBlock && (
          <Detail
            block={selectedBlock}
            vaultPath={vaultPath}
            onNavigate={handleDetailNavigate}
            onTagsChanged={loadData}
          />
        )}
      </Dialog>
    </div>

    <DragOverlay dropAnimation={null} modifiers={[snapToCursor]}>
      {activeDragBlock && (
        <div className="pointer-events-none rounded-1 border border-border bg-card px-3 py-2 text-base shadow-lg">
          {activeDragBlock.title ?? activeDragBlock.slug}
        </div>
      )}
      {activeDragTag && (
        <div className="pointer-events-none rounded-1 bg-secondary px-3 py-1.5 text-base font-semibold shadow-lg">
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
  tags: TagCount[];
  currentTag?: string;
  onBlockClick: (block: IndexedBlock) => void;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onDeleteBlock: (slug: string) => void;
}

function PageShell(props: RouteContext) {
  return <Outlet context={props} />;
}

function useRouteCtx(): RouteContext {
  return useOutletContext<RouteContext>();
}

// ─── Pages ─────────────────────────────────────────────────────────────────

function AllBlocksPage() {
  const ctx = useRouteCtx();
  return <Grid {...ctx} blocks={ctx.blocks} />;
}

function ChannelPage() {
  const { tag } = useParams<{ tag: string }>();
  const ctx = useRouteCtx();

  const filtered = ctx.blocks.filter(
    (b) => tag && b.tags.includes(decodeURIComponent(tag)),
  );

  return <Grid {...ctx} blocks={filtered} />;
}
