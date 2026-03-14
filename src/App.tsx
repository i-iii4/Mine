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

import type { IndexedBlock, LightBlock, TagCount, ChannelDto, PreviewCard } from "@/types";
import { thumbnailUrl } from "@/lib/assets";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  getVaultPath,
  selectVault,
  getBlock,
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
  listChannelPreviews,
} from "@/lib/commands";
import { pushRecentTag } from "@/lib/recentTags";
import { useSidebarResize } from "@/hooks/useSidebarResize";
import { VaultPicker } from "@/components/VaultPicker";
import { Sidebar } from "@/components/Sidebar";
import { SidebarResizeHandle } from "@/components/SidebarResizeHandle";
import { Grid } from "@/components/Grid";
import { Search } from "@/components/Search";
import { Detail } from "@/components/Detail";
import { ImportDialog } from "@/components/ImportDialog";
import { DropZone } from "@/components/DropZone";
import { ActionButton } from "@/components/ActionButton";
import { ThemeMenuButton, type ThemeMenuHandle } from "@/components/ThemeMenuButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Plus, Trash2, Info } from "lucide-react";

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

  const [blocks, setBlocks] = useState<LightBlock[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [designSystemOpen, setDesignSystemOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [isCreatingChannel, setIsCreatingChannel] = useState(false);
  const [selectedBlock, setSelectedBlock] = useState<IndexedBlock | null>(null);
  const [focusedBlockId, setFocusedBlockId] = useState<number | null>(null);
  const [activeDragBlock, setActiveDragBlock] = useState<LightBlock | null>(null);
  const [activeDragTag, setActiveDragTag] = useState<string | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const themeMenuRef = useRef<ThemeMenuHandle>(null);
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
          setFocusedBlockId(null);
          getBlock(block.slug).then((full) => {
            if (full) setSelectedBlock(full);
          });
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


  // ── dnd-kit sensors ────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  // ── Channel preview cards (sidebar thumbnails) ─────────────────────────

  const [channelPreviews, setChannelPreviews] = useState<Map<string, PreviewCard[]>>(new Map());

  const loadPreviews = useCallback(async () => {
    if (!vaultPath) return;
    const raw = await listChannelPreviews(20);
    const map = new Map<string, PreviewCard[]>();
    for (const [key, slugs] of Object.entries(raw)) {
      map.set(key, slugs.map((slug) => ({ url: thumbnailUrl(vaultPath, slug) })));
    }
    setChannelPreviews(map);
  }, [vaultPath]);

  const [loadError, setLoadError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [b, t, ch] = await Promise.all([listBlocks(), listTags(), listChannels()]);
      setBlocks(b);
      setTags(t);
      setChannels(ch);
      setLoadError(null);
      // Signal cards to retry failed image loads (e.g. after iCloud files download)
      window.dispatchEvent(new Event("vault-refreshed"));
      // Previews loaded after main data to not block initial render
      loadPreviews();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to load data:", msg);
      setLoadError(msg);
    }
  }, [loadPreviews]);

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

  // ── Vault switching ──────────────────────────────────────────────────────

  const handleSwitchVault = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected) return;
    await selectVault(selected);
    window.location.reload();
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      } else if (e.shiftKey && e.key === "O") {
        e.preventDefault();
        handleSwitchVault();
      } else if (e.shiftKey && e.key === "N") {
        e.preventDefault();
        setIsCreatingChannel(true);
      } else if (e.key === ",") {
        e.preventDefault();
        themeMenuRef.current?.toggle();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSwitchVault]);

  // ── Block navigation ──────────────────────────────────────────────────────

  const handleBlockClick = useCallback(async (block: LightBlock) => {
    setFocusedBlockId(null);
    // Load full block data (with complete body/description) for Detail view
    const full = await getBlock(block.slug);
    if (full) {
      setSelectedBlock(full);
    }
  }, []);

  const handleDetailClose = useCallback(() => {
    if (selectedBlock) setFocusedBlockId(selectedBlock.id);
    setSelectedBlock(null);
  }, [selectedBlock]);

  const handleDetailNavigate = useCallback(
    async (direction: "prev" | "next" | "up" | "down") => {
      if (!selectedBlock) return;
      const idx = activeBlocks.findIndex((b) => b.id === selectedBlock.id);
      if (idx === -1) return;
      const cols = gridColumnCountRef.current;
      let newIdx: number;
      switch (direction) {
        case "prev":  newIdx = idx - 1; break;
        case "next":  newIdx = idx + 1; break;
        case "up":    newIdx = idx - cols; break;
        case "down":  newIdx = idx + cols; break;
      }
      if (newIdx >= 0 && newIdx < activeBlocks.length) {
        const target = activeBlocks[newIdx]!;
        const full = await getBlock(target.slug);
        if (full) setSelectedBlock(full);
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
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      {/* Top toolbar */}
      <header
        data-tauri-drag-region
        className="flex h-8 shrink-0 items-center border-b border-border"
      >
        {/* Traffic light spacer (macOS) */}
        <div data-tauri-drag-region className="w-20 shrink-0" />
        {/* Toolbar content area */}
        <div data-tauri-drag-region className="flex flex-1 items-center px-3" />
      </header>

      {/* Body: sidebar + main */}
      <div className="flex min-h-0 flex-1">
      <Sidebar
        width={sidebarWidth}
        collapsed={sidebarCollapsed}
        isResizing={sidebarResizing}
        orderedTags={orderedTags}
        channelPreviews={channelPreviews}
        totalBlocks={blocks.length}
        isCardDragging={activeDragBlock !== null}
        isCreatingChannel={isCreatingChannel}
        onSetCreatingChannel={setIsCreatingChannel}
        onDeleteTag={handleDeleteTagFromAll}
        onRenameTag={handleRenameTag}
        onCreateChannel={handleCreateChannel}
        onNavClick={() => setSelectedBlock(null)}
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
        {loadError && (
          <div className="flex h-full items-center justify-center p-8">
            <p className="text-sm text-destructive">{loadError}</p>
          </div>
        )}
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

        {designSystemOpen && (
          <div className="absolute inset-0 z-40 overflow-y-auto bg-background">
            <ComponentTestBench />
          </div>
        )}

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

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImportComplete={loadData}
      />
    </div>{/* end body */}

      {/* Bottom action bar */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-t border-border bg-accent px-8">
        <ActionButton hotkey="⌘⇧O" onClick={handleSwitchVault}>
          {vaultPath.split("/").pop() ?? "Vault"}
        </ActionButton>
        <ActionButton hotkey="⌘⇧N" onClick={() => setIsCreatingChannel(true)}>
          New Channel
        </ActionButton>
        <ThemeMenuButton ref={themeMenuRef} />
        <ActionButton
          onClick={() => setDesignSystemOpen((v) => !v)}
          isSelected={designSystemOpen}
        >
          Design
        </ActionButton>
        <div className="flex-1" />
        <ActionButton hotkey="⌘K" onClick={() => setSearchOpen(true)}>
          Search
        </ActionButton>
      </div>

      <DropZone currentTag={currentTag} onBlocksCreated={loadData} />
    </div>{/* end flex-col */}

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
  blocks: LightBlock[];
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  sidebarCollapsed: boolean;
  focusedBlockId: number | null;
  onBlockClick: (block: LightBlock) => void;
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

function ComponentTestBench() {
  return (
    <div className="border-b border-border p-8">
      <p className="mb-6 font-mono text-sm text-muted-foreground">Component test bench</p>

      {/* Button — Sizes */}
      <Section label="Button — Sizes">
        <Button size="xs">xs 24px</Button>
        <Button>default 32px</Button>
      </Section>

      {/* Button — Variants */}
      <Section label="Button — Variants">
        <Button variant="default">Default</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="link">Link</Button>
      </Section>

      {/* Button — with icons */}
      <Section label="Button — Icons">
        <Button size="xs"><Plus className="size-3" />Add</Button>
        <Button><Plus className="size-4" />Add</Button>
        <Button variant="destructive"><Trash2 className="size-4" />Delete</Button>
      </Section>

      {/* Button — Icon only */}
      <Section label="Button — Icon only">
        <Button size="icon-xs"><Plus className="size-3" /></Button>
        <Button size="icon"><Plus className="size-4" /></Button>
      </Section>

      {/* Button — Disabled */}
      <Section label="Button — Disabled">
        <Button disabled>Disabled</Button>
        <Button variant="destructive" disabled>Disabled</Button>
      </Section>

      {/* ActionButton */}
      <Section label="ActionButton (bottom bar)">
        <ActionButton hotkey="⌘K">Search</ActionButton>
        <ActionButton hotkey="⌘⇧N">New Channel</ActionButton>
        <ActionButton hotkey="⌘,">Settings</ActionButton>
        <ActionButton>No hotkey</ActionButton>
        <ActionButton hotkey="⌘⇧O" isSelected>Selected</ActionButton>
      </Section>

      {/* Input */}
      <Section label="Input">
        <Input placeholder="Default" className="w-48" />
        <Input defaultValue="With value" className="w-48" />
        <Input disabled placeholder="Disabled" className="w-48" />
      </Section>

      <Section label="Input — Ghost">
        <Input variant="ghost" placeholder="Ghost input..." className="w-48" />
        <Input variant="ghost" defaultValue="With value" className="w-48" />
      </Section>


      {/* Checkbox */}
      <Section label="Checkbox">
        <div className="flex items-center gap-2">
          <Checkbox id="cb1" />
          <label htmlFor="cb1" className="text-base">Unchecked</label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="cb2" defaultChecked />
          <label htmlFor="cb2" className="text-base">Checked</label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="cb3" disabled />
          <label htmlFor="cb3" className="text-base text-muted-foreground">Disabled</label>
        </div>
      </Section>

      {/* Progress */}
      <Section label="Progress">
        <Progress value={0} className="w-64" />
        <Progress value={45} className="w-64" />
        <Progress value={100} className="w-64" />
      </Section>

      {/* Tooltip */}
      <Section label="Tooltip">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button><Info className="size-4" />Hover me</Button>
          </TooltipTrigger>
          <TooltipContent>Tooltip content</TooltipContent>
        </Tooltip>
      </Section>

      {/* Typography */}
      <Section label="Typography">
        <span className="text-sm text-foreground">text-sm (12px)</span>
        <span className="text-base text-foreground">text-base (14px)</span>
        <span className="text-lg text-foreground">text-lg (18px)</span>
      </Section>

      {/* Text hierarchy */}
      <Section label="Text hierarchy">
        <span className="text-base text-foreground">foreground</span>
        <span className="text-base text-muted-foreground">muted-foreground</span>
        <span className="text-base text-tertiary-foreground">tertiary-foreground</span>
      </Section>

      {/* Surfaces */}
      <Section label="Surfaces (background layering)" vertical>
        <div className="flex gap-2">
          <Swatch label="background" className="bg-background border border-border" />
          <Swatch label="accent (+1)" className="bg-accent" />
          <Swatch label="sidebar-accent (+2)" className="bg-sidebar-accent" />
          <Swatch label="active/border (+3)" className="bg-active" />
        </div>
      </Section>

      {/* Button tokens */}
      <Section label="Button tokens" vertical>
        <div className="flex gap-2">
          <Swatch label="component-fill" className="bg-component-fill" />
          <Swatch label="component-fill-inner" className="bg-component-fill-inner" />
          <Swatch label="component-fill-hover" className="bg-component-fill-hover" />
        </div>
      </Section>
    </div>
  );
}

function Section({ label, children, vertical }: { label: string; children: React.ReactNode; vertical?: boolean }) {
  return (
    <div className="mb-4">
      <p className="mb-2 font-mono text-sm text-muted-foreground">{label}</p>
      <div className={vertical ? "flex flex-col gap-2" : "flex flex-wrap items-center gap-2"}>
        {children}
      </div>
    </div>
  );
}

function Swatch({ label, className }: { label: string; className: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className={`size-12 rounded-1 ${className}`} />
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}

function AllBlocksPage() {
  const ctx = useRouteCtx();
  return <Grid {...ctx} blocks={ctx.blocks} />;
}

function ChannelPage() {
  const ctx = useRouteCtx();
  return <Grid {...ctx} blocks={ctx.blocks} />;
}
