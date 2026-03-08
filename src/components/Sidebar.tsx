import { useState, useRef, useCallback, useEffect } from "react";
import { NavLink, useLocation } from "react-router";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Plus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
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
  onDeleteTag: (tag: string) => void;
  onRenameTag: (oldTag: string, newTag: string) => void;
  onCreateChannel: (tag: string) => void;
}

export function Sidebar({
  width,
  collapsed,
  isResizing,
  orderedTags,
  channelPreviews,
  totalBlocks,
  isCardDragging,
  onDeleteTag,
  onRenameTag,
  onCreateChannel,
}: SidebarProps) {
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
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

  return (
    <aside
      className={cn(
        "relative flex shrink-0 flex-col border-r border-sidebar-border",
        collapsed && "overflow-hidden",
      )}
      style={{
        width,
        transition: isResizing ? "none" : "width 200ms ease",
      }}
    >

      {/* Navigation */}
      <nav ref={navRef} className="flex-1 overflow-y-auto px-8 pt-16" data-sidebar-scroll>
        <NavItem to="/" label="Everything" count={totalBlocks} cards={channelPreviews.get("__all__") ?? []} end />

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
              isCardDragging={isCardDragging}
              isEditing={editingTag === tc.tag}
              onDoubleClick={() => setEditingTag(tc.tag)}
              onRenameSubmit={(v) => handleRename(tc.tag, v)}
              onRenameCancel={() => setEditingTag(null)}
              onDelete={() => onDeleteTag(tc.tag)}
            />
          ))}
        </SortableContext>

        {isCreating ? (
          <InlineInput
            defaultValue=""
            placeholder="New channel..."
            onSubmit={(value) => {
              onCreateChannel(value);
              setIsCreating(false);
            }}
            onCancel={() => setIsCreating(false)}
          />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsCreating(true)}
            className="mt-1 w-full justify-start rounded-1 text-muted-foreground hover:bg-accent"
          >
            <Plus className="size-3" />
            <span>New channel</span>
          </Button>
        )}

      </nav>


    </aside>
  );
}

// ─── Components ──────────────────────────────────────────────────────────────

function NavItem({
  to,
  label,
  count,
  cards = [],
  end,
}: {
  to: string;
  label: string;
  count: number;
  cards?: PreviewCard[];
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 border-b border-sidebar-border px-3 py-1.5 font-mono text-base",
          isActive
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-muted-foreground hover:bg-accent",
        )
      }
    >
      <span className="min-w-[100px] max-w-[150px] flex-1 truncate">{label}</span>
      <div className="flex h-6 min-w-0 flex-1 items-end gap-1 overflow-hidden" style={{ maskImage: "linear-gradient(to right, black 70%, transparent 100%)" }}>
        {cards.map((card, i) => (
          <img key={i} src={card.url} className="size-6 shrink-0 rounded-none object-cover" />
        ))}
      </div>
      <div className="w-8 shrink-0 text-right">
        <span className="text-sm text-muted-foreground">{count || ""}</span>
      </div>
    </NavLink>
  );
}

function TagNavItem({
  to,
  label,
  count,
  tag,
  cards,
  isCardDragging,
  isEditing,
  onDoubleClick,
  onRenameSubmit,
  onRenameCancel,
  onDelete,
}: {
  to: string;
  label: string;
  count: number;
  tag: string;
  cards: PreviewCard[];
  isCardDragging: boolean;
  isEditing: boolean;
  onDoubleClick: () => void;
  onRenameSubmit: (value: string) => void;
  onRenameCancel: () => void;
  onDelete: () => void;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);

  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: `tag:${tag}` });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
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
          onDoubleClick={(e) => {
            e.preventDefault();
            onDoubleClick();
          }}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2 border-b border-sidebar-border px-3 py-1.5 font-mono text-base",
              isActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-accent",
            )
          }
        >
          <span className="min-w-[100px] max-w-[150px] flex-1 truncate">{label}</span>
          <div className="flex h-6 min-w-0 flex-1 items-end gap-1 overflow-hidden" style={{ maskImage: "linear-gradient(to right, black 70%, transparent 100%)" }}>
            {cards.map((card, i) => (
              <img
                key={i}
                src={card.url}
                className="size-6 shrink-0 rounded-none object-cover"
                loading="lazy"
              />
            ))}
          </div>
          <div className="relative w-8 shrink-0 text-right">
            <span className="text-sm text-muted-foreground group-hover:opacity-0">{count || ""}</span>
            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100">
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                        className="shrink-0 text-muted-foreground hover:text-hover-foreground"
                      >
                        <MoreHorizontal className="size-3" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="right">Options</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="start">
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


