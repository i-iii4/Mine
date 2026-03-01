import { useState, useRef, useCallback, useEffect } from "react";
import { NavLink } from "react-router";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Plus, MoreHorizontal, Search, Download, Pencil, Trash2 } from "lucide-react";
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
import type { TagCount } from "@/types";
import { cn } from "@/lib/utils";

/** Convert a normalized tag slug to a display title: `web-design` -> `Web Design` */
function titleFromTag(tag: string): string {
  return tag
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface SidebarProps {
  orderedTags: TagCount[];
  totalBlocks: number;
  isCardDragging: boolean;
  onSearchOpen: () => void;
  onImportOpen: () => void;
  onDeleteTag: (tag: string) => void;
  onRenameTag: (oldTag: string, newTag: string) => void;
  onCreateChannel: (tag: string) => void;
}

export function Sidebar({
  orderedTags,
  totalBlocks,
  isCardDragging,
  onSearchOpen,
  onImportOpen,
  onDeleteTag,
  onRenameTag,
  onCreateChannel,
}: SidebarProps) {
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const handleRename = useCallback(
    (oldTag: string, newValue: string) => {
      const trimmed = newValue.trim();
      if (trimmed) onRenameTag(oldTag, trimmed);
      setEditingTag(null);
    },
    [onRenameTag],
  );

  return (
    <aside className="relative flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-background">
      {/* Spacer for macOS traffic lights in overlay titlebar */}
      <div className="h-10 shrink-0" />
      {/* Top fade — content dissolves into the top edge */}
      <div className="pointer-events-none absolute inset-x-0 top-10 z-10 h-8 bg-gradient-to-b from-background to-transparent" />

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 pt-2" data-sidebar-scroll>
        <NavItem to="/" label="All" count={totalBlocks} end />

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
            className="mt-1 w-full justify-start rounded-md text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
          >
            <Plus className="size-3" />
            <span>New channel</span>
          </Button>
        )}
      </nav>

      {/* Bottom actions */}
      <div className="border-t border-sidebar-border p-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onImportOpen}
          className="w-full justify-start rounded-md text-muted-foreground hover:bg-sidebar-accent/50"
        >
          <Download className="size-4" />
          <span>Import from Are.na</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onSearchOpen}
          className="w-full justify-start rounded-md text-muted-foreground hover:bg-sidebar-accent/50"
        >
          <Search className="size-4" />
          <span>Search</span>
          <kbd className="ml-auto rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
            {"\u2318"}K
          </kbd>
        </Button>
      </div>

    </aside>
  );
}

// ─── Components ──────────────────────────────────────────────────────────────

function NavItem({
  to,
  label,
  count,
  end,
}: {
  to: string;
  label: string;
  count: number;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex items-center justify-between rounded-md px-3 py-1.5 text-sm transition-colors",
          isActive
            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
            : "text-muted-foreground hover:bg-sidebar-accent/50",
        )
      }
    >
      <span className="truncate">{label}</span>
      <span className="ml-2 shrink-0 text-xs text-muted-foreground">{count}</span>
    </NavLink>
  );
}

function TagNavItem({
  to,
  label,
  count,
  tag,
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
          "group relative rounded-md transition-all",
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
              "flex items-center justify-between rounded-md px-3 py-1.5 text-sm transition-colors",
              isActive
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50",
            )
          }
        >
          <span className="flex-1 truncate">{label}</span>
          <span className="ml-2 shrink-0 text-xs text-muted-foreground">{count}</span>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="ml-1 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
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

