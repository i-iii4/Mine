import { useRef, useState, useEffect, useMemo, useCallback, memo } from "react";
import {
  ContextMenu,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { VirtuosoMasonry } from "@virtuoso.dev/masonry";
import type { LightBlock, TagCount } from "@/types";
import { Card } from "./Card";
import { CardTagMenu } from "./CardContextMenu";

const COLUMN_MIN_WIDTH = 240;
const GAP = 32;

const supportsGridLanes = typeof CSS !== "undefined" && CSS.supports("display", "grid-lanes");

interface GridProps {
  blocks: LightBlock[];
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  scrollToTop: number;
  sidebarCollapsed?: boolean;
  focusedBlockId?: number | null;
  onBlockClick: (block: LightBlock) => void;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onDeleteBlock: (slug: string) => void;
  onColumnCountChange?: (count: number) => void;
}

interface GridContext {
  vaultPath: string;
  focusedBlockId?: number | null;
  onBlockClick: (block: LightBlock) => void;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestDelete: (slug: string) => void;
}

export function Grid({
  blocks,
  vaultPath,
  tags,
  currentTag,
  scrollToTop,
  sidebarCollapsed = false,
  focusedBlockId,
  onBlockClick,
  onToggleTag,
  onCreateAndAssign,
  onDeleteBlock,
  onColumnCountChange,
}: GridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [parentWidth, setParentWidth] = useState(0);
  const [blockToDelete, setBlockToDelete] = useState<string | null>(null);
  const [menuBlock, setMenuBlock] = useState<LightBlock | null>(null);

  // Scroll to top only on explicit signal (same-channel click)
  // Scroll to top on explicit signal OR channel change
  useEffect(() => {
    parentRef.current?.scrollTo(0, 0);
  }, [scrollToTop, currentTag]);

  // Measure parent width (needed for column count in Virtuoso mode)
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry && entry.contentRect.width > 0) setParentWidth(entry.contentRect.width);
    });

    setParentWidth(el.clientWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const columnCount = Math.max(
    1,
    Math.floor((parentWidth + GAP) / (COLUMN_MIN_WIDTH + GAP)),
  );

  useEffect(() => {
    onColumnCountChange?.(columnCount);
  }, [columnCount, onColumnCountChange]);

  // O(1) block lookup for context menu event delegation
  const blocksBySlug = useMemo(
    () => new Map(blocks.map((b) => [b.slug, b])),
    [blocks],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const el = (e.target as HTMLElement).closest("[data-block-slug]");
      if (!el) {
        e.preventDefault();
        return;
      }
      const slug = el.getAttribute("data-block-slug")!;
      const block = blocksBySlug.get(slug);
      if (block) {
        setMenuBlock(block);
      } else {
        e.preventDefault();
      }
    },
    [blocksBySlug],
  );

  const handleRequestDelete = useCallback((slug: string) => {
    setBlockToDelete(slug);
  }, []);

  const gridContext: GridContext = useMemo(
    () => ({ vaultPath, focusedBlockId, onBlockClick, tags, currentTag, onToggleTag, onCreateAndAssign, onRequestDelete: handleRequestDelete }),
    [vaultPath, focusedBlockId, onBlockClick, tags, currentTag, onToggleTag, onCreateAndAssign, handleRequestDelete],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={parentRef}
          onContextMenu={handleContextMenu}
          className="h-full overflow-x-hidden overflow-y-auto pb-8 pt-16"
          style={{
            paddingLeft: sidebarCollapsed ? 72 : 32,
            paddingRight: sidebarCollapsed ? 72 : 32,
            transition: "padding-left 200ms ease, padding-right 200ms ease",
          }}
          data-grid-scroll
        >
          {supportsGridLanes ? (
            <GridLanesLayout key={currentTag ?? "__all__"} blocks={blocks} context={gridContext} />
          ) : (
            parentWidth > 0 && (
              <VirtuosoMasonryLayout
                key={currentTag ?? "__all__"}
                blocks={blocks}
                columnCount={columnCount}
                context={gridContext}
              />
            )
          )}
        </div>
      </ContextMenuTrigger>

      {menuBlock && (
        <CardTagMenu
          block={menuBlock}
          tags={tags}
          currentTag={currentTag}
          onToggleTag={onToggleTag}
          onCreateAndAssign={onCreateAndAssign}
          onRequestDelete={handleRequestDelete}
        />
      )}

      <AlertDialog
        open={blockToDelete !== null}
        onOpenChange={(open) => { if (!open) setBlockToDelete(null); }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete card</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the card and its files.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                console.log("[GRID] AlertDialog confirm delete:", blockToDelete);
                if (blockToDelete) onDeleteBlock(blockToDelete);
                setBlockToDelete(null);
                console.log("[GRID] blockToDelete cleared");
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ContextMenu>
  );
}

// ── CSS Grid Lanes (WebKit/Safari 26.4+) ────────────────────────────────────

function GridLanesLayout({
  blocks,
  context,
}: {
  blocks: LightBlock[];
  context: GridContext;
}) {
  return (
    <div
      style={{
        display: "grid-lanes" as string,
        gridTemplateColumns: `repeat(auto-fill, minmax(${COLUMN_MIN_WIDTH}px, 1fr))`,
        gap: GAP,
      }}
    >
      {blocks.map((block, idx) => (
        <div
          key={block.id}
          style={{
            contentVisibility: "auto",
            containIntrinsicSize: "auto 200px",
          }}
        >
          <Card
            block={block}
            vaultPath={context.vaultPath}
            isFocused={block.id === context.focusedBlockId}
            priority={idx < 12}
            onClick={context.onBlockClick}
            tags={context.tags}
            currentTag={context.currentTag}
            onToggleTag={context.onToggleTag}
            onCreateAndAssign={context.onCreateAndAssign}
            onRequestDelete={context.onRequestDelete}
          />
        </div>
      ))}
    </div>
  );
}

// ── VirtuosoMasonry (Chrome/Firefox fallback) ───────────────────────────────

function VirtuosoMasonryLayout({
  blocks,
  columnCount,
  context,
}: {
  blocks: LightBlock[];
  columnCount: number;
  context: GridContext;
}) {
  return (
    <VirtuosoMasonry
      data={blocks}
      columnCount={columnCount}
      ItemContent={VirtuosoCardItem}
      context={context}
      style={{ gap: GAP }}
    />
  );
}

const VirtuosoCardItem = memo(function VirtuosoCardItem({
  data,
  context,
}: {
  data: LightBlock;
  context: GridContext;
}) {
  if (!data) return null;
  return (
    <div style={{ paddingBottom: GAP }}>
      <Card
        block={data}
        vaultPath={context.vaultPath}
        isFocused={data.id === context.focusedBlockId}
        onClick={context.onBlockClick}
        tags={context.tags}
        currentTag={context.currentTag}
        onToggleTag={context.onToggleTag}
        onCreateAndAssign={context.onCreateAndAssign}
        onRequestDelete={context.onRequestDelete}
      />
    </div>
  );
});
