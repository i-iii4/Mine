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
import type { LightBlock, TagCount } from "@/types";
import { Card } from "./Card";
import { CardTagMenu } from "./CardContextMenu";
import {
  computeMasonryLayout,
  getVisibleMasonryItems,
  type MasonryPosition,
} from "@/lib/masonryLayout";

const COLUMN_MIN_WIDTH = 240;
const GAP = 32;
const OVERSCAN_PX = 1200;
const DEFAULT_CARD_HEIGHT = 240;

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

function estimateCardHeight(block: LightBlock, columnWidth: number): number {
  switch (block.block_type) {
    case "image":
      if (block.width && block.height && block.width > 0) {
        return Math.max(120, Math.round(columnWidth * (block.height / block.width)));
      }
      return columnWidth;
    case "video":
      return Math.round(columnWidth * 9 / 16);
    case "link":
      return Math.round(columnWidth * 9 / 16) + 76;
    case "file":
      return 88;
    case "article": {
      const titleLength = block.title?.length ?? block.slug.length;
      const titleLines = Math.min(2, Math.max(1, Math.ceil(titleLength / 26)));
      const previewChars = Math.min(400, block.body.length);
      const charsPerLine = Math.max(18, Math.floor(columnWidth / 7));
      const previewLines = Math.min(
        block.first_image ? 3 : 8,
        Math.max(2, Math.ceil(previewChars / charsPerLine)),
      );
      const imageHeight = block.first_image ? Math.round(columnWidth * 0.62) + 12 : 0;
      return 32 + titleLines * 20 + previewLines * 18 + imageHeight + (block.author ? 24 : 0) + 28;
    }
    default:
      return DEFAULT_CARD_HEIGHT;
  }
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
  const scrollRafRef = useRef<number | null>(null);
  const [parentWidth, setParentWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [blockToDelete, setBlockToDelete] = useState<string | null>(null);
  const [menuBlock, setMenuBlock] = useState<LightBlock | null>(null);
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>({});

  useEffect(() => {
    parentRef.current?.scrollTo(0, 0);
    setScrollTop(0);
    setMeasuredHeights({});
  }, [scrollToTop, currentTag]);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      if (entry.contentRect.width > 0) setParentWidth(entry.contentRect.width);
      if (entry.contentRect.height > 0) setViewportHeight(entry.contentRect.height);
    });

    setParentWidth(el.clientWidth);
    setViewportHeight(el.clientHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  const estimatedHeights = useMemo(() => {
    const provisionalColumnCount = Math.max(
      1,
      Math.floor((parentWidth + GAP) / (COLUMN_MIN_WIDTH + GAP)),
    );
    const columnWidth = Math.max(
      1,
      (Math.max(0, parentWidth - GAP * (provisionalColumnCount - 1))) / provisionalColumnCount,
    );
    return blocks.map((block) => measuredHeights[block.slug] ?? estimateCardHeight(block, columnWidth));
  }, [blocks, measuredHeights, parentWidth]);

  const layout = useMemo(
    () => computeMasonryLayout(estimatedHeights, parentWidth, COLUMN_MIN_WIDTH, GAP),
    [estimatedHeights, parentWidth],
  );

  useEffect(() => {
    onColumnCountChange?.(layout.columnCount);
  }, [layout.columnCount, onColumnCountChange]);

  const visibleItems = useMemo(
    () => getVisibleMasonryItems(layout.positions, scrollTop, viewportHeight, OVERSCAN_PX),
    [layout.positions, scrollTop, viewportHeight],
  );

  const blocksBySlug = useMemo(
    () => new Map(blocks.map((block) => [block.slug, block])),
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

  const handleMeasure = useCallback((slug: string, height: number) => {
    setMeasuredHeights((prev) => {
      if (Math.abs((prev[slug] ?? 0) - height) < 1) return prev;
      return { ...prev, [slug]: height };
    });
  }, []);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const nextScrollTop = e.currentTarget.scrollTop;
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      setScrollTop(nextScrollTop);
    });
  }, []);

  const gridContext: GridContext = useMemo(
    () => ({
      vaultPath,
      focusedBlockId,
      onBlockClick,
      tags,
      currentTag,
      onToggleTag,
      onCreateAndAssign,
      onRequestDelete: handleRequestDelete,
    }),
    [vaultPath, focusedBlockId, onBlockClick, tags, currentTag, onToggleTag, onCreateAndAssign, handleRequestDelete],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={parentRef}
          onScroll={handleScroll}
          onContextMenu={handleContextMenu}
          className="h-full overflow-x-hidden overflow-y-auto pb-8 pt-16"
          style={{
            paddingLeft: sidebarCollapsed ? 72 : 32,
            paddingRight: sidebarCollapsed ? 72 : 32,
            transition: "padding-left 200ms ease, padding-right 200ms ease",
          }}
          data-grid-scroll
        >
          {parentWidth > 0 && blocks.length > 0 && (
            <VirtualMasonryLayout
              key={currentTag ?? "__all__"}
              blocks={blocks}
              visibleItems={visibleItems}
              totalHeight={layout.totalHeight}
              context={gridContext}
              onMeasure={handleMeasure}
            />
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

function VirtualMasonryLayout({
  blocks,
  visibleItems,
  totalHeight,
  context,
  onMeasure,
}: {
  blocks: LightBlock[];
  visibleItems: MasonryPosition[];
  totalHeight: number;
  context: GridContext;
  onMeasure: (slug: string, height: number) => void;
}) {
  return (
    <div className="relative" style={{ height: totalHeight || 1 }}>
      {visibleItems.map((item) => {
        const block = blocks[item.index];
        if (!block) return null;
        return (
          <MeasuredGridItem
            key={block.id}
            block={block}
            item={item}
            context={context}
            onMeasure={onMeasure}
          />
        );
      })}
    </div>
  );
}

const MeasuredGridItem = memo(function MeasuredGridItem({
  block,
  item,
  context,
  onMeasure,
}: {
  block: LightBlock;
  item: MasonryPosition;
  context: GridContext;
  onMeasure: (slug: string, height: number) => void;
}) {
  const observerRef = useRef<ResizeObserver | null>(null);

  const handleNode = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;

    if (!node) return;

    onMeasure(block.slug, node.getBoundingClientRect().height);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        onMeasure(block.slug, entry.contentRect.height);
      }
    });
    observer.observe(node);
    observerRef.current = observer;
  }, [block.slug, onMeasure]);

  useEffect(() => {
    return () => observerRef.current?.disconnect();
  }, []);

  return (
    <div
      style={{
        position: "absolute",
        width: item.width,
        transform: `translate(${item.left}px, ${item.top}px)`,
      }}
    >
      <div ref={handleNode}>
        <Card
          block={block}
          vaultPath={context.vaultPath}
          isFocused={block.id === context.focusedBlockId}
          priority={item.index < 12}
          onClick={context.onBlockClick}
          tags={context.tags}
          currentTag={context.currentTag}
          onToggleTag={context.onToggleTag}
          onCreateAndAssign={context.onCreateAndAssign}
          onRequestDelete={context.onRequestDelete}
        />
      </div>
    </div>
  );
});
