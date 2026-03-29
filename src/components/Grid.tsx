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
  useEffect(() => {
    if (scrollToTop > 0) {
      parentRef.current?.scrollTo(0, 0);
    }
  }, [scrollToTop]);

  // Measure parent width (needed for column count in Virtuoso mode)
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setParentWidth(entry.contentRect.width);
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

  const gridContext: GridContext = useMemo(
    () => ({ vaultPath, focusedBlockId, onBlockClick }),
    [vaultPath, focusedBlockId, onBlockClick],
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
            <GridLanesLayout blocks={blocks} context={gridContext} />
          ) : (
            parentWidth > 0 && (
              <VirtuosoMasonryLayout
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
          onRequestDelete={setBlockToDelete}
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
                if (blockToDelete) onDeleteBlock(blockToDelete);
                setBlockToDelete(null);
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
      {blocks.map((block) => (
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
            onClick={context.onBlockClick}
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
      style={{ columnGap: GAP }}
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
  return (
    <div style={{ paddingBottom: GAP }}>
      <Card
        block={data}
        vaultPath={context.vaultPath}
        isFocused={data.id === context.focusedBlockId}
        onClick={context.onBlockClick}
      />
    </div>
  );
});
