import { useDraggable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { useChromeDragGesture } from "@/hooks/useChromeDragGesture";
import type { IndexedBlock, LightBlock, TagCount, VaultStats } from "@/types";
import { CardMoreMenu } from "./CardHoverMenu";
import { ChromeCloseButton } from "./ChromeCloseButton";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "./ui/segmented-control";

export type DetailLinkMode = "all" | "linked";
export type MainViewMode = "grid" | "graph";

const DETAIL_LINK_MODE_OPTIONS: SegmentedControlOption<DetailLinkMode>[] = [
  { value: "all", label: "All" },
  { value: "linked", label: "Connected" },
];

const MAIN_VIEW_MODE_OPTIONS: SegmentedControlOption<MainViewMode>[] = [
  { value: "grid", label: "Grid" },
  { value: "graph", label: "Graph" },
];

const MAIN_VIEW_MODE_STORAGE_KEY = "mine.mainViewMode";
const RU_INTEGER_FORMATTER = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 0,
});
const STORAGE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function getStoredMainViewMode(): MainViewMode {
  return window.localStorage.getItem(MAIN_VIEW_MODE_STORAGE_KEY) === "graph" ? "graph" : "grid";
}

export function persistMainViewMode(mode: MainViewMode) {
  window.localStorage.setItem(MAIN_VIEW_MODE_STORAGE_KEY, mode);
}

function formatCompactCount(count: number, label: string): string {
  return `${RU_INTEGER_FORMATTER.format(count)} ${label}`;
}

function formatPluralCount(count: number, singular: string, plural: string): string {
  return `${RU_INTEGER_FORMATTER.format(count)} ${count === 1 ? singular : plural}`;
}

function formatStorageBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < STORAGE_UNITS.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  const formatter = new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: value > 0 && value < 10 && unitIndex > 0 ? 1 : 0,
    minimumFractionDigits: 0,
  });
  return `${formatter.format(value)} ${STORAGE_UNITS[unitIndex]!}`;
}

function MainSecondaryStatsLeft({
  stats,
  sidebarCollapsed,
}: {
  stats: VaultStats | null;
  sidebarCollapsed: boolean;
}) {
  if (sidebarCollapsed) return null;

  return (
    <div
      data-main-secondary-stats-left=""
      className="flex h-full min-w-0 items-center overflow-hidden px-[var(--main-secondary-pad-x)] font-mono text-sm leading-none text-tertiary-foreground"
    >
      {stats && (
        <div className="flex min-w-0 items-center gap-5 overflow-hidden whitespace-nowrap">
          <span data-main-secondary-stat-atom="files" className="shrink-0">
            {formatPluralCount(stats.totalFileCount, "file", "files")}
          </span>
          <span data-main-secondary-stat-atom="markdown" className="shrink-0">
            {formatCompactCount(stats.markdownFileCount, ".md")}
          </span>
          <span data-main-secondary-stat-atom="media" className="shrink-0">
            {formatCompactCount(stats.mediaFileCount, "media")}
          </span>
          <span data-main-secondary-stat-atom="storage" className="shrink-0">
            {formatStorageBytes(stats.sourceBytes)}
          </span>
        </div>
      )}
    </div>
  );
}

function MainSecondaryStatsRight({
  stats,
  viewMode,
  onViewModeChange,
}: {
  stats: VaultStats | null;
  viewMode: MainViewMode;
  onViewModeChange: (value: MainViewMode) => void;
}) {
  const inCollection = Boolean(stats?.currentCollection);
  const cardCount = stats
    ? `${formatPluralCount(stats.currentCollectionCardCount, "element", "elements")}${inCollection ? " in collection" : ""}`
    : "";

  return (
    <div
      data-main-secondary-stats-right=""
      className="flex h-full min-w-0 items-center justify-start gap-5 overflow-hidden px-[var(--main-secondary-pad-x)] font-mono text-sm leading-none text-tertiary-foreground"
    >
      {stats && (
        <span className="min-w-0 truncate whitespace-nowrap" title={cardCount}>
          {cardCount}
        </span>
      )}
      <div className="flex shrink-0 items-center gap-2" data-main-view-mode-switcher="">
        <span className="shrink-0 font-mono text-sm text-tertiary-foreground">View:</span>
        <MainViewModeSwitch value={viewMode} onChange={onViewModeChange} entered />
      </div>
    </div>
  );
}

export function MainSecondaryTopBar({
  sidebarCollapsed,
  sidebarResizing,
  stats,
  detailBlock,
  detailTitle,
  detailEntered,
  detailLinkMode,
  onDetailLinkModeChange,
  viewMode,
  onViewModeChange,
  vaultPath,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
  onDetailClose,
  detailMenuOpenRequestSequence,
}: {
  sidebarCollapsed: boolean;
  sidebarResizing: boolean;
  stats: VaultStats | null;
  detailBlock?: LightBlock | IndexedBlock | null;
  detailTitle?: string;
  detailEntered?: boolean;
  detailLinkMode: DetailLinkMode;
  onDetailLinkModeChange: (value: DetailLinkMode) => void;
  viewMode: MainViewMode;
  onViewModeChange: (value: MainViewMode) => void;
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestRename: (block: LightBlock | IndexedBlock) => void;
  onRequestDelete: (slug: string) => void;
  onDetailClose: () => void;
  detailMenuOpenRequestSequence: number;
}) {
  const detailLayerEntered = Boolean(detailBlock && detailEntered);
  const mainLayerEntered = !detailLayerEntered;
  const closeChromeGesture = useChromeDragGesture({ disabled: !detailBlock });
  const {
    attributes: dragAttributes,
    listeners: dragListeners,
    setNodeRef: setDragHandleRef,
    isDragging,
  } = useDraggable({
    id: `detail-secondary:${detailBlock?.slug ?? "__empty__"}`,
    disabled: !detailBlock,
    data: detailBlock
      ? { type: "block", slug: detailBlock.slug, block: detailBlock }
      : undefined,
  });

  return (
    <div
      data-tauri-drag-region
      data-main-secondary-top-bar=""
      className={cn(
        "flex h-8 shrink-0 items-center border-b border-border transition-colors duration-[170ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
        detailLayerEntered ? "bg-accent" : "bg-background",
      )}
    >
      <div
        data-tauri-drag-region
        data-main-secondary-top-bar-sidebar-segment=""
        className={cn(
          "relative flex h-full shrink-0 items-center overflow-hidden border-r border-sidebar-border",
          sidebarCollapsed && "w-auto max-w-[240px]",
          !sidebarResizing && "transition-[width] duration-200 ease-out motion-reduce:transition-none",
        )}
        style={sidebarCollapsed ? undefined : { width: "var(--sidebar-width)" }}
      >
        <div
          className="main-secondary-bar-layer absolute inset-0"
          data-entered={mainLayerEntered ? "true" : "false"}
          data-main-secondary-main-layer=""
        >
          <MainSecondaryStatsLeft stats={stats} sidebarCollapsed={sidebarCollapsed} />
        </div>
        {detailBlock && !sidebarCollapsed && (
          <div
            className="main-secondary-bar-layer absolute inset-0 flex h-full min-w-0 items-center gap-2 px-[var(--main-secondary-pad-x)]"
            data-entered={detailLayerEntered ? "true" : "false"}
            data-secondary-sidebar-link-mode-bar=""
          >
            <span className="shrink-0 font-mono text-sm text-muted-foreground">Collections:</span>
            <CompactDetailLinkModeSwitch
              value={detailLinkMode}
              onChange={onDetailLinkModeChange}
              chromeDragEnabled={false}
              entered={detailEntered}
            />
          </div>
        )}
      </div>
      <div
        data-tauri-drag-region
        data-main-secondary-top-bar-content-segment=""
        className="relative flex h-full min-w-0 flex-1 items-center overflow-hidden"
      >
        <div
          className="main-secondary-bar-layer absolute inset-0"
          data-entered={mainLayerEntered ? "true" : "false"}
          data-main-secondary-main-layer=""
        >
          <MainSecondaryStatsRight
            stats={stats}
            viewMode={viewMode}
            onViewModeChange={onViewModeChange}
          />
        </div>
        {detailBlock && (
          <div
            className="main-secondary-bar-layer absolute inset-0 flex h-full min-w-0 flex-1 items-center gap-3 px-[var(--edge-rhythm,32px)]"
            data-entered={detailLayerEntered ? "true" : "false"}
            data-secondary-detail-top-menu=""
          >
            <div
              ref={setDragHandleRef}
              {...dragAttributes}
              {...dragListeners}
              className={cn(
                "min-w-0 flex-1 cursor-grab truncate font-mono text-sm text-muted-foreground active:cursor-grabbing",
                isDragging && "opacity-30",
              )}
              title={detailTitle}
              data-secondary-detail-drag-handle=""
            >
              {detailTitle}
            </div>
            <CardMoreMenu
              block={detailBlock}
              vaultPath={vaultPath}
              tags={tags}
              currentTag={currentTag}
              onToggleTag={onToggleTag}
              onCreateAndAssign={onCreateAndAssign}
              onRequestRename={onRequestRename}
              onRequestDelete={onRequestDelete}
              triggerVariant="ghost"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              openRequestSequence={detailMenuOpenRequestSequence}
              topChromeInteraction
            />
            <ChromeCloseButton {...closeChromeGesture} onClick={onDetailClose} />
          </div>
        )}
      </div>
    </div>
  );
}

export function CompactDetailLinkModeSwitch({
  value,
  onChange,
  chromeDragEnabled = true,
  entered,
  className,
}: {
  value: DetailLinkMode;
  onChange: (value: DetailLinkMode) => void;
  chromeDragEnabled?: boolean;
  entered?: boolean;
  className?: string;
}) {
  const chromeGesture = useChromeDragGesture({ disabled: !chromeDragEnabled });

  return (
    <SegmentedControl
      {...chromeGesture}
      value={value}
      options={DETAIL_LINK_MODE_OPTIONS}
      onChange={onChange}
      aria-label="Collection filter"
      data-entered={entered === undefined ? undefined : entered ? "true" : "false"}
      data-compact-detail-link-mode-control=""
      className={className}
    />
  );
}

function MainViewModeSwitch({
  value,
  onChange,
  entered,
  className,
}: {
  value: MainViewMode;
  onChange: (value: MainViewMode) => void;
  entered?: boolean;
  className?: string;
}) {
  return (
    <SegmentedControl
      value={value}
      options={MAIN_VIEW_MODE_OPTIONS}
      onChange={onChange}
      aria-label="View mode"
      data-entered={entered === undefined ? undefined : entered ? "true" : "false"}
      data-main-view-mode-control=""
      className={className}
    />
  );
}

/// The card title in the compact top menu is the block's drag handle, exactly
/// as the filename is in the classic Detail header.
///
/// It used to be a `data-tauri-drag-region` instead, which silently swapped
/// the gesture's meaning with the chrome mode: the same grab that dragged the
/// card into a collection under the classic header started dragging the
/// window under the compact one. The window keeps its drag surface on the
/// header's empty stretches; the card's identity stays draggable everywhere
/// it is shown.
function CompactDetailCardTitleDragHandle({
  block,
  cardTitle,
}: {
  block: LightBlock | IndexedBlock;
  cardTitle: string;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `detail:${block.slug}`,
    data: {
      type: "block",
      slug: block.slug,
      block,
    },
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        "min-w-0 flex-1 cursor-grab truncate pl-0 pr-3 font-mono text-sm text-muted-foreground active:cursor-grabbing",
        isDragging && "opacity-30",
      )}
      title={cardTitle}
      data-compact-detail-card-title=""
      data-detail-drag-handle
    >
      {cardTitle}
    </div>
  );
}

export function CompactDetailTopMenu({
  block,
  cardTitle,
  vaultPath,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
  onClose,
  menuOpenRequestSequence,
  entered,
}: {
  block: LightBlock | IndexedBlock;
  cardTitle: string;
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestRename: (block: LightBlock | IndexedBlock) => void;
  onRequestDelete: (slug: string) => void;
  onClose: () => void;
  menuOpenRequestSequence: number;
  entered: boolean;
}) {
  const closeChromeGesture = useChromeDragGesture();

  return (
    <div
      className="detail-top-bar-enter flex h-full min-w-0 flex-1 items-center pr-3"
      data-entered={entered ? "true" : "false"}
      data-compact-detail-top-menu=""
    >
      <CompactDetailCardTitleDragHandle block={block} cardTitle={cardTitle} />
      <CardMoreMenu
        block={block}
        vaultPath={vaultPath}
        tags={tags}
        currentTag={currentTag}
        onToggleTag={onToggleTag}
        onCreateAndAssign={onCreateAndAssign}
        onRequestRename={onRequestRename}
        onRequestDelete={onRequestDelete}
        triggerVariant="ghost"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        openRequestSequence={menuOpenRequestSequence}
        topChromeInteraction
      />
      <ChromeCloseButton {...closeChromeGesture} onClick={onClose} />
    </div>
  );
}
