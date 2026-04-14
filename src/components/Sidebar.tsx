import { useState, useRef, useCallback, useEffect, memo } from "react";
import { NavLink, useLocation } from "react-router";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import type { TagCount, PreviewCard } from "@/types";
import { cn } from "@/lib/utils";

/** Convert a normalized tag slug to a display title: `web-design` -> `Web Design` */
function titleFromTag(tag: string): string {
  return tag
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface SidebarProps {
  width: number;
  collapsed: boolean;
  isResizing: boolean;
  orderedTags: TagCount[];
  channelPreviews: Map<string, PreviewCard[]>;
  totalBlocks: number;
  isCardDragging: boolean;
  isCreatingChannel: boolean;
  onSetCreatingChannel: (v: boolean) => void;
  onDeleteTag: (tag: string) => void;
  onRenameTag: (oldTag: string, newTag: string) => void;
  onCreateChannel: (tag: string) => void;
  onNavClick?: () => void;
  onScrollToTop?: () => void;
}

export function Sidebar({
  width,
  collapsed,
  isResizing,
  orderedTags,
  channelPreviews,
  totalBlocks,
  isCardDragging,
  isCreatingChannel,
  onSetCreatingChannel,
  onDeleteTag,
  onRenameTag,
  onCreateChannel,
  onNavClick,
  onScrollToTop,
}: SidebarProps) {
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const location = useLocation();

  // Auto-scroll sidebar to the active channel (e.g. after Opt+Cmd+Arrow)
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const active = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (active) {
      active.scrollIntoView({ block: "nearest", behavior: "smooth" });
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

      {/* Navigation */}
      <nav ref={navRef} className={cn("flex-1 overflow-y-auto pt-16", compact ? "px-2" : "px-8")} data-sidebar-scroll>
        <NavItem to="/" label="Everything" count={totalBlocks} cards={channelPreviews.get("__all__") ?? []} compact={compact} end onClick={onNavClick} onSameClick={onScrollToTop} />

        <SortableContext
          items={orderedTags.map((tc) => `tag:${tc.tag}`)}
          strategy={verticalListSortingStrategy}
        >
          {orderedTags.map((tc) => (
            <TagNavItem
              key={tc.tag}
              to={`/channel/${encodeURIComponent(tc.tag)}`}
              label={titleFromTag(tc.tag)}
              count={tc.count}
              tag={tc.tag}
              cards={channelPreviews.get(tc.tag) ?? []}
              compact={compact}
              isCardDragging={isCardDragging}
              isEditing={editingTag === tc.tag}
              onDoubleClick={() => setEditingTag(tc.tag)}
              onRenameSubmit={(v) => handleRename(tc.tag, v)}
              onRenameCancel={() => setEditingTag(null)}
              onDelete={() => onDeleteTag(tc.tag)}
              onClick={onNavClick}
              onSameClick={onScrollToTop}
            />
          ))}
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


    </aside>
  );
}

// ─── Components ──────────────────────────────────────────────────────────────

const NavItem = memo(function NavItem({
  to,
  label,
  count,
  cards = [],
  compact,
  end,
  onClick,
  onSameClick,
}: {
  to: string;
  label: string;
  count: number;
  cards?: PreviewCard[];
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
      className={({ isActive }) =>
        compact
          ? cn(
              "flex w-full items-center gap-2 overflow-hidden rounded-1 p-2 text-base",
              isActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-accent",
            )
          : cn(
              "flex items-center gap-2 border-b border-sidebar-border px-3 py-1 font-mono text-base",
              isActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-accent",
            )
      }
    >
      <span className={compact ? "flex-1 truncate" : "min-w-[100px] max-w-[150px] flex-1 truncate"}>{label}</span>
      {!compact && (
        <div className="flex h-8 min-w-0 flex-1 items-end gap-1 overflow-hidden" style={{ maskImage: "linear-gradient(to right, black 70%, transparent 100%)" }}>
          {cards.map((card, i) => card.text ? (
            <div key={i} className="size-8 shrink-0 bg-accent">
              <img src={card.url} className="size-8 object-cover dark:invert" />
            </div>
          ) : (
            <img key={i} src={card.url} className="size-8 shrink-0 rounded-none object-cover" />
          ))}
        </div>
      )}
      <span className="w-8 shrink-0 text-right text-sm text-muted-foreground">{count || ""}</span>
    </NavLink>
  );
});

const TagNavItem = memo(function TagNavItem({
  to,
  label,
  count,
  tag,
  cards,
  compact,
  isCardDragging,
  isEditing,
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
  compact?: boolean;
  isCardDragging: boolean;
  isEditing: boolean;
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
  // Disabled while dragging (`isCardDragging`) so dnd-kit's
  // getBoundingClientRect calls on drop targets always return real
  // geometry instead of the intrinsic placeholder.
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(!isCardDragging && !isDragging
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
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        className={cn(
          "group relative rounded-1",
          isDragging && "opacity-30",
          isOver && !isDragging && isCardDragging && "ring-2 ring-ring ring-inset",
        )}
      >
        <NavLink
          to={to}
          draggable="false"
          onClick={(e) => {
            if (isDragging || isCardDragging) {
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
            e.preventDefault();
            onDoubleClick();
          }}
          className={({ isActive }) =>
            compact
              ? cn(
                  "flex w-full items-center gap-2 overflow-hidden rounded-1 p-2 text-base",
                  isActive
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                )
              : cn(
                  "flex items-center gap-2 border-b border-sidebar-border px-3 py-1 font-mono text-base",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-accent",
                )
          }
        >
          <span className={compact ? "flex-1 truncate" : "min-w-[100px] max-w-[150px] flex-1 truncate"}>{label}</span>
          {!compact && (
            <>
              <div className="flex h-8 min-w-0 flex-1 items-end gap-1 overflow-hidden" style={{ maskImage: "linear-gradient(to right, black 70%, transparent 100%)" }}>
                {cards.map((card, i) => card.text ? (
                  <div key={i} className="size-8 shrink-0 bg-accent">
                    <img src={card.url} className="size-8 object-cover dark:invert" loading="lazy" />
                  </div>
                ) : (
                  <img key={i} src={card.url} className="size-8 shrink-0 rounded-none object-cover" loading="lazy" />
                ))}
              </div>
            </>
          )}
          <div className="relative w-8 shrink-0 text-right">
            <span className={cn("text-sm text-muted-foreground group-hover:opacity-0", menuOpen && "opacity-0")}>{count || ""}</span>
            <div className={cn("absolute inset-0 flex items-center justify-end opacity-0 group-hover:opacity-100", menuOpen && "opacity-100")}>
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
                    <DropdownMenuTrigger asChild>
                      <button
                        onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
                        onPointerDown={(e) => { e.stopPropagation(); }}
                        className="text-muted-foreground hover:text-foreground"
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
        </NavLink>
      </div>

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


