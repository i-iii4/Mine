import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
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

  const filtered = useMemo(() => {
    const list = lc
      ? channels.filter(
          (ch) => ch.title.toLowerCase().includes(lc) || ch.tag.toLowerCase().includes(lc),
        )
      : channels.slice();

    const recentSet = new Set(recentTags);
    list.sort((a, b) => {
      const aSel = selectedTags.includes(a.tag);
      const bSel = selectedTags.includes(b.tag);
      if (aSel !== bSel) return aSel ? -1 : 1;

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
  }, [channels, lc, selectedTags, recentTags]);

  const showCreate = filter.trim() && filtered.length === 0;

  return (
    <div className="flex h-full flex-col gap-1">
      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search channels..."
        className="h-8 shrink-0"
      />

      <p className="shrink-0 px-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {lc ? "Channels" : "Recent"}
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-1 border border-border">
        {filtered.map((ch) => {
          const selected = selectedTags.includes(ch.tag);
          return (
            <button
              key={ch.tag}
              onClick={() => onToggle(ch.tag)}
              className={cn(
                "flex w-full items-center gap-2 border-b border-border px-2 py-1 text-left text-sm",
                "hover:bg-accent",
                selected && "font-semibold",
              )}
            >
              <span
                className={cn(
                  "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border text-[10px]",
                  selected
                    ? "border-foreground bg-foreground text-background"
                    : "border-border",
                )}
              >
                {selected ? "\u2713" : ""}
              </span>
              <span className="min-w-0 flex-1 truncate">{ch.title}</span>
              <span className="shrink-0 text-sm text-muted-foreground">{ch.block_count}</span>
            </button>
          );
        })}

        {showCreate && (
          <button
            onClick={() => {
              const name = filter.trim();
              onCreate(name);
              setFilter("");
            }}
            className="flex w-full items-center gap-2 px-2 py-1 text-left text-sm font-semibold hover:bg-accent"
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border border-border text-[10px]">
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
