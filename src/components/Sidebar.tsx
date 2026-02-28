import { useState, useRef, useCallback, useEffect } from "react";
import { NavLink } from "react-router";
import { useDroppable } from "@dnd-kit/core";
import type { TagCount } from "@/types";

/** Convert a normalized tag slug to a display title: `web-design` -> `Web Design` */
function titleFromTag(tag: string): string {
  return tag
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface SidebarProps {
  tags: TagCount[];
  totalBlocks: number;
  onSearchOpen: () => void;
  onImportOpen: () => void;
  onDeleteTag: (tag: string) => void;
  onRenameTag: (oldTag: string, newTag: string) => void;
}

interface TagMenuState {
  tag: string;
  label: string;
  x: number;
  y: number;
}

export function Sidebar({
  tags,
  totalBlocks,
  onSearchOpen,
  onImportOpen,
  onDeleteTag,
  onRenameTag,
}: SidebarProps) {
  const sortedTags = [...tags].sort((a, b) => a.tag.localeCompare(b.tag));

  // ── State ──────────────────────────────────────────────────────────────
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [tagMenu, setTagMenu] = useState<TagMenuState | null>(null);

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
    <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
      {/* Header */}
      <div className="p-4 text-sm font-semibold uppercase tracking-wider text-neutral-400">
        Local Arena
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2" data-sidebar-scroll>
        <NavItem to="/" label="All" count={totalBlocks} end />

        {/* Tags */}
        <TagsHeader />
        {sortedTags.map((tc) => (
          <TagNavItem
            key={tc.tag}
            to={`/channel/${encodeURIComponent(tc.tag)}`}
            label={titleFromTag(tc.tag)}
            count={tc.count}
            tag={tc.tag}
            isEditing={editingTag === tc.tag}
            onMenuOpen={(e) => handleMenuOpen(tc.tag, titleFromTag(tc.tag), e)}
            onDoubleClick={() => setEditingTag(tc.tag)}
            onRenameSubmit={(v) => handleRename(tc.tag, v)}
            onRenameCancel={() => setEditingTag(null)}
          />
        ))}
      </nav>

      {/* Bottom actions */}
      <div className="border-t border-neutral-200 p-2 dark:border-neutral-800">
        <button
          onClick={onImportOpen}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-neutral-500 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-900"
        >
          <ImportIcon />
          <span>Import from Are.na</span>
        </button>
        <button
          onClick={onSearchOpen}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-neutral-500 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-900"
        >
          <SearchIcon />
          <span>Search</span>
          <kbd className="ml-auto rounded border border-neutral-300 px-1.5 py-0.5 text-xs text-neutral-400 dark:border-neutral-700">
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

function TagsHeader() {
  return (
    <div className="mx-3 mt-4 mb-1 flex items-center">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-neutral-400">
        Tags
      </span>
    </div>
  );
}

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
        `flex items-center justify-between rounded-md px-3 py-1.5 text-sm transition-colors ${
          isActive
            ? "bg-neutral-200 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
            : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
        }`
      }
    >
      <span className="truncate">{label}</span>
      <span className="ml-2 shrink-0 text-xs text-neutral-400">{count}</span>
    </NavLink>
  );
}

function TagNavItem({
  to,
  label,
  count,
  tag,
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
  isEditing: boolean;
  onMenuOpen: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onRenameSubmit: (value: string) => void;
  onRenameCancel: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `tag:${tag}` });

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
      className={`group relative rounded-md transition-all ${
        isOver ? "ring-2 ring-blue-400 ring-inset" : ""
      }`}
    >
      <NavLink
        to={to}
        onDoubleClick={(e) => {
          e.preventDefault();
          onDoubleClick();
        }}
        className={({ isActive }) =>
          `flex items-center justify-between rounded-md px-3 py-1.5 text-sm transition-colors ${
            isActive
              ? "bg-neutral-200 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
              : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
          }`
        }
      >
        <span className="flex-1 truncate">{label}</span>
        <span className="ml-2 shrink-0 text-xs text-neutral-400">{count}</span>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onMenuOpen(e);
          }}
          className="ml-1 shrink-0 rounded p-0.5 text-neutral-400 opacity-0 transition-opacity hover:text-neutral-600 group-hover:opacity-100 dark:hover:text-neutral-300"
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
      className="fixed z-50 min-w-36 rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
      style={{ left: x, top: y }}
    >
      {confirming ? (
        <>
          <p className="px-3 py-1.5 text-xs text-neutral-500">
            Remove tag from all cards.
          </p>
          <button
            onClick={onDelete}
            className="flex w-full px-3 py-1.5 text-sm font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
          >
            Confirm delete
          </button>
          <button
            onClick={() => setConfirming(false)}
            className="flex w-full px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700"
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <button
            onClick={onRename}
            className="flex w-full px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-700"
          >
            Rename
          </button>
          <button
            onClick={() => setConfirming(true)}
            className="flex w-full px-3 py-1.5 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
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
      className="mx-1 w-[calc(100%-0.5rem)] rounded-md border border-blue-400 bg-white px-3 py-1.5 text-sm outline-none dark:border-blue-600 dark:bg-neutral-900"
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
