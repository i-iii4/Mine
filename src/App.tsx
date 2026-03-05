import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Outlet,
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
import { cn } from "@/lib/utils";
import { setInternalDragActive } from "@/lib/drag";
import { pushRecentTag } from "@/lib/recentTags";
import { useSidebarResize } from "@/hooks/useSidebarResize";
import { VaultPicker } from "@/components/VaultPicker";
import { Sidebar } from "@/components/Sidebar";
import { SidebarResizeHandle } from "@/components/SidebarResizeHandle";
import { Grid } from "@/components/Grid";
import { Search } from "@/components/Search";
import { Detail } from "@/components/Detail";
import { DropZone } from "@/components/DropZone";
import { ImportDialog } from "@/components/ImportDialog";

// ─── Visual grid navigation ────────────────────────────────────────────────

/** Find the nearest card in a given arrow direction based on screen coordinates. */
function findVisualNeighbor(
  currentSlug: string,
  direction: string,
): string | null {
  const current = document.querySelector(`[data-block-slug="${currentSlug}"]`);
  if (!current) return null;

  const rect = current.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  const horizontal = direction === "ArrowLeft" || direction === "ArrowRight";
  let bestSlug: string | null = null;
  let bestScore = Infinity;

  for (const card of document.querySelectorAll<HTMLElement>("[data-block-slug]")) {
    const slug = card.getAttribute("data-block-slug");
    if (slug === currentSlug) continue;

    const r = card.getBoundingClientRect();
    const dx = (r.left + r.width / 2) - cx;
    const dy = (r.top + r.height / 2) - cy;

    // Must be in the correct direction (10px dead zone)
    const valid =
      direction === "ArrowRight" ? dx > 10 :
      direction === "ArrowLeft"  ? dx < -10 :
      direction === "ArrowDown"  ? dy > 10 :
      /* ArrowUp */                dy < -10;

    if (!valid) continue;

    // Primary axis + 3× cross axis — prefers cards in the same "lane"
    const score = horizontal
      ? Math.abs(dx) + Math.abs(dy) * 3
      : Math.abs(dy) + Math.abs(dx) * 3;

    if (score < bestScore) {
      bestScore = score;
      bestSlug = slug!;
    }
  }

  return bestSlug;
}

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
  const [focusedBlockId, setFocusedBlockId] = useState<number | null>(null);
  const [activeDragBlock, setActiveDragBlock] = useState<IndexedBlock | null>(null);
  const [activeDragTag, setActiveDragTag] = useState<string | null>(null);
  const [sidebarScrolled, setSidebarScrolled] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);
  const gridColumnCountRef = useRef(1);

  // Blocks filtered by current route (channel or all)
  const activeBlocks = useMemo(() => {
    if (!currentTag) return blocks;
    return blocks.filter((b) => b.tags.includes(currentTag));
  }, [blocks, currentTag]);

  const handleColumnCountChange = useCallback((n: number) => {
    gridColumnCountRef.current = n;
  }, []);

  // Close Detail and clear grid focus when navigating to a different route
  useEffect(() => {
    setSelectedBlock(null);
    setFocusedBlockId(null);
  }, [location.pathname]);

  // ── Grid keyboard navigation (when Detail is closed) ───────────────────
  // Refs avoid re-subscribing the keydown listener on every focus change
  const focusedRef = useRef(focusedBlockId);
  focusedRef.current = focusedBlockId;
  const activeBlocksRef = useRef(activeBlocks);
  activeBlocksRef.current = activeBlocks;

  useEffect(() => {
    if (selectedBlock || searchOpen) return; // Detail or search handles keys

    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.altKey || e.ctrlKey) return;

      const cur = focusedRef.current;
      const ab = activeBlocksRef.current;

      if (e.key === "Enter" && cur !== null) {
        const block = ab.find((b) => b.id === cur);
        if (block) {
          setSelectedBlock(block);
          setFocusedBlockId(null);
        }
        return;
      }

      if (e.key === "Escape") {
        if (cur !== null) setFocusedBlockId(null);
        return;
      }

      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      e.preventDefault();

      if (cur === null) {
        if (ab.length > 0) setFocusedBlockId(ab[0]!.id);
        return;
      }

      // Visual navigation: find nearest card by screen coordinates
      const currentBlock = ab.find((b) => b.id === cur);
      if (!currentBlock) { setFocusedBlockId(ab[0]?.id ?? null); return; }

      const targetSlug = findVisualNeighbor(currentBlock.slug, e.key);
      if (!targetSlug) return;

      const targetBlock = ab.find((b) => b.slug === targetSlug);
      if (targetBlock) {
        setFocusedBlockId(targetBlock.id);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedBlock, searchOpen]);

  // Auto-scroll to focused card
  useEffect(() => {
    if (focusedBlockId === null) return;
    const block = activeBlocks.find((b) => b.id === focusedBlockId);
    if (!block) return;
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-block-slug="${block.slug}"]`);
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }, [focusedBlockId, activeBlocks]);

  // ── Sidebar resize ──────────────────────────────────────────────────────
  const {
    width: sidebarWidth,
    collapsed: sidebarCollapsed,
    isResizing: sidebarResizing,
    startResize,
    updateResize,
    endResize,
    toggleCollapsed,
  } = useSidebarResize();

  // ── Titlebar border on scroll ─────────────────────────────────────────
  // Global scroll listener filtered by data attributes — sidebar and grid
  // tracked independently, each controls its own segment of the border.
  useEffect(() => {
    const handler = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.hasAttribute("data-sidebar-scroll")) {
        setSidebarScrolled(target.scrollTop > 0);
      }
    };
    document.addEventListener("scroll", handler, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", handler, { capture: true });
  }, []);

  // ── dnd-kit sensors ────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const loadData = useCallback(async () => {
    const [b, t, ch] = await Promise.all([listBlocks(), listTags(), listChannels()]);
    setBlocks(b);
    setTags(t);
    setChannels(ch);
    // Signal cards to retry failed image loads (e.g. after iCloud files download)
    window.dispatchEvent(new Event("vault-refreshed"));
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
    setFocusedBlockId(null);
  }, []);

  const handleDetailClose = useCallback(() => {
    if (selectedBlock) setFocusedBlockId(selectedBlock.id);
    setSelectedBlock(null);
  }, [selectedBlock]);

  const handleDetailNavigate = useCallback(
    (direction: "prev" | "next") => {
      if (!selectedBlock) return;
      const idx = activeBlocks.findIndex((b) => b.id === selectedBlock.id);
      if (idx === -1) return;
      const newIdx = direction === "prev" ? idx - 1 : idx + 1;
      if (newIdx >= 0 && newIdx < activeBlocks.length) {
        setSelectedBlock(activeBlocks[newIdx]!);
      }
    },
    [selectedBlock, activeBlocks],
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

  // ── Opt+Cmd+Up/Down — switch channels ─────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey && e.altKey)) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const idx = currentTag
        ? orderedTags.findIndex((t) => t.tag === currentTag)
        : -1;
      if (e.key === "ArrowUp") {
        if (idx === 0) navigate("/");
        else if (idx > 0) navigate(`/channel/${encodeURIComponent(orderedTags[idx - 1]!.tag)}`);
      } else {
        if (idx === -1 && orderedTags.length > 0) {
          navigate(`/channel/${encodeURIComponent(orderedTags[0]!.tag)}`);
        } else if (idx >= 0 && idx < orderedTags.length - 1) {
          navigate(`/channel/${encodeURIComponent(orderedTags[idx + 1]!.tag)}`);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentTag, orderedTags, navigate]);

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

    const mdImageRe = /!\[.*?\]\((.+?)\)/;

    for (const tc of orderedTags) {
      const tagBlocks = blocksByTag.get(tc.tag) ?? [];
      const cards: PreviewCard[] = [];

      for (const b of tagBlocks) {
        if (cards.length >= 3) break;
        // Visual block types have thumbnails
        if (b.block_type === "image" || b.block_type === "link" || b.block_type === "video") {
          cards.push({ url: thumbnailUrl(vaultPath, b.slug) });
        } else {
          // Text/article/file — check for embedded images in body
          const match = b.body.match(mdImageRe);
          if (match?.[1]) {
            cards.push({ url: match[1] });
          }
        }
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
        className="fixed inset-x-0 top-0 z-50 flex h-8"
      >
        {/* Sidebar segment — width synced with resizable sidebar */}
        {!sidebarCollapsed && (
          <div
            data-tauri-drag-region
            className="relative h-full shrink-0 border-r border-border bg-background"
            style={{ width: sidebarWidth }}
          >
            <div className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 border-b transition-[border-color] duration-150",
              sidebarScrolled ? "border-border" : "border-transparent",
            )} />
          </div>
        )}
      </div>
      <Sidebar
        width={sidebarWidth}
        collapsed={sidebarCollapsed}
        isResizing={sidebarResizing}
        orderedTags={orderedTags}
        channelPreviews={channelPreviews}
        totalBlocks={blocks.length}
        isCardDragging={activeDragBlock !== null}
        onDeleteTag={handleDeleteTagFromAll}
        onRenameTag={handleRenameTag}
        onCreateChannel={handleCreateChannel}
      />

      <SidebarResizeHandle
        sidebarWidth={sidebarWidth}
        isResizing={sidebarResizing}
        disabled={activeDragBlock !== null || activeDragTag !== null}
        onResizeStart={startResize}
        onResizeUpdate={updateResize}
        onResizeEnd={endResize}
        onToggleCollapsed={toggleCollapsed}
      />

      <main ref={mainRef} className="relative isolate flex-1 overflow-hidden">
        <Routes>
          <Route
            element={
              <PageShell
                blocks={activeBlocks}
                vaultPath={vaultPath}
                tags={tags}
                currentTag={currentTag}
                sidebarCollapsed={sidebarCollapsed}
                focusedBlockId={focusedBlockId}
                onBlockClick={handleBlockClick}
                onToggleTag={handleToggleTag}
                onCreateAndAssign={handleCreateTagFromMenu}
                onDeleteBlock={handleDeleteBlock}
                onColumnCountChange={handleColumnCountChange}
              />
            }
          >
            <Route index element={<AllBlocksPage />} />
            <Route path="channel/:tag" element={<ChannelPage />} />
          </Route>
        </Routes>

        {selectedBlock && (
          <Detail
            block={selectedBlock}
            vaultPath={vaultPath}
            onClose={handleDetailClose}
            onNavigate={handleDetailNavigate}
            onTagsChanged={loadData}
          />
        )}
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
  sidebarCollapsed: boolean;
  focusedBlockId: number | null;
  onBlockClick: (block: IndexedBlock) => void;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onDeleteBlock: (slug: string) => void;
  onColumnCountChange: (count: number) => void;
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
  const ctx = useRouteCtx();
  return <Grid {...ctx} blocks={ctx.blocks} />;
}
