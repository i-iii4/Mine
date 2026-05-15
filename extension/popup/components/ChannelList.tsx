import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { ChannelInfo } from "../lib/messaging";

interface ChannelListProps {
  channels: ChannelInfo[];
  selectedTags: string[];
  recentTags: string[];
  onToggle: (tag: string) => void;
  onCreate: (name: string) => void;
}

export function ChannelList({
  channels,
  selectedTags,
  recentTags,
  onToggle,
  onCreate,
}: ChannelListProps) {
  const [filter, setFilter] = useState("");
  const lc = filter.toLowerCase();

  // Stable order: once we're showing the list, toggling a checkbox must
  // not move that row. Sort ONLY by recentTags order and block_count —
  // independent of selectedTags, so selection changes don't reshuffle.
  const filtered = useMemo(() => {
    const list = lc
      ? channels.filter(
          (ch) =>
            collectionRefLabel(ch.tag).toLowerCase().includes(lc) ||
            ch.tag.toLowerCase().includes(lc),
        )
      : channels.slice();

    const recentSet = new Set(recentTags);
    list.sort((a, b) => {
      const aRecent = recentSet.has(a.tag);
      const bRecent = recentSet.has(b.tag);
      if (aRecent && !bRecent) return -1;
      if (!aRecent && bRecent) return 1;
      if (aRecent && bRecent) {
        return recentTags.indexOf(a.tag) - recentTags.indexOf(b.tag);
      }
      return b.block_count - a.block_count;
    });

    return list;
  }, [channels, lc, recentTags]);

  const showCreate = filter.trim() && filtered.length === 0;

  return (
    <div className="flex flex-col gap-2">
      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search channels..."
        className="h-8 shrink-0"
      />

      <div className="max-h-[260px] overflow-y-auto rounded-1 border border-border">
        {filtered.map((ch) => {
          const selected = selectedTags.includes(ch.tag);
          const label = collectionRefLabel(ch.tag);
          return (
            <label
              key={ch.tag}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 border-b border-border px-2 py-1.5 text-left text-base last:border-b-0",
                "hover:bg-accent",
                selected && "font-semibold",
              )}
            >
              <Checkbox
                checked={selected}
                onCheckedChange={() => onToggle(ch.tag)}
              />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <span className="shrink-0 text-sm text-muted-foreground">{ch.block_count}</span>
            </label>
          );
        })}

        {showCreate && (
          <button
            onClick={() => {
              const name = filter.trim();
              onCreate(name);
              setFilter("");
            }}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-base font-semibold hover:bg-accent"
          >
            <span className="flex size-4 shrink-0 items-center justify-center rounded-[2px] border border-input text-[10px]">
              +
            </span>
            <span>Create &ldquo;{filter.trim()}&rdquo;</span>
          </button>
        )}

        {filtered.length === 0 && !showCreate && (
          <p className="p-3 text-center text-sm text-muted-foreground">No channels yet</p>
        )}
      </div>
    </div>
  );
}

function collectionRefLabel(ref: string): string {
  const parts = ref.split("/");
  return (parts[parts.length - 1] ?? ref).trim();
}
