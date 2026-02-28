import { useState, useEffect, useRef, useCallback } from "react";
import { search as searchCommand } from "@/lib/commands";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { IndexedBlock } from "@/types";

const DEBOUNCE_MS = 200;

interface SearchProps {
  open: boolean;
  onClose: () => void;
  onSelect: (block: IndexedBlock) => void;
}

export function Search({ open, onClose, onSelect }: SearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<IndexedBlock[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Reset state when opened
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
    }
  }, [open]);

  // Debounced search via IPC
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
      } catch {
        setResults([]);
      }
    }, DEBOUNCE_MS);
  }, []);

  const handleValueChange = (value: string) => {
    setQuery(value);
    runSearch(value);
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="gap-0 overflow-hidden p-0" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>Search blocks in vault</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={handleValueChange}
            placeholder="Search blocks..."
          />
          <CommandList>
            {query.trim() && results.length === 0 && (
              <CommandEmpty>No results</CommandEmpty>
            )}
            {results.map((block) => (
              <CommandItem
                key={block.id}
                value={String(block.id)}
                onSelect={() => {
                  onSelect(block);
                  onClose();
                }}
                className="gap-3"
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
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
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
    <Badge variant="secondary" className="text-[10px] font-semibold text-muted-foreground">
      {labels[type] ?? type.toUpperCase()}
    </Badge>
  );
}
