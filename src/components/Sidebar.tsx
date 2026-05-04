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
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Pencil, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
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
import type { ChannelDisplayMode, DetailTopMenuMode } from "@/lib/appPreferences";
import { getBlock } from "@/lib/commands";
import { cn } from "@/lib/utils";
import { InteractiveCardPreview } from "./Card";

/** Convert a collection ref to a compact display title. */
function titleFromTag(tag: string): string {
  const parts = tag.split("/");
  const label = (parts[parts.length - 1] ?? tag).trim();
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const SIDEBAR_PREVIEW_WIDTH = 240;
const SIDEBAR_PREVIEW_FALLBACK_HEIGHT = 320;
const SIDEBAR_PREVIEW_GAP = 8;
const SIDEBAR_PREVIEW_VIEWPORT_MARGIN = 16;
const SIDEBAR_PREVIEW_OPEN_DELAY_MS = 160;
const SIDEBAR_PREVIEW_CLOSE_DELAY_MS = 120;
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
  slug: string;
};

type SidebarPreviewPosition = {
  top: number;
  left: number;
  bridge: CSSProperties;
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
  detailTopMenuMode?: DetailTopMenuMode;
  channelDisplayMode?: ChannelDisplayMode;
  detailChromeClosing?: boolean;
}

function buildSidebarRowOrder(visibleTags: TagCount[]): string[] {
  return ["all", ...visibleTags.map((tc) => `tag:${tc.tag}`)];
}

function createSidebarSeamAccentSet(
  orderedRowKeys: string[],
  focusedRowKey: string | null,
  channelDisplayMode: ChannelDisplayMode,
): Set<string> {
  if (!focusedRowKey) return new Set();
  if (channelDisplayMode === "card") {
    return new Set();
  }
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
  tags,
  currentTag,
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
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
  onNavClick,
  onScrollToTop,
  keyboardNavigationFocus,
  headerSlot,
  linkedBlockSlug,
  linkedTags = [],
  onToggleLinkedTag,
  detailTopMenuMode = "island",
  channelDisplayMode = "row",
  detailChromeClosing = false,
}: SidebarProps) {
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [linkMode, setLinkMode] = useState<"all" | "linked">("all");
  const navRef = useRef<HTMLElement>(null);
  const previewTriggerRefs = useRef(new Map<string, HTMLElement>());
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewOpenTimerRef = useRef<number | null>(null);
  const previewCloseTimerRef = useRef<number | null>(null);
  const sidebarRowSwitchFrameRef = useRef<number | null>(null);
  const sidebarKeyboardFocusTimerRef = useRef<number | null>(null);
  const sidebarRowFocusKeyRef = useRef<string | null>(null);
  const sidebarRowFocusModeRef = useRef(false);
  const [hoveredPreview, setHoveredPreview] = useState<SidebarPreviewTarget | null>(null);
  const [hoverPreviewBlock, setHoverPreviewBlock] = useState<IndexedBlock | null>(null);
  const [hoverPreviewPosition, setHoverPreviewPosition] = useState<SidebarPreviewPosition | null>(null);
  const [hoverPreviewPinned, setHoverPreviewPinned] = useState(false);
  const [sidebarRowFocusKey, setSidebarRowFocusKey] = useState<string | null>(null);
  const [sidebarRowFocusMode, setSidebarRowFocusMode] = useState(false);
  const [sidebarRowSwitching, setSidebarRowSwitching] = useState(false);
  const location = useLocation();

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
  const orderedRowKeys = buildSidebarRowOrder(visibleTags);
  const seamAccentKeys = createSidebarSeamAccentSet(
    orderedRowKeys,
    sidebarRowFocusMode ? sidebarRowFocusKey : null,
    channelDisplayMode,
  );
  const linkEditorNavPadding = detailTopMenuMode === "classic" ? "pt-12" : "pt-20";
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
    setHoverPreviewPinned(false);
    setHoveredPreview(null);
  }, [clearPreviewCloseTimer, clearPreviewOpenTimer]);

  const cancelPreviewClose = useCallback(() => {
    clearPreviewCloseTimer();
  }, [clearPreviewCloseTimer]);

  const requestPreviewClose = useCallback(() => {
    clearPreviewOpenTimer();
    if (hoverPreviewPinned) return;
    clearPreviewCloseTimer();
    previewCloseTimerRef.current = window.setTimeout(() => {
      previewCloseTimerRef.current = null;
      setHoveredPreview(null);
    }, SIDEBAR_PREVIEW_CLOSE_DELAY_MS);
  }, [clearPreviewCloseTimer, clearPreviewOpenTimer, hoverPreviewPinned]);

  const noopToggleTag = useCallback((slug: string, tag: string, hasTag: boolean) => {
    void slug;
    void tag;
    void hasTag;
  }, []);
  const noopCreateAndAssign = useCallback((tag: string, blockSlug: string) => {
    void tag;
    void blockSlug;
  }, []);
  const noopRequestRename = useCallback((block: LightBlock) => {
    void block;
  }, []);
  const noopRequestDelete = useCallback((slug: string) => {
    void slug;
  }, []);

  const schedulePreviewOpen = useCallback((target: SidebarPreviewTarget) => {
    clearPreviewOpenTimer();
    clearPreviewCloseTimer();
    setHoveredPreview(null);
    previewOpenTimerRef.current = window.setTimeout(() => {
      previewOpenTimerRef.current = null;
      if (!previewTriggerRefs.current.has(target.key)) return;
      setHoveredPreview(target);
    }, SIDEBAR_PREVIEW_OPEN_DELAY_MS);
  }, [clearPreviewCloseTimer, clearPreviewOpenTimer]);

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
    if (!hoverPreviewPinned) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const preview = previewRef.current;
      const trigger = hoveredPreview
        ? previewTriggerRefs.current.get(hoveredPreview.key)
        : null;
      if (preview?.contains(target) || trigger?.contains(target)) {
        return;
      }
      closePreview();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [closePreview, hoverPreviewPinned, hoveredPreview]);

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
  }, [isLinkingBlock, linkedBlockSlug, detailTopMenuMode, detailChromeClosing]);

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
      {isLinkingBlock && detailTopMenuMode === "classic" && (
        <SidebarLinkModeSwitch
          value={linkMode}
          mode={detailTopMenuMode}
          entered={linkChromeEntered}
          onChange={setLinkMode}
        />
      )}

      {/* Navigation */}
      <nav
        ref={navRef}
        className={cn(
          "relative flex-1 overflow-y-auto",
          isLinkingBlock ? linkEditorNavPadding : "pt-20",
          compact ? "px-2" : "px-8",
        )}
        data-sidebar-scroll
        data-sidebar-link-editor-mode={isLinkEditorActive ? "true" : undefined}
        data-sidebar-row-focus-mode={sidebarRowFocusMode ? "true" : undefined}
        data-sidebar-row-switching={sidebarRowSwitching ? "true" : undefined}
        onPointerMove={handleSidebarPointerMove}
        onPointerLeave={deactivateSidebarRowFocusMode}
        onFocusCapture={handleSidebarFocusCapture}
        onBlurCapture={handleSidebarBlurCapture}
      >
        {!isLinkingBlock && headerSlot}

        <div className="relative" data-sidebar-rows>
          {!compact && channelDisplayMode === "row" && (
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
            compact={compact}
            end
            onClick={onNavClick}
            onSameClick={isLinkEditorActive ? onNavClick : onScrollToTop}
            rowKey="all"
            isSidebarRowFocused={sidebarRowFocusKey === "all"}
            isSidebarRowSeamAccent={seamAccentKeys.has("all")}
            channelDisplayMode={channelDisplayMode}
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
                  label={titleFromTag(tc.tag)}
                  count={tc.count}
                  tag={tc.tag}
                  cards={channelPreviews.get(tc.tag) ?? []}
                  previewKeyPrefix={`tag:${tc.tag}`}
                  onPreviewEnter={schedulePreviewOpen}
                  onPreviewLeave={requestPreviewClose}
                  onPreviewClick={openPreviewBlock}
                  onPreviewTriggerRef={setPreviewTriggerRef}
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
                  isSidebarRowFocused={sidebarRowFocusKey === `tag:${tc.tag}`}
                  isSidebarRowSeamAccent={seamAccentKeys.has(`tag:${tc.tag}`)}
                  channelDisplayMode={channelDisplayMode}
                />
              );
            })}
          </SortableContext>

          {isCreatingChannel && (
            <InlineInput
              defaultValue=""
              placeholder="New channel..."
              onSubmit={(value) => {
                onCreateChannel(value);
                onSetCreatingChannel(false);
              }}
              onCancel={() => onSetCreatingChannel(false)}
            />
          )}
        </div>

      </nav>

      {vaultPath
        && hoverPreviewPosition
        && hoverPreviewBlock && (
        <>
          <div
            className="fixed z-40"
            style={hoverPreviewPosition.bridge}
            onMouseEnter={cancelPreviewClose}
            onMouseLeave={requestPreviewClose}
            data-sidebar-thumbnail-hover-bridge
          />
          <div
            ref={previewRef}
            className="fixed z-50"
            style={{
              top: hoverPreviewPosition.top,
              left: hoverPreviewPosition.left,
              width: SIDEBAR_PREVIEW_WIDTH,
            }}
            onMouseEnter={cancelPreviewClose}
            onMouseLeave={requestPreviewClose}
            data-sidebar-thumbnail-hover-preview
          >
            <InteractiveCardPreview
              block={hoverPreviewBlock}
              vaultPath={vaultPath}
              thumbsRootPath={thumbsRootPath}
              width={SIDEBAR_PREVIEW_WIDTH}
              className="dark:bg-accent"
              tags={tags ?? orderedTags}
              currentTag={currentTag}
              onToggleTag={onToggleTag ?? noopToggleTag}
              onCreateAndAssign={onCreateAndAssign ?? noopCreateAndAssign}
              onRequestRename={onRequestRename ?? noopRequestRename}
              onRequestDelete={onRequestDelete ?? noopRequestDelete}
              onInteractiveOpenChange={(open) => {
                if (open) {
                  setHoverPreviewPinned(true);
                }
              }}
              onInteractionStart={() => setHoverPreviewPinned(true)}
              onClick={(previewBlock) => openPreviewBlock({
                key: hoveredPreview?.key ?? previewBlock.slug,
                slug: previewBlock.slug,
              })}
            />
          </div>
        </>
      )}

      {isLinkingBlock && detailTopMenuMode !== "classic" && (
        <SidebarLinkModeSwitch
          value={linkMode}
          mode={detailTopMenuMode}
          entered={linkChromeEntered}
          onChange={setLinkMode}
        />
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
  const bridgeTop = canOpenDown ? triggerRect.bottom : top + previewHeight;
  const bridgeBottom = canOpenDown ? top : triggerRect.top;
  const bridgeLeft = Math.min(left, triggerRect.left);
  const bridgeRight = Math.max(left + SIDEBAR_PREVIEW_WIDTH, triggerRect.right);
  const bridge: CSSProperties = {
    top: bridgeTop,
    left: bridgeLeft,
    width: bridgeRight - bridgeLeft,
    height: Math.max(0, bridgeBottom - bridgeTop),
  };

  return { top, left, bridge };
}

const SidebarLinkModeSwitch = memo(function SidebarLinkModeSwitch({
  value,
  mode,
  entered,
  onChange,
}: {
  value: "all" | "linked";
  mode: DetailTopMenuMode;
  entered: boolean;
  onChange: (value: "all" | "linked") => void;
}) {
  const isIsland = mode !== "classic";
  const label = (
    <span className="shrink-0 font-mono text-sm text-muted-foreground">
      Channels:
    </span>
  );
  const control = (
    <div
      className={cn(
        "action-button inline-flex h-6 shrink-0 cursor-pointer items-center overflow-hidden rounded-1 bg-transparent p-[2px] font-mono text-sm outline-0",
        !isIsland && "hover:bg-component-fill-hover",
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

  if (mode === "classic") {
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
  }

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-4 z-10 flex justify-center bg-transparent"
      data-sidebar-link-mode-bar
    >
      <div
        className="detail-top-pill-enter pointer-events-auto flex h-8 w-fit items-center gap-2 rounded-1 border border-border bg-accent/80 pl-3 pr-[2px] backdrop-blur-sm backdrop-saturate-150"
        data-entered={entered ? "true" : "false"}
        data-sidebar-link-mode-pill
      >
        {label}
        {control}
      </div>
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
  channelDisplayMode: ChannelDisplayMode;
  rowKey: string;
  isCurrentRoute: boolean;
  isLinked?: boolean;
  isSidebarRowFocused: boolean;
  isSidebarRowSeamAccent: boolean;
  className?: string;
  style?: CSSProperties;
  nodeRef?: (node: HTMLDivElement | null) => void;
  textDropTag?: string;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"div">, "children" | "style" | "className">;

const SidebarRowFrame = forwardRef<HTMLDivElement, SidebarRowFrameProps>(function SidebarRowFrame({
  compact,
  channelDisplayMode,
  rowKey,
  isCurrentRoute,
  isLinked = false,
  isSidebarRowFocused,
  isSidebarRowSeamAccent,
  className,
  style,
  nodeRef,
  textDropTag,
  children,
  ...domProps
}, forwardedRef) {
  const isChannelCard = channelDisplayMode === "card";
  const setRefs = useCallback((node: HTMLDivElement | null) => {
    assignRef(forwardedRef, node);
    nodeRef?.(node);
  }, [forwardedRef, nodeRef]);

  return (
    <div
      ref={setRefs}
      style={style}
      {...domProps}
      data-sidebar-row=""
      data-sidebar-row-surface={!compact && !isChannelCard ? "" : undefined}
      data-sidebar-row-key={rowKey}
      data-sidebar-row-active={isCurrentRoute ? "true" : undefined}
      data-sidebar-row-linked={isLinked ? "true" : undefined}
      data-sidebar-row-focused={isSidebarRowFocused ? "true" : undefined}
      data-sidebar-row-seam-accent={!compact && !isChannelCard && isSidebarRowSeamAccent ? "true" : undefined}
      data-sidebar-text-drop-tag={textDropTag}
      className={cn(
        "group relative rounded-1",
        isChannelCard && "mb-2 overflow-hidden border border-border bg-accent p-2 last:mb-0",
        className,
      )}
    >
      {children}
    </div>
  );
});

function SidebarRowBody({
  to,
  end,
  label,
  count,
  cards,
  previewKeyPrefix,
  onPreviewEnter,
  onPreviewLeave,
  onPreviewClick,
  onPreviewTriggerRef,
  compact,
  channelDisplayMode,
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
  onPreviewEnter: (target: SidebarPreviewTarget) => void;
  onPreviewLeave: () => void;
  onPreviewClick: (target: SidebarPreviewTarget) => void;
  onPreviewTriggerRef: (key: string, node: HTMLElement | null) => void;
  compact?: boolean;
  channelDisplayMode: ChannelDisplayMode;
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
  const isChannelCard = channelDisplayMode === "card";
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

  if (isChannelCard && !compact) {
    return (
      <div className="flex flex-col gap-2 font-sans text-base text-muted-foreground">
        <NavLink
          to={to}
          end={end}
          draggable="false"
          onClick={handleNavLinkClick}
          onDoubleClick={handleNavLinkDoubleClick}
          className="block"
        >
          <SidebarPreviewStrip
            cards={cards}
            previewKeyPrefix={previewKeyPrefix}
            onPreviewEnter={onPreviewEnter}
            onPreviewLeave={onPreviewLeave}
            onPreviewClick={onPreviewClick}
            onPreviewTriggerRef={onPreviewTriggerRef}
            stacked
            allowHoverPreview
          />
        </NavLink>
        <div className="flex items-center gap-2">
          <NavLink
            to={to}
            end={end}
            draggable="false"
            onClick={handleNavLinkClick}
            onDoubleClick={handleNavLinkDoubleClick}
            className="min-w-0 flex flex-1 items-center gap-2"
          >
            <span
              data-sidebar-row-text=""
              className="truncate"
            >
              {label}
            </span>
            <span
              className="shrink-0 font-mono text-sm text-muted-foreground"
              data-sidebar-row-text=""
            >
              {count || ""}
            </span>
          </NavLink>
          <div
            data-sidebar-card-action-slot=""
            className="flex h-6 w-[10ch] shrink-0 items-center justify-end"
          >
            {linkEditor ? (
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
                  "inline-flex h-6 w-[10ch] shrink-0 cursor-pointer items-center justify-center rounded-1 bg-component-fill px-[1ch] font-sans text-sm font-semibold text-foreground outline-0 outline-transparent transition-opacity duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:outline-1 hover:-outline-offset-1 hover:outline-component-fill-hover focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-component-fill-hover",
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
            ) : (
              <span aria-hidden="true" className="block h-6 w-[10ch] opacity-0" />
            )}
          </div>
        </div>
      </div>
    );
  }

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
                isChannelCard ? "rounded-[3px] px-[5px] py-[3px]" : "rounded-1 p-2",
                "text-muted-foreground",
              )
            : cn("relative flex items-center font-sans text-base text-muted-foreground", isChannelCard ? "h-8 rounded-[3px] px-[5px]" : "py-1")
        }
      >
        <span
          data-sidebar-row-text=""
          data-sidebar-title-fade-width={compact ? undefined : String(SIDEBAR_ROW_TEXT_MASK_FADE_WIDTH)}
          data-sidebar-title-protected-width={compact ? undefined : String(SIDEBAR_PREVIEW_DIVIDER_GAP)}
          className={
            compact
              ? "flex-1 truncate"
              : "min-w-[100px] max-w-[150px] flex-1 translate-x-px overflow-hidden whitespace-nowrap"
          }
          style={compact ? undefined : SIDEBAR_ROW_TEXT_MASK_STYLE}
        >
          {label}
        </span>
        {!compact && (
          <div
            className="relative min-w-0 flex-1"
            data-sidebar-preview-rail
            style={{ paddingLeft: `${SIDEBAR_PREVIEW_DIVIDER_GAP}px` }}
          >
            <SidebarPreviewStrip
              cards={cards}
              previewKeyPrefix={previewKeyPrefix}
              onPreviewEnter={onPreviewEnter}
              onPreviewLeave={onPreviewLeave}
              onPreviewClick={onPreviewClick}
              onPreviewTriggerRef={onPreviewTriggerRef}
              allowHoverPreview={false}
            />
          </div>
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
            "absolute top-1/2 z-10 inline-flex h-6 w-[10ch] -translate-y-1/2 cursor-pointer items-center justify-center rounded-1 bg-component-fill px-[1ch] font-sans text-sm font-semibold text-foreground outline-0 outline-transparent transition-opacity duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:outline-1 hover:-outline-offset-1 hover:outline-component-fill-hover focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-component-fill-hover",
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
  compact,
  end,
  onClick,
  onSameClick,
  rowKey,
  isSidebarRowFocused,
  isSidebarRowSeamAccent,
  channelDisplayMode,
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
  compact?: boolean;
  end?: boolean;
  onClick?: () => void;
  onSameClick?: () => void;
  rowKey: string;
  isSidebarRowFocused: boolean;
  isSidebarRowSeamAccent: boolean;
  channelDisplayMode: ChannelDisplayMode;
}) {
  const loc = useLocation();
  const isCurrentRoute = end ? loc.pathname === to : loc.pathname.startsWith(to);

  return (
    <SidebarRowFrame
      compact={compact}
      channelDisplayMode={channelDisplayMode}
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
        onPreviewEnter={onPreviewEnter}
        onPreviewLeave={onPreviewLeave}
        onPreviewClick={onPreviewClick}
        onPreviewTriggerRef={onPreviewTriggerRef}
        compact={compact}
        channelDisplayMode={channelDisplayMode}
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
  channelDisplayMode,
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
  channelDisplayMode: ChannelDisplayMode;
}) {
  const location = useLocation();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const isLinkEditor = !!linkEditor;
  const isCurrentRoute = location.pathname === to || location.pathname.startsWith(`${to}/`);
  const isChannelCard = channelDisplayMode === "card";

  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: `tag:${tag}` });

  // Phase C virtualization (SPEC_THUMBNAILS.md §Virtualized Sidebar).
  // `content-visibility: auto` is only valid for the legacy row layout.
  // Card-mode rows are taller and use a different internal flow, so
  // reusing the 42px intrinsic placeholder there causes WKWebView to
  // produce unstable geometry and visible layout gaps.
  //
  // Disabled while dragging onto tags so dnd-kit's
  // getBoundingClientRect calls on drop targets always return real
  // geometry instead of the intrinsic placeholder.
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(!isChannelCard && !isDropDragging && !isDragging
      ? {
          contentVisibility: "auto" as const,
          containIntrinsicSize: "auto 42px",
        }
      : {}),
  };

  if (isEditing) {
    return (
      <InlineInput
        defaultValue={label}
        placeholder="Rename..."
        onSubmit={onRenameSubmit}
        onCancel={onRenameCancel}
      />
    );
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <SidebarRowFrame
            compact={compact}
            channelDisplayMode={channelDisplayMode}
            rowKey={rowKey}
            isCurrentRoute={isCurrentRoute}
            isLinked={linkEditor?.checked}
            isSidebarRowFocused={isSidebarRowFocused}
            isSidebarRowSeamAccent={isSidebarRowSeamAccent}
            className={cn(
              isDragging && "opacity-30",
              "data-[selected-text-over=true]:ring-2 data-[selected-text-over=true]:ring-ring data-[selected-text-over=true]:ring-inset",
              isOver && !isDragging && isDropDragging && "ring-2 ring-ring ring-inset",
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
              onPreviewEnter={onPreviewEnter}
              onPreviewLeave={onPreviewLeave}
              onPreviewClick={onPreviewClick}
              onPreviewTriggerRef={onPreviewTriggerRef}
              compact={compact}
              channelDisplayMode={channelDisplayMode}
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

function SidebarPreviewStrip({
  cards,
  previewKeyPrefix,
  onPreviewEnter,
  onPreviewLeave,
  onPreviewClick,
  onPreviewTriggerRef,
  stacked = false,
  allowHoverPreview = false,
}: {
  cards: PreviewCard[];
  previewKeyPrefix: string;
  onPreviewEnter: (target: SidebarPreviewTarget) => void;
  onPreviewLeave: () => void;
  onPreviewClick: (target: SidebarPreviewTarget) => void;
  onPreviewTriggerRef: (key: string, node: HTMLElement | null) => void;
  stacked?: boolean;
  allowHoverPreview?: boolean;
}) {
  return (
    <div
      data-sidebar-thumbnail-strip=""
      data-sidebar-preview-fade-width={stacked ? undefined : String(SIDEBAR_PREVIEW_MASK_FADE_WIDTH)}
      data-sidebar-preview-protected-width={stacked ? undefined : String(SIDEBAR_PREVIEW_MASK_CLEAR_TAIL_WIDTH)}
      className={cn(
        "flex h-8 items-end gap-1 overflow-hidden",
        stacked ? "w-full" : "min-w-0 flex-1",
      )}
      style={stacked ? undefined : SIDEBAR_PREVIEW_MASK_STYLE}
    >
      {cards.map((card, index) => {
        const previewKey = `${previewKeyPrefix}:${card.slug ?? index}:${index}`;
        const canPreview = allowHoverPreview
          && card.hasThumb
          && !!card.slug;
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
            )}
            onMouseEnter={() => {
              if (card.slug && canPreview) {
                onPreviewEnter({ key: previewKey, slug: card.slug });
              }
            }}
            onMouseLeave={() => {
              if (canPreview) {
                onPreviewLeave();
              }
            }}
            onClick={(event) => {
              if (!card.slug || !canPreview) return;
              event.preventDefault();
              event.stopPropagation();
              onPreviewClick({ key: previewKey, slug: card.slug });
            }}
            onPointerDown={(event) => {
              if (canPreview) {
                event.stopPropagation();
              }
            }}
            data-sidebar-preview-thumbnail={canPreview ? "trigger" : "placeholder"}
          >
            {card.hasThumb && (
              <img
                src={card.url}
                className={cn(
                  "size-8 object-cover",
                  card.text ? "dark:invert" : "rounded-none",
                )}
                loading="lazy"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function InlineInput({
  placeholder,
  defaultValue = "",
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  defaultValue?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const doSubmit = (value: string) => {
    if (submitted.current) return;
    submitted.current = true;
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
    else onCancel();
  };

  return (
    <Input
      ref={ref}
      type="text"
      defaultValue={defaultValue}
      placeholder={placeholder}
      className="mx-1 h-auto w-[calc(100%-0.5rem)] border-ring py-1.5"
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          doSubmit((e.target as HTMLInputElement).value);
        } else if (e.key === "Escape") {
          submitted.current = true;
          onCancel();
        }
      }}
      onBlur={(e) => doSubmit(e.target.value)}
    />
  );
}
