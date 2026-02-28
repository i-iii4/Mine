import { useState, useEffect, useRef, useCallback } from "react";
import { search as searchCommand } from "@/lib/commands";
import type { IndexedBlock } from "@/types";
import { cn } from "@/lib/utils";

const DEBOUNCE_MS = 200;

interface SearchProps {
  open: boolean;
  onClose: () => void;
  onSelect: (block: IndexedBlock) => void;
}

export function Search({ open, onClose, onSelect }: SearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<IndexedBlock[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setSelectedIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Debounced search
  const runSearch = useCallback((q: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    timerRef.current = setTimeout(async () => {
      try {
        const res = await searchCommand(q);
        setResults(res);
        setSelectedIdx(0);
      } catch {
        setResults([]);
      }
    }, DEBOUNCE_MS);
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    runSearch(val);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[selectedIdx]) {
      onSelect(results[selectedIdx]);
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center gap-2 border-b border-border px-4">
          <SearchIcon />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Search blocks..."
            className="w-full bg-transparent py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
            esc
          </kbd>
        </div>

        {/* Results */}
        {results.length > 0 && (
          <ul className="max-h-80 overflow-y-auto py-2">
            {results.map((block, idx) => (
              <li
                key={block.id}
                className={cn(
                  "flex cursor-pointer items-center gap-3 px-4 py-2 text-sm",
                  idx === selectedIdx && "bg-accent",
                )}
                onClick={() => {
                  onSelect(block);
                  onClose();
                }}
                onMouseEnter={() => setSelectedIdx(idx)}
              >
                <TypeBadge type={block.block_type} />
                <span className="truncate text-foreground">
                  {block.title ?? block.slug}
                </span>
                {block.tags.length > 0 && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {block.tags.slice(0, 2).join(", ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {query.trim() && results.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No results
          </div>
        )}
      </div>
    </div>
  );
}

function TypeBadge({ type }: { type: string }) {
  const labels: Record<string, string> = {
    image: "IMG",
    link: "URL",
    article: "TXT",
    video: "VID",
    file: "FILE",
  };
  return (
    <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
      {labels[type] ?? type.toUpperCase()}
    </span>
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
      className="shrink-0 text-muted-foreground"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}
