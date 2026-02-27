import { NavLink } from "react-router";
import type { ChannelDto } from "@/types";

interface SidebarProps {
  channels: ChannelDto[];
  totalBlocks: number;
  onSearchOpen: () => void;
}

export function Sidebar({ channels, totalBlocks, onSearchOpen }: SidebarProps) {
  const sorted = [...channels].sort((a, b) => a.position - b.position);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
      {/* Header */}
      <div className="p-4 text-sm font-semibold uppercase tracking-wider text-neutral-400">
        Local Arena
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2">
        <NavItem to="/" label="All" count={totalBlocks} end />

        {sorted.length > 0 && (
          <>
            <div className="mx-2 my-2 border-t border-neutral-200 dark:border-neutral-800" />
            {sorted.map((ch) => (
              <NavItem
                key={ch.tag}
                to={`/channel/${encodeURIComponent(ch.tag)}`}
                label={ch.title}
                count={ch.block_count}
              />
            ))}
          </>
        )}
      </nav>

      {/* Search trigger */}
      <div className="border-t border-neutral-200 p-2 dark:border-neutral-800">
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
    </aside>
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
