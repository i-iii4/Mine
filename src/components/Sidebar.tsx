import { useState, useRef, useCallback, useEffect, memo, type CSSProperties } from "react";
import { NavLink, useLocation } from "react-router";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import type { DetailTopMenuMode } from "@/lib/appPreferences";
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
const SIDEBAR_PREVIEW_THUMB_SIZE = 32;
const SIDEBAR_PREVIEW_THUMB_GAP = 4;
const SIDEBAR_PREVIEW_MASK_FADE_WIDTH =
  (SIDEBAR_PREVIEW_THUMB_SIZE + SIDEBAR_PREVIEW_THUMB_GAP) * 2;
const sidebarPreviewMaskStop = (alpha: number, progress: number) => {
  const offset =
    Math.round(SIDEBAR_PREVIEW_MASK_FADE_WIDTH * (1 - progress) * 100) / 100;
  return `rgba(0, 0, 0, ${alpha}) calc(100% - ${offset}px)`;
};
const SIDEBAR_PREVIEW_MASK_STOPS = [
  "rgba(0, 0, 0, 1) 0%",
  sidebarPreviewMaskStop(1, 0),
  sidebarPreviewMaskStop(0.82, 0.14),
  sidebarPreviewMaskStop(0.64, 0.24),
  sidebarPreviewMaskStop(0.49, 0.33),
  sidebarPreviewMaskStop(0.36, 0.45),
  sidebarPreviewMaskStop(0.25, 0.57),
  sidebarPreviewMaskStop(0.16, 0.69),
  sidebarPreviewMaskStop(0.09, 0.81),
  sidebarPreviewMaskStop(0.04, 0.9),
  sidebarPreviewMaskStop(0.01, 0.97),
  "rgba(0, 0, 0, 0) 100%",
].join(", ");
const SIDEBAR_PREVIEW_MASK_IMAGE = `linear-gradient(to right, ${SIDEBAR_PREVIEW_MASK_STOPS})`;
const SIDEBAR_PREVIEW_MASK_STYLE: CSSProperties = {
  maskImage: SIDEBAR_PREVIEW_MASK_IMAGE,
  WebkitMaskImage: SIDEBAR_PREVIEW_MASK_IMAGE,
};

type SidebarPreviewTarget = {
  key: string;
  slug: string;
};

type SidebarPreviewPosition = {
  top: number;
  left: number;
  bridge: CSSProperties;
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
  /** Optional slot for a header banner (e.g. iCloud conflict surface). */
  headerSlot?: React.ReactNode;
  linkedBlockSlug?: string | null;
  linkedTags?: string[];
  onToggleLinkedTag?: (slug: string, tag: string, hasTag: boolean) => void;
  detailTopMenuMode?: DetailTopMenuMode;
  detailChromeClosing?: boolean;
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
  headerSlot,
  linkedBlockSlug,
  linkedTags = [],
  onToggleLinkedTag,
  detailTopMenuMode = "island",
  detailChromeClosing = false,
}: SidebarProps) {
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [linkMode, setLinkMode] = useState<"all" | "linked">("all");
  const navRef = useRef<HTMLElement>(null);
  const previewTriggerRefs = useRef(new Map<string, HTMLElement>());
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewOpenTimerRef = useRef<number | null>(null);
  const previewCloseTimerRef = useRef<number | null>(null);
  const [hoveredPreview, setHoveredPreview] = useState<SidebarPreviewTarget | null>(null);
  const [hoverPreviewBlock, setHoverPreviewBlock] = useState<IndexedBlock | null>(null);
  const [hoverPreviewPosition, setHoverPreviewPosition] = useState<SidebarPreviewPosition | null>(null);
  const [hoverPreviewPinned, setHoverPreviewPinned] = useState(false);
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
  }, [clearPreviewCloseTimer, clearPreviewOpenTimer]);

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
          "flex-1 overflow-y-auto",
          isLinkingBlock ? linkEditorNavPadding : "pt-20",
          compact ? "px-2" : "px-8",
        )}
        data-sidebar-scroll
      >
        {!isLinkingBlock && headerSlot}

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

      </nav>

      {vaultPath && hoverPreviewPosition && hoverPreviewBlock && (
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
        onClick={() => onChange("all")}
        className={cn(
          "flex h-5 shrink-0 items-center rounded-[2px] px-[1ch] text-muted-foreground",
          isIsland && "hover:text-foreground",
          value === "all" && "bg-component-fill-inner text-foreground",
        )}
      >
        All
      </button>
      <button
        type="button"
        onClick={() => onChange("linked")}
        className={cn(
          "flex h-5 shrink-0 items-center rounded-[2px] px-[1ch] text-muted-foreground",
          isIsland && "hover:text-foreground",
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
}) {
  const loc = useLocation();
  const isCurrentRoute = end ? loc.pathname === to : loc.pathname.startsWith(to);

  return (
    <NavLink
      to={to}
      end={end}
      onClick={(e) => {
        if (isCurrentRoute && onSameClick) {
          e.preventDefault();
          onSameClick();
        } else {
          onClick?.();
        }
      }}
      className={() =>
        compact
          ? cn(
              "flex w-full items-center gap-2 overflow-hidden rounded-1 p-2 text-base",
              "text-muted-foreground",
            )
          : cn(
              "flex items-center gap-2 border-b border-sidebar-border py-1 font-sans text-base",
              "text-muted-foreground",
            )
      }
    >
      <span className={compact ? "flex-1 truncate" : "min-w-[100px] max-w-[150px] flex-1 translate-x-px truncate"}>{label}</span>
      {!compact && (
        <SidebarPreviewStrip
          cards={cards}
          previewKeyPrefix={previewKeyPrefix}
          onPreviewEnter={onPreviewEnter}
          onPreviewLeave={onPreviewLeave}
          onPreviewClick={onPreviewClick}
          onPreviewTriggerRef={onPreviewTriggerRef}
        />
      )}
      <span className={cn(
        "w-8 shrink-0 text-right font-mono text-sm text-muted-foreground",
        !compact && "-translate-x-px",
      )}>
        {count || ""}
      </span>
    </NavLink>
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
}) {
  const location = useLocation();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const isLinkEditor = !!linkEditor;

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
  // `content-visibility: auto` lets WKWebView skip layout + paint for
  // channel rows that aren't in the viewport. `contain-intrinsic-size`
  // gives the browser a height hint so the scrollbar stays stable and
  // scroll-to-anchor navigation (Opt+Cmd+Arrow) still lands on the
  // correct row before the item is materialized.
  //
  // Intrinsic size: ~42px for non-compact rows (py-1 + 32px thumbs +
  // border), ~36px for compact. Use the larger value as a safe
  // over-estimate — slight scrollbar drift is preferable to the browser
  // shrinking the row and jumping scroll position after materialization.
  //
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
          <div
            ref={setNodeRef}
            style={style}
            {...(!isLinkEditor ? attributes : {})}
            {...(!isLinkEditor ? listeners : {})}
            data-sidebar-text-drop-tag={tag}
            className={cn(
              "group relative rounded-1",
              isDragging && "opacity-30",
              "data-[selected-text-over=true]:ring-2 data-[selected-text-over=true]:ring-ring data-[selected-text-over=true]:ring-inset",
              isOver && !isDragging && isDropDragging && "ring-2 ring-ring ring-inset",
            )}
          >
        <NavLink
          to={to}
          draggable="false"
          onClick={(e) => {
            if (isDragging || isDropDragging) {
              e.preventDefault();
              return;
            }
            const isCurrentRoute = location.pathname === to || location.pathname.startsWith(to + "/");
            if (isCurrentRoute && onSameClick) {
              e.preventDefault();
              onSameClick();
            } else {
              onClick?.();
            }
          }}
          onDoubleClick={(e) => {
            if (isLinkEditor) return;
            e.preventDefault();
            onDoubleClick();
          }}
          className={() =>
            compact
              ? cn(
                  "flex w-full items-center gap-2 overflow-hidden rounded-1 p-2 text-base",
                  "text-muted-foreground",
                )
              : cn(
                  "flex items-center gap-2 border-b border-sidebar-border py-1 font-sans text-base",
                  "text-muted-foreground",
                )
          }
        >
          <span className={compact ? "flex-1 truncate" : "min-w-[100px] max-w-[150px] flex-1 translate-x-px truncate"}>{label}</span>
          {!compact && (
            <SidebarPreviewStrip
              cards={cards}
              previewKeyPrefix={previewKeyPrefix}
              onPreviewEnter={onPreviewEnter}
              onPreviewLeave={onPreviewLeave}
              onPreviewClick={onPreviewClick}
              onPreviewTriggerRef={onPreviewTriggerRef}
            />
          )}
          {isLinkEditor ? (
            <div className="relative flex h-8 w-8 shrink-0 items-center justify-end text-right">
              <span
                className={cn(
                  "absolute inset-y-0 right-0 flex items-center justify-end text-sm text-muted-foreground transition-opacity duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
                  "font-mono",
                  !compact && "-translate-x-px",
                  linkEditor.checked
                    ? "opacity-0"
                    : "opacity-100 group-hover:opacity-0 group-focus-within:opacity-0",
                )}
              >
                {count || ""}
              </span>
            </div>
          ) : (
            <div className="relative flex h-8 w-8 shrink-0 items-center justify-end text-right">
              <span
                className={cn(
                  "absolute inset-y-0 right-0 flex items-center justify-end text-sm text-muted-foreground group-hover:opacity-0",
                  "font-mono",
                  !compact && "-translate-x-px",
                  menuOpen && "opacity-0",
                )}
              >
                {count || ""}
              </span>
              <div className={cn("absolute inset-0 flex items-center justify-end opacity-0 group-hover:opacity-100", menuOpen && "opacity-100")}>
                <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
                  <DropdownMenuTrigger asChild>
                    <button
                      data-sidebar-tag-menu-trigger
                      onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
                      onPointerDown={(e) => { e.stopPropagation(); }}
                      className="flex size-8 items-center justify-end text-muted-foreground hover:text-foreground"
                    >
                      <MoreHorizontal className="size-3" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" align="start">
                    <DropdownMenuItem onSelect={onDoubleClick}>
                      <Pencil className="size-3" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => setDeleteOpen(true)}
                    >
                      <Trash2 className="size-3" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
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
              "absolute right-0 top-1/2 z-10 inline-flex h-6 w-[10ch] -translate-y-1/2 cursor-pointer items-center justify-center rounded-1 bg-component-fill px-[1ch] font-sans text-sm font-semibold text-foreground outline-0 outline-transparent transition-opacity duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:outline-1 hover:-outline-offset-1 hover:outline-component-fill-hover focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-component-fill-hover",
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
          </div>
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
}: {
  cards: PreviewCard[];
  previewKeyPrefix: string;
  onPreviewEnter: (target: SidebarPreviewTarget) => void;
  onPreviewLeave: () => void;
  onPreviewClick: (target: SidebarPreviewTarget) => void;
  onPreviewTriggerRef: (key: string, node: HTMLElement | null) => void;
}) {
  return (
    <div
      className="flex h-8 min-w-0 flex-1 items-end gap-1 overflow-hidden"
      style={SIDEBAR_PREVIEW_MASK_STYLE}
    >
      {cards.map((card, index) => {
        const previewKey = `${previewKeyPrefix}:${card.slug ?? index}:${index}`;
        const canPreview = card.hasThumb && !!card.slug;
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
