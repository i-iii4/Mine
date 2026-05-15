import {
  useState,
  useRef,
  useCallback,
  useEffect,
  memo,
  forwardRef,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { NavLink, useLocation } from "react-router";
import { useDndContext, useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
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
import type { IndexedBlock, LightBlock, TagCount, PreviewCard } from "@/types";
import { getBlock } from "@/lib/commands";
import { collectionRefLabel } from "@/lib/collections";
import { getHoverPreviewOpenDelay } from "@/lib/hoverPreviewTiming";
import { cn } from "@/lib/utils";
import { ReadOnlyCardPreview } from "./Card";
import { MicroPreviewThumbnail, microPreviewFromPreviewCard } from "./MicroPreviewThumbnail";

const SIDEBAR_PREVIEW_WIDTH = 240;
const SIDEBAR_PREVIEW_FALLBACK_HEIGHT = 320;
const SIDEBAR_PREVIEW_GAP = 8;
const SIDEBAR_PREVIEW_VIEWPORT_MARGIN = 16;
const SIDEBAR_ROW_TITLE_COLUMN_WIDTH = 150;
const SIDEBAR_PREVIEW_DIVIDER_GAP = 4;
const SIDEBAR_ROW_ACTION_BUTTON_WIDTH = 80;
const SIDEBAR_ROW_ACTION_BUTTON_GAP = 8;
const SIDEBAR_ROW_RIGHT_GUIDELINE_OFFSET =
  SIDEBAR_ROW_ACTION_BUTTON_WIDTH + SIDEBAR_ROW_ACTION_BUTTON_GAP;
const SIDEBAR_ROW_TEXT_MASK_FADE_WIDTH = 24;
const SIDEBAR_PREVIEW_MASK_FADE_WIDTH = 24;
const SIDEBAR_PREVIEW_MASK_CLEAR_TAIL_WIDTH =
  SIDEBAR_ROW_RIGHT_GUIDELINE_OFFSET + SIDEBAR_PREVIEW_DIVIDER_GAP;
const SIDEBAR_ROW_ACTION_BUTTON_CLASS =
  "inline-flex h-6 cursor-pointer items-center justify-center rounded-1 bg-component-fill px-[1ch] font-sans text-sm font-semibold text-foreground outline-0 outline-transparent hover:outline-1 hover:-outline-offset-1 hover:outline-component-fill-hover focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-component-fill-hover";
const createRightFadeMaskStyle = (fadeWidth: number, clearTailWidth: number) => {
  const rightFadeMaskStop = (alpha: number, progress: number) => {
    const offset =
      clearTailWidth
      + Math.round(fadeWidth * (1 - progress) * 100) / 100;
    return `rgba(0, 0, 0, ${alpha}) calc(100% - ${offset}px)`;
  };
  const stops = [
    "rgba(0, 0, 0, 1) 0%",
    `rgba(0, 0, 0, 1) calc(100% - ${clearTailWidth + fadeWidth}px)`,
    rightFadeMaskStop(0.82, 0.14),
    rightFadeMaskStop(0.64, 0.24),
    rightFadeMaskStop(0.49, 0.33),
    rightFadeMaskStop(0.36, 0.45),
    rightFadeMaskStop(0.25, 0.57),
    rightFadeMaskStop(0.16, 0.69),
    rightFadeMaskStop(0.09, 0.81),
    rightFadeMaskStop(0.04, 0.9),
    rightFadeMaskStop(0.01, 0.97),
    `rgba(0, 0, 0, 0) calc(100% - ${clearTailWidth}px)`,
    "rgba(0, 0, 0, 0) 100%",
  ].join(", ");
  const gradient = `linear-gradient(to right, ${stops})`;
  return {
    maskImage: gradient,
    WebkitMaskImage: gradient,
  } as CSSProperties;
};
const SIDEBAR_ROW_TEXT_MASK_STYLE = createRightFadeMaskStyle(
  SIDEBAR_ROW_TEXT_MASK_FADE_WIDTH,
  SIDEBAR_PREVIEW_DIVIDER_GAP,
);
const SIDEBAR_PREVIEW_MASK_STYLE = createRightFadeMaskStyle(
  SIDEBAR_PREVIEW_MASK_FADE_WIDTH,
  SIDEBAR_PREVIEW_MASK_CLEAR_TAIL_WIDTH,
);

type SidebarPreviewTarget = {
  key: string;
  rowKey: string;
  slug: string;
};

type SidebarPreviewPosition = {
  top: number;
  left: number;
};

type SidebarKeyboardNavigationFocus = {
  rowKey: string;
  sequence: number;
};

interface SidebarProps {
  width: number;
  collapsed: boolean;
  isResizing: boolean;
  vaultPath?: string;
  thumbsRootPath?: string;
  tags?: TagCount[];
  currentTag?: string;
  orderedTags: TagCount[];
  channelPreviews: Map<string, PreviewCard[]>;
  totalBlocks: number;
  isDropDragging: boolean;
  isCreatingChannel: boolean;
  onSetCreatingChannel: (v: boolean) => void;
  onDeleteTag: (tag: string) => void;
  onRenameTag: (oldTag: string, newTag: string) => void;
  onCreateChannel: (tag: string) => void;
  onOpenBlock?: (block: IndexedBlock) => void;
  onToggleTag?: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign?: (tag: string, blockSlug: string) => void;
  onRequestRename?: (block: LightBlock) => void;
  onRequestDelete?: (slug: string) => void;
  onNavClick?: () => void;
  onScrollToTop?: () => void;
  keyboardNavigationFocus?: SidebarKeyboardNavigationFocus | null;
  /** Optional slot for a header banner (e.g. iCloud conflict surface). */
  headerSlot?: React.ReactNode;
  linkedBlockSlug?: string | null;
  linkedTags?: string[];
  onToggleLinkedTag?: (slug: string, tag: string, hasTag: boolean) => void;
  detailChromeClosing?: boolean;
}

function buildSidebarRowOrder(visibleTags: TagCount[], includeCreateRow = false): string[] {
  const rowKeys = ["all", ...visibleTags.map((tc) => `tag:${tc.tag}`)];
  if (includeCreateRow) {
    rowKeys.push("create-channel");
  }
  return rowKeys;
}

function createSidebarSeamAccentSet(
  orderedRowKeys: string[],
  focusedRowKey: string | null,
): Set<string> {
  if (!focusedRowKey) return new Set();
  const focusedIndex = orderedRowKeys.indexOf(focusedRowKey);
  if (focusedIndex === -1) return new Set();
  const accentKeys = new Set<string>([focusedRowKey]);
  if (focusedIndex > 0) {
    accentKeys.add(orderedRowKeys[focusedIndex - 1]!);
  }
  return accentKeys;
}

export function Sidebar({
  width,
  collapsed,
  isResizing,
  vaultPath,
  thumbsRootPath,
  orderedTags,
  channelPreviews,
  totalBlocks,
  isDropDragging,
  isCreatingChannel,
  onSetCreatingChannel,
  onDeleteTag,
  onRenameTag,
  onCreateChannel,
  onOpenBlock,
  onNavClick,
  onScrollToTop,
  keyboardNavigationFocus,
  headerSlot,
  linkedBlockSlug,
  linkedTags = [],
  onToggleLinkedTag,
  detailChromeClosing = false,
}: SidebarProps) {
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [linkMode, setLinkMode] = useState<"all" | "linked">("all");
  const navRef = useRef<HTMLElement>(null);
  const previewTriggerRefs = useRef(new Map<string, HTMLElement>());
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewOpenTimerRef = useRef<number | null>(null);
  const previewCloseTimerRef = useRef<number | null>(null);
  const lastPreviewOpenedAtRef = useRef<number | null>(null);
  const sidebarRowSwitchFrameRef = useRef<number | null>(null);
  const sidebarKeyboardFocusTimerRef = useRef<number | null>(null);
  const sidebarRowFocusKeyRef = useRef<string | null>(null);
  const sidebarRowFocusModeRef = useRef(false);
  const [hoveredPreview, setHoveredPreview] = useState<SidebarPreviewTarget | null>(null);
  const [hoverPreviewBlock, setHoverPreviewBlock] = useState<IndexedBlock | null>(null);
  const [hoverPreviewPosition, setHoverPreviewPosition] = useState<SidebarPreviewPosition | null>(null);
  const [sidebarRowFocusKey, setSidebarRowFocusKey] = useState<string | null>(null);
  const [sidebarRowFocusMode, setSidebarRowFocusMode] = useState(false);
  const [sidebarRowSwitching, setSidebarRowSwitching] = useState(false);
  const location = useLocation();
  const { over } = useDndContext();

  // Auto-scroll sidebar to the active channel (e.g. after Opt+Cmd+Arrow)
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const active = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (active) {
      scrollActiveSidebarItemIntoView(nav, active);
    }
  }, [location.pathname]);

  const handleRename = useCallback(
    (oldTag: string, newValue: string) => {
      const trimmed = newValue.trim();
      if (trimmed) onRenameTag(oldTag, trimmed);
      setEditingTag(null);
    },
    [onRenameTag],
  );

  const compact = width > 0 && width < 320;
  const isLinkingBlock = !!linkedBlockSlug && !!onToggleLinkedTag;
  const isLinkEditorActive = isLinkingBlock && !detailChromeClosing;
  const linkedTagSet = new Set(linkedTags);
  const visibleTags = isLinkEditorActive && linkMode === "linked"
    ? orderedTags.filter((tc) => linkedTagSet.has(tc.tag))
    : orderedTags;
  const editingRowKey = !isLinkEditorActive && editingTag !== null
    ? `tag:${editingTag}`
    : isCreatingChannel
      ? "create-channel"
      : null;
  const orderedRowKeys = buildSidebarRowOrder(visibleTags, true);
  const activePreviewRowKey = hoveredPreview?.rowKey ?? null;
  const overId = isDropDragging && over?.id != null ? String(over.id) : null;
  const dropOverRowKey = overId?.startsWith("tag:")
    ? overId
    : overId === "create-channel"
      ? "create-channel"
      : null;
  const effectiveSidebarRowFocusKey = editingRowKey ?? dropOverRowKey ?? (sidebarRowFocusMode
    ? sidebarRowFocusKey
    : activePreviewRowKey);
  const hasSidebarRowFocusMode = editingRowKey !== null || dropOverRowKey !== null || sidebarRowFocusMode || activePreviewRowKey !== null;
  const seamAccentKeys = createSidebarSeamAccentSet(
    orderedRowKeys,
    effectiveSidebarRowFocusKey,
  );
  const linkEditorNavPadding = "pt-8";
  const [linkChromeEntered, setLinkChromeEntered] = useState(false);

  const setPreviewTriggerRef = useCallback((key: string, node: HTMLElement | null) => {
    if (node) {
      previewTriggerRefs.current.set(key, node);
    } else {
      previewTriggerRefs.current.delete(key);
    }
  }, []);

  const clearPreviewOpenTimer = useCallback(() => {
    if (previewOpenTimerRef.current !== null) {
      window.clearTimeout(previewOpenTimerRef.current);
      previewOpenTimerRef.current = null;
    }
  }, []);

  const clearPreviewCloseTimer = useCallback(() => {
    if (previewCloseTimerRef.current !== null) {
      window.clearTimeout(previewCloseTimerRef.current);
      previewCloseTimerRef.current = null;
    }
  }, []);

  const clearSidebarRowSwitchFrame = useCallback(() => {
    if (sidebarRowSwitchFrameRef.current !== null) {
      window.cancelAnimationFrame(sidebarRowSwitchFrameRef.current);
      sidebarRowSwitchFrameRef.current = null;
    }
  }, []);

  const clearSidebarKeyboardFocusTimer = useCallback(() => {
    if (sidebarKeyboardFocusTimerRef.current !== null) {
      window.clearTimeout(sidebarKeyboardFocusTimerRef.current);
      sidebarKeyboardFocusTimerRef.current = null;
    }
  }, []);

  const deactivateSidebarRowFocusMode = useCallback(() => {
    clearSidebarRowSwitchFrame();
    clearSidebarKeyboardFocusTimer();
    sidebarRowFocusKeyRef.current = null;
    sidebarRowFocusModeRef.current = false;
    setSidebarRowSwitching(false);
    setSidebarRowFocusKey(null);
    setSidebarRowFocusMode(false);
  }, [clearSidebarKeyboardFocusTimer, clearSidebarRowSwitchFrame]);

  const activateSidebarRowFocus = useCallback((rowKey: string) => {
    const previousKey = sidebarRowFocusKeyRef.current;
    const wasFocusMode = sidebarRowFocusModeRef.current;
    if (wasFocusMode && previousKey === rowKey) {
      return;
    }

    clearSidebarRowSwitchFrame();
    if (wasFocusMode && previousKey !== null) {
      setSidebarRowSwitching(true);
      sidebarRowSwitchFrameRef.current = window.requestAnimationFrame(() => {
        sidebarRowSwitchFrameRef.current = null;
        setSidebarRowSwitching(false);
      });
    } else {
      setSidebarRowSwitching(false);
    }

    sidebarRowFocusKeyRef.current = rowKey;
    sidebarRowFocusModeRef.current = true;
    setSidebarRowFocusKey(rowKey);
    setSidebarRowFocusMode(true);
  }, [clearSidebarRowSwitchFrame]);

  const focusSidebarRowFromTarget = useCallback((target: EventTarget | null, root: HTMLElement) => {
    if (!(target instanceof Element)) {
      deactivateSidebarRowFocusMode();
      return;
    }
    const row = target.closest<HTMLElement>("[data-sidebar-row]");
    if (!row || !root.contains(row)) {
      deactivateSidebarRowFocusMode();
      return;
    }
    const rowKey = row.dataset.sidebarRowKey;
    if (!rowKey) {
      deactivateSidebarRowFocusMode();
      return;
    }
    activateSidebarRowFocus(rowKey);
  }, [activateSidebarRowFocus, deactivateSidebarRowFocusMode]);

  const handleSidebarPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    focusSidebarRowFromTarget(event.target, event.currentTarget);
  }, [focusSidebarRowFromTarget]);

  const handleSidebarFocusCapture = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    focusSidebarRowFromTarget(event.target, event.currentTarget);
  }, [focusSidebarRowFromTarget]);

  const handleSidebarBlurCapture = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget;
    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
      deactivateSidebarRowFocusMode();
    }
  }, [deactivateSidebarRowFocusMode]);

  useEffect(() => {
    if (!keyboardNavigationFocus) return;
    const rowKey = keyboardNavigationFocus.rowKey;
    const rowIsVisible = rowKey === "all" || visibleTags.some((tc) => `tag:${tc.tag}` === rowKey);
    if (!rowIsVisible) return;

    clearSidebarKeyboardFocusTimer();
    activateSidebarRowFocus(rowKey);
    sidebarKeyboardFocusTimerRef.current = window.setTimeout(() => {
      sidebarKeyboardFocusTimerRef.current = null;
      deactivateSidebarRowFocusMode();
    }, 1000);
  }, [keyboardNavigationFocus?.sequence]);

  useEffect(() => () => {
    clearSidebarKeyboardFocusTimer();
  }, [clearSidebarKeyboardFocusTimer]);

  const closePreview = useCallback(() => {
    clearPreviewOpenTimer();
    clearPreviewCloseTimer();
    setHoveredPreview(null);
  }, [clearPreviewCloseTimer, clearPreviewOpenTimer]);

  const requestPreviewClose = useCallback(() => {
    closePreview();
  }, [closePreview]);

  const openPreview = useCallback((target: SidebarPreviewTarget) => {
    if (!previewTriggerRefs.current.has(target.key)) return;
    setHoveredPreview(target);
  }, []);

  const schedulePreviewOpen = useCallback((target: SidebarPreviewTarget) => {
    clearPreviewOpenTimer();
    clearPreviewCloseTimer();
    setHoveredPreview(null);
    const delay = getHoverPreviewOpenDelay(lastPreviewOpenedAtRef.current);
    if (delay <= 0) {
      openPreview(target);
      return;
    }
    previewOpenTimerRef.current = window.setTimeout(() => {
      previewOpenTimerRef.current = null;
      openPreview(target);
    }, delay);
  }, [clearPreviewCloseTimer, clearPreviewOpenTimer, openPreview]);

  const openPreviewBlock = useCallback((target: SidebarPreviewTarget) => {
    if (!onOpenBlock) return;
    closePreview();
    void getBlock(target.slug)
      .then((block) => {
        if (block) {
          onOpenBlock(block);
        }
      })
      .catch((error) => {
        void error;
      });
  }, [closePreview, onOpenBlock]);

  useEffect(() => () => {
    clearPreviewOpenTimer();
    clearPreviewCloseTimer();
    clearSidebarRowSwitchFrame();
  }, [clearPreviewCloseTimer, clearPreviewOpenTimer, clearSidebarRowSwitchFrame]);

  useEffect(() => {
    if (!hoveredPreview) {
      setHoverPreviewBlock(null);
      setHoverPreviewPosition(null);
      return;
    }
    let cancelled = false;
    setHoverPreviewBlock(null);

    const trigger = previewTriggerRefs.current.get(hoveredPreview.key);
    if (trigger) {
      setHoverPreviewPosition(
        computeSidebarPreviewPosition(
          trigger.getBoundingClientRect(),
          previewRef.current?.getBoundingClientRect().height ?? SIDEBAR_PREVIEW_FALLBACK_HEIGHT,
        ),
      );
    } else {
      setHoverPreviewPosition(null);
    }

    void getBlock(hoveredPreview.slug)
      .then((block) => {
        if (cancelled) return;
        if (block) {
          lastPreviewOpenedAtRef.current = Date.now();
        }
        setHoverPreviewBlock(block);
      })
      .catch(() => {
        if (cancelled) return;
        setHoverPreviewBlock(null);
      });
    return () => {
      cancelled = true;
    };
  }, [hoveredPreview]);

  useEffect(() => {
    if (!hoveredPreview || !hoverPreviewBlock || !hoverPreviewPosition || !previewRef.current) {
      return;
    }
    const trigger = previewTriggerRefs.current.get(hoveredPreview.key);
    if (!trigger) return;

    const nextPosition = computeSidebarPreviewPosition(
      trigger.getBoundingClientRect(),
      previewRef.current.getBoundingClientRect().height,
    );
    if (
      Math.abs(nextPosition.top - hoverPreviewPosition.top) > 1 ||
      Math.abs(nextPosition.left - hoverPreviewPosition.left) > 1
    ) {
      setHoverPreviewPosition(nextPosition);
    }
  }, [hoveredPreview, hoverPreviewBlock, hoverPreviewPosition]);

  useEffect(() => {
    if (!isLinkingBlock) {
      setLinkChromeEntered(false);
      return;
    }
    if (detailChromeClosing) {
      setLinkChromeEntered(false);
      return;
    }
    setLinkChromeEntered(false);
    const frame = window.requestAnimationFrame(() => {
      setLinkChromeEntered(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isLinkingBlock, detailChromeClosing]);

  return (
    <aside
      className={cn(
        "relative flex shrink-0 flex-col border-r border-sidebar-border",
        collapsed && "overflow-hidden",
      )}
      style={{
        width: "var(--sidebar-width)",
        transition: isResizing ? "none" : "width 200ms ease",
      }}
    >
      {isLinkingBlock && (
        <SidebarLinkModeSwitch
          value={linkMode}
          entered={linkChromeEntered}
          onChange={setLinkMode}
        />
      )}

      {/* Navigation */}
      <nav
        ref={navRef}
        className={cn(
          "relative flex-1 overflow-y-auto",
          isLinkingBlock ? linkEditorNavPadding : "pt-16",
          "pb-8",
          compact ? "px-2" : "px-8",
        )}
        data-sidebar-scroll
        data-sidebar-link-editor-mode={isLinkEditorActive ? "true" : undefined}
        data-sidebar-row-focus-mode={hasSidebarRowFocusMode ? "true" : undefined}
        data-sidebar-row-switching={sidebarRowSwitching ? "true" : undefined}
        onPointerMove={handleSidebarPointerMove}
        onPointerLeave={deactivateSidebarRowFocusMode}
        onFocusCapture={handleSidebarFocusCapture}
        onBlurCapture={handleSidebarBlurCapture}
      >
        {!isLinkingBlock && headerSlot}

        <div className="relative" data-sidebar-rows>
          {!compact && (
            <div className="pointer-events-none absolute inset-0" data-sidebar-guidelines>
              <span
                aria-hidden="true"
                data-sidebar-guideline="left"
                className="absolute inset-y-0 w-px bg-sidebar-border"
                style={{ left: `${SIDEBAR_ROW_TITLE_COLUMN_WIDTH}px` }}
              />
              <span
                aria-hidden="true"
                data-sidebar-guideline="right"
                className="absolute inset-y-0 w-px bg-sidebar-border"
                style={{ right: `${SIDEBAR_ROW_RIGHT_GUIDELINE_OFFSET}px` }}
              />
            </div>
          )}

          <NavItem
            to="/"
            label="Everything"
            count={totalBlocks}
            cards={channelPreviews.get("__all__") ?? []}
            previewKeyPrefix="all"
            onPreviewEnter={schedulePreviewOpen}
            onPreviewLeave={requestPreviewClose}
            onPreviewClick={openPreviewBlock}
            onPreviewTriggerRef={setPreviewTriggerRef}
            activePreviewKey={hoveredPreview?.key ?? null}
            compact={compact}
            end
            onClick={onNavClick}
            onSameClick={isLinkEditorActive ? onNavClick : onScrollToTop}
            rowKey="all"
            isSidebarRowFocused={effectiveSidebarRowFocusKey === "all"}
            isSidebarRowSeamAccent={seamAccentKeys.has("all")}
          />

          <SortableContext
            items={visibleTags.map((tc) => `tag:${tc.tag}`)}
            strategy={verticalListSortingStrategy}
          >
            {visibleTags.map((tc) => {
              const checked = linkedTagSet.has(tc.tag);
              return (
                <TagNavItem
                  key={tc.tag}
                  to={`/channel/${encodeURIComponent(tc.tag)}`}
                  label={collectionRefLabel(tc.tag)}
                  count={tc.count}
                  tag={tc.tag}
                  cards={channelPreviews.get(tc.tag) ?? []}
                  previewKeyPrefix={`tag:${tc.tag}`}
                  onPreviewEnter={schedulePreviewOpen}
                  onPreviewLeave={requestPreviewClose}
                  onPreviewClick={openPreviewBlock}
                  onPreviewTriggerRef={setPreviewTriggerRef}
                  activePreviewKey={hoveredPreview?.key ?? null}
                  compact={compact}
                  isDropDragging={isDropDragging}
                  isEditing={!isLinkEditorActive && editingTag === tc.tag}
                  linkEditor={isLinkEditorActive ? {
                    checked,
                    onToggle: () => onToggleLinkedTag(linkedBlockSlug, tc.tag, checked),
                  } : undefined}
                  onDoubleClick={() => setEditingTag(tc.tag)}
                  onRenameSubmit={(v) => handleRename(tc.tag, v)}
                  onRenameCancel={() => setEditingTag(null)}
                  onDelete={() => onDeleteTag(tc.tag)}
                  onClick={onNavClick}
                  onSameClick={isLinkEditorActive ? undefined : onScrollToTop}
                  rowKey={`tag:${tc.tag}`}
                  isSidebarRowFocused={effectiveSidebarRowFocusKey === `tag:${tc.tag}`}
                  isSidebarRowSeamAccent={seamAccentKeys.has(`tag:${tc.tag}`)}
                />
              );
            })}
          </SortableContext>

        </div>

        <NewChannelRow
          compact={compact}
          isEditing={isCreatingChannel}
          isSidebarRowFocused={effectiveSidebarRowFocusKey === "create-channel"}
          isSidebarRowSeamAccent={seamAccentKeys.has("create-channel")}
          onStartCreate={() => onSetCreatingChannel(true)}
          onCreate={(value) => {
            onCreateChannel(value);
            onSetCreatingChannel(false);
          }}
          onCancel={() => onSetCreatingChannel(false)}
        />

      </nav>

      {vaultPath
        && hoverPreviewPosition
        && hoverPreviewBlock && (
          <div
            ref={previewRef}
            className="pointer-events-none fixed z-50"
            style={{
              top: hoverPreviewPosition.top,
              left: hoverPreviewPosition.left,
              width: SIDEBAR_PREVIEW_WIDTH,
            }}
            data-sidebar-thumbnail-hover-preview
          >
            <ReadOnlyCardPreview
              block={hoverPreviewBlock}
              vaultPath={vaultPath}
              thumbsRootPath={thumbsRootPath}
              width={SIDEBAR_PREVIEW_WIDTH}
              previewMode="micro"
            />
          </div>
      )}

    </aside>
  );
}

// ─── Components ──────────────────────────────────────────────────────────────

function scrollActiveSidebarItemIntoView(nav: HTMLElement, active: HTMLElement) {
  const navRect = nav.getBoundingClientRect();
  const activeRect = active.getBoundingClientRect();
  const style = getComputedStyle(nav);
  const topInset = parseFloat(style.paddingTop) || 0;
  const bottomInset = parseFloat(style.paddingBottom) || 0;
  const topLimit = navRect.top + topInset;
  const bottomLimit = navRect.bottom - bottomInset;

  let nextTop = nav.scrollTop;
  if (activeRect.top < topLimit) {
    nextTop -= topLimit - activeRect.top;
  } else if (activeRect.bottom > bottomLimit) {
    nextTop += activeRect.bottom - bottomLimit;
  } else {
    return;
  }

  if (typeof nav.scrollTo === "function") {
    nav.scrollTo({ top: Math.max(0, nextTop), behavior: "smooth" });
  } else {
    nav.scrollTop = Math.max(0, nextTop);
  }
}

function computeSidebarPreviewPosition(
  triggerRect: DOMRect,
  previewHeight: number,
): SidebarPreviewPosition {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const left = Math.max(
    SIDEBAR_PREVIEW_VIEWPORT_MARGIN,
    Math.min(
      triggerRect.left,
      viewportWidth - SIDEBAR_PREVIEW_VIEWPORT_MARGIN - SIDEBAR_PREVIEW_WIDTH,
    ),
  );
  const canOpenDown =
    triggerRect.bottom + SIDEBAR_PREVIEW_GAP + previewHeight <=
    viewportHeight - SIDEBAR_PREVIEW_VIEWPORT_MARGIN;
  const top = canOpenDown
    ? triggerRect.bottom + SIDEBAR_PREVIEW_GAP
    : Math.max(
        SIDEBAR_PREVIEW_VIEWPORT_MARGIN,
        triggerRect.top - SIDEBAR_PREVIEW_GAP - previewHeight,
      );
  return { top, left };
}

const SidebarLinkModeSwitch = memo(function SidebarLinkModeSwitch({
  value,
  entered,
  onChange,
}: {
  value: "all" | "linked";
  entered: boolean;
  onChange: (value: "all" | "linked") => void;
}) {
  const label = (
    <span className="shrink-0 font-mono text-sm text-muted-foreground">
      Channels:
    </span>
  );
  const control = (
    <div
      className={cn(
        "action-button inline-flex h-6 shrink-0 cursor-pointer items-center overflow-hidden rounded-1 bg-transparent p-[2px] font-mono text-sm outline-0",
        "hover:bg-component-fill-hover",
      )}
      data-sidebar-link-mode-control
    >
      <button
        type="button"
        aria-pressed={value === "all"}
        onClick={() => onChange("all")}
        className={cn(
          "flex h-5 shrink-0 items-center rounded-[2px] px-[1ch] text-muted-foreground hover:text-foreground",
          value === "all" && "bg-component-fill-inner text-foreground",
        )}
      >
        All
      </button>
      <button
        type="button"
        aria-pressed={value === "linked"}
        onClick={() => onChange("linked")}
        className={cn(
          "flex h-5 shrink-0 items-center rounded-[2px] px-[1ch] text-muted-foreground hover:text-foreground",
          value === "linked" && "bg-component-fill-inner text-foreground",
        )}
      >
        Connected
      </button>
    </div>
  );

  return (
    <div
      className="detail-top-bar-enter relative flex h-8 shrink-0 items-center gap-2 bg-accent px-8"
      data-entered={entered ? "true" : "false"}
      data-sidebar-link-mode-bar
    >
      {label}
      {control}
      <span
        aria-hidden="true"
        data-entered={entered ? "true" : "false"}
        className="detail-top-bar-line-enter pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border"
      />
    </div>
  );
});

function assignRef<T>(ref: Ref<T> | undefined, value: T) {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  ref.current = value;
}

type SidebarRowFrameProps = {
  compact?: boolean;
  rowKey: string;
  isCurrentRoute: boolean;
  isLinked?: boolean;
  isSidebarRowFocused: boolean;
  isSidebarRowSeamAccent: boolean;
  surface?: boolean;
  isEditing?: boolean;
  className?: string;
  style?: CSSProperties;
  nodeRef?: (node: HTMLDivElement | null) => void;
  textDropTag?: string;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"div">, "children" | "style" | "className">;

const SidebarRowFrame = forwardRef<HTMLDivElement, SidebarRowFrameProps>(function SidebarRowFrame({
  compact,
  rowKey,
  isCurrentRoute,
  isLinked = false,
  isSidebarRowFocused,
  isSidebarRowSeamAccent,
  surface,
  isEditing = false,
  className,
  style,
  nodeRef,
  textDropTag,
  children,
  ...domProps
}, forwardedRef) {
  const setRefs = useCallback((node: HTMLDivElement | null) => {
    assignRef(forwardedRef, node);
    nodeRef?.(node);
  }, [forwardedRef, nodeRef]);
  const hasSurface = surface ?? !compact;

  return (
    <div
      ref={setRefs}
      style={style}
      {...domProps}
      data-sidebar-row=""
      data-sidebar-row-surface={hasSurface ? "" : undefined}
      data-sidebar-row-key={rowKey}
      data-sidebar-row-active={isCurrentRoute ? "true" : undefined}
      data-sidebar-row-linked={isLinked ? "true" : undefined}
      data-sidebar-row-focused={isSidebarRowFocused ? "true" : undefined}
      data-sidebar-row-seam-accent={!compact && isSidebarRowSeamAccent ? "true" : undefined}
      data-sidebar-row-editing={isEditing ? "true" : undefined}
      data-sidebar-text-drop-tag={textDropTag}
      className={cn(
        "group relative rounded-1",
        isEditing && "z-10 bg-sidebar",
        className,
      )}
    >
      {children}
    </div>
  );
});

function SidebarRowTitleCell({
  compact,
  children,
  className,
}: {
  compact?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-sidebar-row-text=""
      data-sidebar-title-fade-width={compact ? undefined : String(SIDEBAR_ROW_TEXT_MASK_FADE_WIDTH)}
      data-sidebar-title-protected-width={compact ? undefined : String(SIDEBAR_PREVIEW_DIVIDER_GAP)}
      className={cn(
        compact
          ? "flex-1 truncate"
          : "min-w-[100px] max-w-[150px] flex-1 translate-x-px overflow-hidden whitespace-nowrap",
        className,
      )}
      style={compact ? undefined : SIDEBAR_ROW_TEXT_MASK_STYLE}
    >
      {children}
    </span>
  );
}

function SidebarPreviewRail({ children }: { children: ReactNode }) {
  return (
    <div
      className="relative min-w-0 flex-1"
      data-sidebar-preview-rail
      style={{ paddingLeft: `${SIDEBAR_PREVIEW_DIVIDER_GAP}px` }}
    >
      {children}
    </div>
  );
}

function SidebarRowBody({
  to,
  end,
  label,
  count,
  cards,
  previewKeyPrefix,
  rowKey,
  onPreviewEnter,
  onPreviewLeave,
  onPreviewClick,
  onPreviewTriggerRef,
  activePreviewKey,
  compact,
  isCurrentRoute,
  isDragging = false,
  isDropDragging = false,
  onClick,
  onSameClick,
  onDoubleClick,
  linkEditor,
}: {
  to: string;
  end?: boolean;
  label: string;
  count: number;
  cards: PreviewCard[];
  previewKeyPrefix: string;
  rowKey: string;
  onPreviewEnter: (target: SidebarPreviewTarget) => void;
  onPreviewLeave: () => void;
  onPreviewClick: (target: SidebarPreviewTarget) => void;
  onPreviewTriggerRef: (key: string, node: HTMLElement | null) => void;
  activePreviewKey: string | null;
  compact?: boolean;
  isCurrentRoute: boolean;
  isDragging?: boolean;
  isDropDragging?: boolean;
  onClick?: () => void;
  onSameClick?: () => void;
  onDoubleClick?: () => void;
  linkEditor?: {
    checked: boolean;
    onToggle: () => void;
  };
}) {
  const isLinkEditor = !!linkEditor;
  const handleNavLinkClick = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    if (isDragging || isDropDragging) {
      e.preventDefault();
      return;
    }
    if (isCurrentRoute && onSameClick) {
      e.preventDefault();
      onSameClick();
    } else {
      onClick?.();
    }
  };
  const handleNavLinkDoubleClick = onDoubleClick ? (e: ReactMouseEvent<HTMLAnchorElement>) => {
    if (isLinkEditor) return;
    e.preventDefault();
    onDoubleClick();
  } : undefined;

  return (
    <>
      <NavLink
        to={to}
        end={end}
        draggable="false"
        onClick={handleNavLinkClick}
        onDoubleClick={handleNavLinkDoubleClick}
        className={() =>
          compact
            ? cn(
                "flex w-full items-center gap-2 overflow-hidden text-base",
                "rounded-1 p-2",
                "text-muted-foreground",
              )
            : cn("relative flex items-center py-1 font-sans text-base text-muted-foreground")
        }
      >
        <SidebarRowTitleCell compact={compact}>
          {label}
        </SidebarRowTitleCell>
        {!compact && (
          <SidebarPreviewRail>
            <SidebarPreviewStrip
              cards={cards}
              previewKeyPrefix={previewKeyPrefix}
              rowKey={rowKey}
              onPreviewEnter={onPreviewEnter}
              onPreviewLeave={onPreviewLeave}
              onPreviewClick={onPreviewClick}
              onPreviewTriggerRef={onPreviewTriggerRef}
              activePreviewKey={activePreviewKey}
              allowHoverPreview
            />
          </SidebarPreviewRail>
        )}
        {compact && isLinkEditor && (
          <div className="relative flex h-8 w-8 shrink-0 items-center justify-end text-right">
            <span
              className={cn(
                "absolute inset-y-0 right-0 flex items-center justify-end text-sm transition-opacity duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
                "font-mono",
                "text-muted-foreground",
                !compact && "-translate-x-px",
                linkEditor.checked
                  ? "opacity-0"
                  : "opacity-100 group-hover:opacity-0 group-focus-within:opacity-0",
              )}
              data-sidebar-row-text=""
            >
              {count || ""}
            </span>
          </div>
        )}
        {compact && !isLinkEditor && (
          <div className="relative flex h-8 w-8 shrink-0 items-center justify-end text-right">
            <span
              className={cn(
                "absolute inset-y-0 right-0 flex items-center justify-end text-sm",
                "font-mono",
                "text-muted-foreground",
                !compact && "-translate-x-px",
              )}
              data-sidebar-row-text=""
            >
              {count || ""}
            </span>
          </div>
        )}
        {!compact && (
          <span
            className={cn(
              "absolute inset-y-0 right-0 flex w-8 items-center justify-end text-right text-sm font-mono text-muted-foreground",
              "-translate-x-px",
              isLinkEditor
                ? cn(
                    "transition-opacity duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
                    linkEditor?.checked
                      ? "opacity-0"
                      : "opacity-100 group-hover:opacity-0 group-focus-within:opacity-0",
                  )
                : "opacity-100",
            )}
            data-sidebar-row-text=""
          >
            {count || ""}
          </span>
        )}
      </NavLink>
      {linkEditor && (
        <button
          type="button"
          data-sidebar-link-action
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            linkEditor.onToggle();
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
          }}
          className={cn(
            SIDEBAR_ROW_ACTION_BUTTON_CLASS,
            "absolute top-1/2 z-10 w-[10ch] -translate-y-1/2 transition-opacity duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
            "right-0",
            linkEditor.checked
              ? "opacity-100"
              : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
          )}
          aria-label={`${linkEditor.checked ? "Disconnect" : "Connect"} ${label}`}
        >
          {linkEditor.checked ? (
            <>
              <span className="group-hover:hidden group-focus-within:hidden">Connected</span>
              <span className="hidden text-destructive group-hover:inline group-focus-within:inline">Disconnect</span>
            </>
          ) : (
            "Connect"
          )}
        </button>
      )}
    </>
  );
}

function SidebarEditableRowBody({
  defaultValue,
  placeholder,
  ariaLabel,
  compact,
  submitAction,
  onSubmit,
  onCancel,
}: {
  defaultValue: string;
  placeholder: string;
  ariaLabel: string;
  compact?: boolean;
  submitAction?: {
    label: string;
    shortcut: string;
  };
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  return (
    <div
      className={
        compact
          ? cn(
              "flex w-full items-center overflow-hidden text-base",
              "rounded-1 p-2",
              "text-muted-foreground",
            )
          : cn("relative flex min-h-10 w-full items-center py-1 font-sans text-base text-muted-foreground")
      }
      data-sidebar-editable-row-body
      data-sidebar-editable-row-full-width
    >
      <InlineChannelNameEditor
        defaultValue={defaultValue}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        submitAction={submitAction}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    </div>
  );
}

const NavItem = memo(function NavItem({
  to,
  label,
  count,
  cards = [],
  previewKeyPrefix,
  onPreviewEnter,
  onPreviewLeave,
  onPreviewClick,
  onPreviewTriggerRef,
  activePreviewKey,
  compact,
  end,
  onClick,
  onSameClick,
  rowKey,
  isSidebarRowFocused,
  isSidebarRowSeamAccent,
}: {
  to: string;
  label: string;
  count: number;
  cards?: PreviewCard[];
  previewKeyPrefix: string;
  onPreviewEnter: (target: SidebarPreviewTarget) => void;
  onPreviewLeave: () => void;
  onPreviewClick: (target: SidebarPreviewTarget) => void;
  onPreviewTriggerRef: (key: string, node: HTMLElement | null) => void;
  activePreviewKey: string | null;
  compact?: boolean;
  end?: boolean;
  onClick?: () => void;
  onSameClick?: () => void;
  rowKey: string;
  isSidebarRowFocused: boolean;
  isSidebarRowSeamAccent: boolean;
}) {
  const loc = useLocation();
  const isCurrentRoute = end ? loc.pathname === to : loc.pathname.startsWith(to);

  return (
    <SidebarRowFrame
      compact={compact}
      rowKey={rowKey}
      isCurrentRoute={isCurrentRoute}
      isSidebarRowFocused={isSidebarRowFocused}
      isSidebarRowSeamAccent={isSidebarRowSeamAccent}
    >
      <SidebarRowBody
        to={to}
        end={end}
        label={label}
        count={count}
        cards={cards}
        previewKeyPrefix={previewKeyPrefix}
        rowKey={rowKey}
        onPreviewEnter={onPreviewEnter}
        onPreviewLeave={onPreviewLeave}
        onPreviewClick={onPreviewClick}
        onPreviewTriggerRef={onPreviewTriggerRef}
        activePreviewKey={activePreviewKey}
        compact={compact}
        isCurrentRoute={isCurrentRoute}
        onClick={onClick}
        onSameClick={onSameClick}
      />
    </SidebarRowFrame>
  );
});

const TagNavItem = memo(function TagNavItem({
  to,
  label,
  count,
  tag,
  cards,
  previewKeyPrefix,
  onPreviewEnter,
  onPreviewLeave,
  onPreviewClick,
  onPreviewTriggerRef,
  activePreviewKey,
  compact,
  isDropDragging,
  isEditing,
  linkEditor,
  onDoubleClick,
  onRenameSubmit,
  onRenameCancel,
  onDelete,
  onClick,
  onSameClick,
  rowKey,
  isSidebarRowFocused,
  isSidebarRowSeamAccent,
}: {
  to: string;
  label: string;
  count: number;
  tag: string;
  cards: PreviewCard[];
  previewKeyPrefix: string;
  onPreviewEnter: (target: SidebarPreviewTarget) => void;
  onPreviewLeave: () => void;
  onPreviewClick: (target: SidebarPreviewTarget) => void;
  onPreviewTriggerRef: (key: string, node: HTMLElement | null) => void;
  activePreviewKey: string | null;
  compact?: boolean;
  isDropDragging: boolean;
  isEditing: boolean;
  linkEditor?: {
    checked: boolean;
    onToggle: () => void;
  };
  onDoubleClick: () => void;
  onRenameSubmit: (value: string) => void;
  onRenameCancel: () => void;
  onDelete: () => void;
  onClick?: () => void;
  onSameClick?: () => void;
  rowKey: string;
  isSidebarRowFocused: boolean;
  isSidebarRowSeamAccent: boolean;
}) {
  const location = useLocation();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const isLinkEditor = !!linkEditor;
  const isCurrentRoute = location.pathname === to || location.pathname.startsWith(`${to}/`);

  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `tag:${tag}` });

  // Disabled while dragging onto tags so dnd-kit's
  // getBoundingClientRect calls on drop targets always return real
  // geometry instead of the intrinsic placeholder.
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(!isDropDragging && !isDragging
      ? {
          contentVisibility: "auto" as const,
          containIntrinsicSize: "auto 42px",
        }
      : {}),
  };

  if (isEditing) {
    return (
      <SidebarRowFrame
        compact={compact}
        rowKey={rowKey}
        isCurrentRoute={isCurrentRoute}
        isLinked={linkEditor?.checked}
        isSidebarRowFocused={isSidebarRowFocused}
        isSidebarRowSeamAccent={isSidebarRowSeamAccent}
        isEditing
        className={cn(
          isDragging && "opacity-30",
        )}
        style={style}
        nodeRef={setNodeRef}
        textDropTag={tag}
      >
        <SidebarEditableRowBody
          defaultValue={label}
          placeholder={label}
          ariaLabel={`Переименовать ${label}`}
          compact={compact}
          onSubmit={onRenameSubmit}
          onCancel={onRenameCancel}
        />
      </SidebarRowFrame>
    );
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <SidebarRowFrame
            compact={compact}
            rowKey={rowKey}
            isCurrentRoute={isCurrentRoute}
            isLinked={linkEditor?.checked}
            isSidebarRowFocused={isSidebarRowFocused}
            isSidebarRowSeamAccent={isSidebarRowSeamAccent}
            className={cn(
              isDragging && "opacity-30",
            )}
            style={style}
            nodeRef={setNodeRef}
            textDropTag={tag}
            {...(!isLinkEditor ? attributes : {})}
            {...(!isLinkEditor ? listeners : {})}
          >
            <SidebarRowBody
              to={to}
              label={label}
              count={count}
              cards={cards}
              previewKeyPrefix={previewKeyPrefix}
              rowKey={rowKey}
              onPreviewEnter={onPreviewEnter}
              onPreviewLeave={onPreviewLeave}
              onPreviewClick={onPreviewClick}
              onPreviewTriggerRef={onPreviewTriggerRef}
              activePreviewKey={activePreviewKey}
              compact={compact}
              isCurrentRoute={isCurrentRoute}
              isDragging={isDragging}
              isDropDragging={isDropDragging}
              onClick={onClick}
              onSameClick={onSameClick}
              onDoubleClick={onDoubleClick}
              linkEditor={linkEditor}
            />
          </SidebarRowFrame>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onDoubleClick}>
            <Pencil className="size-3" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
            <Trash2 className="size-3" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete channel</AlertDialogTitle>
            <AlertDialogDescription>
              Remove tag &ldquo;{label}&rdquo; from all cards. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
});

function NewChannelRow({
  compact,
  isEditing,
  isSidebarRowFocused,
  isSidebarRowSeamAccent,
  onStartCreate,
  onCreate,
  onCancel,
}: {
  compact?: boolean;
  isEditing: boolean;
  isSidebarRowFocused: boolean;
  isSidebarRowSeamAccent: boolean;
  onStartCreate: () => void;
  onCreate: (value: string) => void;
  onCancel: () => void;
}) {
  const { setNodeRef } = useDroppable({
    id: "create-channel",
    disabled: isEditing,
  });

  return (
    <SidebarRowFrame
      compact={compact}
      rowKey="create-channel"
      isCurrentRoute={false}
      isSidebarRowFocused={isSidebarRowFocused}
      isSidebarRowSeamAccent={isSidebarRowSeamAccent}
      surface={isEditing && !compact}
      isEditing={isEditing}
      nodeRef={setNodeRef}
      data-sidebar-new-channel-row=""
    >
      {isEditing ? (
        <SidebarEditableRowBody
          defaultValue=""
          placeholder=""
          ariaLabel="Имя нового канала"
          compact={compact}
          submitAction={{ label: "Create", shortcut: "Enter" }}
          onSubmit={onCreate}
          onCancel={onCancel}
        />
      ) : (
        <button
          type="button"
          className="block w-full text-left"
          onClick={onStartCreate}
        >
          <SidebarCreateChannelRowBody
            compact={compact}
            isEditing={false}
          />
        </button>
      )}
    </SidebarRowFrame>
  );
}

function SidebarCreateChannelRowBody({
  compact,
  isEditing,
}: {
  compact?: boolean;
  isEditing: boolean;
}) {
  return (
    <div
      className={
        compact
          ? cn(
              "flex w-full items-center gap-2 overflow-hidden rounded-1 p-2 font-sans text-base text-muted-foreground",
              !isEditing && "group-hover:text-foreground group-focus-within:text-foreground",
            )
          : cn(
              "relative flex min-h-10 w-full items-center py-1 font-sans text-base text-muted-foreground",
              !isEditing && "group-hover:text-foreground group-focus-within:text-foreground",
            )
      }
      data-sidebar-create-channel-row-body
    >
      <span
        data-sidebar-row-text=""
        className="shrink-0 whitespace-nowrap text-left"
      >
        Create New Channel
      </span>
      <Plus
        aria-hidden="true"
        data-sidebar-create-channel-plus=""
        className={cn(
          "ml-2 size-4 shrink-0 text-muted-foreground",
          isEditing && "opacity-0",
        )}
      />
      <span className="min-w-0 flex-1" aria-hidden="true" />
    </div>
  );
}

function SidebarPreviewStrip({
  cards,
  previewKeyPrefix,
  rowKey,
  onPreviewEnter,
  onPreviewLeave,
  onPreviewClick,
  onPreviewTriggerRef,
  activePreviewKey,
  allowHoverPreview = false,
}: {
  cards: PreviewCard[];
  previewKeyPrefix: string;
  rowKey: string;
  onPreviewEnter: (target: SidebarPreviewTarget) => void;
  onPreviewLeave: () => void;
  onPreviewClick: (target: SidebarPreviewTarget) => void;
  onPreviewTriggerRef: (key: string, node: HTMLElement | null) => void;
  activePreviewKey: string | null;
  allowHoverPreview?: boolean;
}) {
  return (
    <div
      data-sidebar-thumbnail-strip=""
      data-sidebar-preview-fade-width={String(SIDEBAR_PREVIEW_MASK_FADE_WIDTH)}
      data-sidebar-preview-protected-width={String(SIDEBAR_PREVIEW_MASK_CLEAR_TAIL_WIDTH)}
      className="flex h-8 min-w-0 flex-1 items-end gap-1 overflow-hidden"
      style={SIDEBAR_PREVIEW_MASK_STYLE}
    >
      {cards.filter((card) => card.hasThumb).map((card, index) => {
        const previewKey = `${previewKeyPrefix}:${card.slug ?? index}:${index}`;
        const canPreview = allowHoverPreview
          && card.hasThumb
          && !!card.slug;
        const isPreviewActive = activePreviewKey === previewKey;
        return (
          <div
            key={previewKey}
            ref={(node) => {
              if (canPreview) {
                onPreviewTriggerRef(previewKey, node);
              }
            }}
            className={cn(
              "size-8 shrink-0 overflow-hidden bg-accent",
              canPreview &&
                "cursor-pointer outline-0 outline-transparent hover:outline-1 hover:-outline-offset-1 hover:outline-component-fill-hover",
              isPreviewActive &&
                "outline-1 -outline-offset-1 outline-component-fill-hover",
            )}
            onPointerEnter={() => {
              if (card.slug && canPreview) {
                onPreviewEnter({ key: previewKey, rowKey, slug: card.slug });
              }
            }}
            onPointerLeave={() => {
              if (canPreview) {
                onPreviewLeave();
              }
            }}
            onClick={(event) => {
              if (!card.slug || !canPreview) return;
              event.preventDefault();
              event.stopPropagation();
              onPreviewClick({ key: previewKey, rowKey, slug: card.slug });
            }}
            onPointerDown={(event) => {
              if (canPreview) {
                event.stopPropagation();
              }
            }}
            data-sidebar-preview-thumbnail={canPreview ? "trigger" : "placeholder"}
            data-sidebar-preview-active={isPreviewActive ? "true" : undefined}
          >
            <MicroPreviewThumbnail
              preview={microPreviewFromPreviewCard(card)}
              loading="lazy"
              draggable={false}
            />
          </div>
        );
      })}
    </div>
  );
}

function InlineChannelNameEditor({
  placeholder,
  defaultValue = "",
  ariaLabel,
  submitAction,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  defaultValue?: string;
  ariaLabel: string;
  submitAction?: {
    label: string;
    shortcut: string;
  };
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, []);

  const doSubmit = (value: string) => {
    if (submitted.current) return;
    submitted.current = true;
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
    else onCancel();
  };

  return (
    <div className="flex w-full min-w-0 items-center gap-3" data-sidebar-inline-channel-editor-row>
      <input
        ref={ref}
        type="text"
        aria-label={ariaLabel}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="block h-5 min-w-0 flex-1 translate-x-px border-0 bg-transparent p-0 font-sans text-base leading-5 text-foreground outline-none ring-0 placeholder:text-muted-foreground focus:outline-none focus:ring-0"
        data-sidebar-inline-channel-editor=""
        onClick={(e) => {
          e.stopPropagation();
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            doSubmit((e.target as HTMLInputElement).value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            submitted.current = true;
            onCancel();
          }
        }}
        onBlur={(e) => doSubmit(e.target.value)}
      />
      {submitAction && (
        <button
          type="button"
          aria-label={`${submitAction.label} ${submitAction.shortcut}`}
          className={cn(
            SIDEBAR_ROW_ACTION_BUTTON_CLASS,
            "shrink-0 gap-[1ch] px-[1ch]",
          )}
          data-sidebar-inline-submit-action=""
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            doSubmit(ref.current?.value ?? "");
          }}
        >
          <span>{submitAction.label}</span>
          <span
            className="font-mono text-xs font-normal text-muted-foreground"
            data-sidebar-inline-submit-shortcut=""
          >
            {submitAction.shortcut}
          </span>
        </button>
      )}
    </div>
  );
}
