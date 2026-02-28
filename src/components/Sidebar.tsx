import { useState, useRef, useCallback, useEffect } from "react";
import { NavLink } from "react-router";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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

interface TagMenuState {
  tag: string;
  label: string;
  x: number;
  y: number;
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
  // ── State ──────────────────────────────────────────────────────────────
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [tagMenu, setTagMenu] = useState<TagMenuState | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // ── Tag CRUD handlers ─────────────────────────────────────────────────

  const handleRename = useCallback(
    (oldTag: string, newValue: string) => {
      const trimmed = newValue.trim();
      if (trimmed) onRenameTag(oldTag, trimmed);
      setEditingTag(null);
    },
    [onRenameTag],
  );

  const handleMenuOpen = useCallback(
    (tag: string, label: string, e: React.MouseEvent) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setTagMenu({ tag, label, x: rect.left, y: rect.bottom + 4 });
    },
    [],
  );

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      {/* Header */}
      <div className="p-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Local Arena
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2" data-sidebar-scroll>
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
              onMenuOpen={(e) => handleMenuOpen(tc.tag, titleFromTag(tc.tag), e)}
              onDoubleClick={() => setEditingTag(tc.tag)}
              onRenameSubmit={(v) => handleRename(tc.tag, v)}
              onRenameCancel={() => setEditingTag(null)}
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
          <button
            onClick={() => setIsCreating(true)}
            className="mt-1 flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <PlusIcon />
            <span>New channel</span>
          </button>
        )}
      </nav>

      {/* Bottom actions */}
      <div className="border-t border-sidebar-border p-2">
        <button
          onClick={onImportOpen}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent"
        >
          <ImportIcon />
          <span>Import from Are.na</span>
        </button>
        <button
          onClick={onSearchOpen}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent"
        >
          <SearchIcon />
          <span>Search</span>
          <kbd className="ml-auto rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
            {"\u2318"}K
          </kbd>
        </button>
      </div>

      {/* Tag context menu */}
      {tagMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setTagMenu(null)}
          />
          <TagMenu
            x={tagMenu.x}
            y={tagMenu.y}
            onRename={() => {
              setEditingTag(tagMenu.tag);
              setTagMenu(null);
            }}
            onDelete={() => {
              onDeleteTag(tagMenu.tag);
              setTagMenu(null);
            }}
            onClose={() => setTagMenu(null)}
          />
        </>
      )}
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
            : "text-muted-foreground hover:bg-sidebar-accent",
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
  onMenuOpen,
  onDoubleClick,
  onRenameSubmit,
  onRenameCancel,
}: {
  to: string;
  label: string;
  count: number;
  tag: string;
  isCardDragging: boolean;
  isEditing: boolean;
  onMenuOpen: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onRenameSubmit: (value: string) => void;
  onRenameCancel: () => void;
}) {
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
              : "text-muted-foreground hover:bg-sidebar-accent",
          )
        }
      >
        <span className="flex-1 truncate">{label}</span>
        <span className="ml-2 shrink-0 text-xs text-muted-foreground">{count}</span>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onMenuOpen(e);
          }}
          className="ml-1 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
        >
          <EllipsisIcon />
        </button>
      </NavLink>
    </div>
  );
}

function TagMenu({
  x,
  y,
  onRename,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed z-50 min-w-36 rounded-lg border border-border bg-popover py-1 shadow-lg"
      style={{ left: x, top: y }}
    >
      {confirming ? (
        <>
          <p className="px-3 py-1.5 text-xs text-muted-foreground">
            Remove tag from all cards.
          </p>
          <button
            onClick={onDelete}
            className="flex w-full px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10"
          >
            Confirm delete
          </button>
          <button
            onClick={() => setConfirming(false)}
            className="flex w-full px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <button
            onClick={onRename}
            className="flex w-full px-3 py-1.5 text-sm text-popover-foreground hover:bg-accent"
          >
            Rename
          </button>
          <button
            onClick={() => setConfirming(true)}
            className="flex w-full px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
          >
            Delete
          </button>
        </>
      )}
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
    <input
      ref={ref}
      type="text"
      defaultValue={defaultValue}
      placeholder={placeholder}
      className="mx-1 w-[calc(100%-0.5rem)] rounded-md border border-ring bg-background px-3 py-1.5 text-sm outline-none"
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

// ─── Icons ───────────────────────────────────────────────────────────────────

function PlusIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M6 2v8M2 6h8" />
    </svg>
  );
}

function EllipsisIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="currentColor"
    >
      <circle cx="2" cy="6" r="1.2" />
      <circle cx="6" cy="6" r="1.2" />
      <circle cx="10" cy="6" r="1.2" />
    </svg>
  );
}

function ImportIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 2v8M5 7l3 3 3-3" />
      <path d="M2 11v2a1 1 0 001 1h10a1 1 0 001-1v-2" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}
