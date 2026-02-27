import { useState, useEffect, useCallback, useRef } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Outlet,
  useParams,
  useOutletContext,
} from "react-router";
import { listen } from "@tauri-apps/api/event";

import type { IndexedBlock, ChannelDto, TagCount } from "@/types";
import { getVaultPath, listBlocks, listChannels, listTags } from "@/lib/commands";
import { VaultPicker } from "@/components/VaultPicker";
import { Sidebar } from "@/components/Sidebar";
import { Grid } from "@/components/Grid";
import { Search } from "@/components/Search";
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

function AppWithVault({ vaultPath }: { vaultPath: string }) {
  const [blocks, setBlocks] = useState<IndexedBlock[]>([]);
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selectedBlock, setSelectedBlock] = useState<IndexedBlock | null>(null);

  const loadData = useCallback(async () => {
    const [b, c, t] = await Promise.all([listBlocks(), listChannels(), listTags()]);
    setBlocks(b);
    setChannels(c);
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

  return (
    <div className="flex h-screen w-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <Sidebar
        channels={channels}
        tags={tags}
        totalBlocks={blocks.length}
        onSearchOpen={() => setSearchOpen(true)}
        onImportOpen={() => setImportOpen(true)}
      />

      <main className="flex-1 overflow-hidden">
        <Routes>
          <Route
            element={
              <PageShell
                blocks={blocks}
                vaultPath={vaultPath}
                onBlockClick={handleBlockClick}
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
    </div>
  );
}

// ─── Route context ─────────────────────────────────────────────────────────

interface RouteContext {
  blocks: IndexedBlock[];
  vaultPath: string;
  onBlockClick: (block: IndexedBlock) => void;
}

function PageShell({
  blocks,
  vaultPath,
  onBlockClick,
}: RouteContext) {
  return <Outlet context={{ blocks, vaultPath, onBlockClick }} />;
}

function useRouteCtx(): RouteContext {
  return useOutletContext<RouteContext>();
}

// ─── Pages ─────────────────────────────────────────────────────────────────

function AllBlocksPage() {
  const { blocks, vaultPath, onBlockClick } = useRouteCtx();
  return (
    <Grid blocks={blocks} vaultPath={vaultPath} onBlockClick={onBlockClick} />
  );
}

function ChannelPage() {
  const { tag } = useParams<{ tag: string }>();
  const { blocks, vaultPath, onBlockClick } = useRouteCtx();

  const filtered = blocks.filter(
    (b) => tag && b.tags.includes(decodeURIComponent(tag)),
  );

  return (
    <Grid blocks={filtered} vaultPath={vaultPath} onBlockClick={onBlockClick} />
  );
}
