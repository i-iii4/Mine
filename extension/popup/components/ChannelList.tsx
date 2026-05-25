import { useMemo } from "react";
import {
  COLLECTION_PICKER_INLINE_SURFACE_CLASS,
  CollectionPicker,
} from "@/components/CollectionPicker";
import type { TagCount } from "@/types";
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
  const tags = useMemo<TagCount[]>(() => {
    const recentSet = new Set(recentTags);
    return channels
      .map((channel) => ({
        tag: channel.tag,
        count: channel.block_count,
      }))
      .sort((a, b) => {
        const aRecent = recentSet.has(a.tag);
        const bRecent = recentSet.has(b.tag);
        if (aRecent && !bRecent) return -1;
        if (!aRecent && bRecent) return 1;
        if (aRecent && bRecent) {
          return recentTags.indexOf(a.tag) - recentTags.indexOf(b.tag);
        }
        return b.count - a.count;
      });
  }, [channels, recentTags]);

  return (
    <div className={COLLECTION_PICKER_INLINE_SURFACE_CLASS}>
      <CollectionPicker
        blockSlug="__clipper__"
        selectedTags={selectedTags}
        tags={tags}
        onToggleTag={(_slug, tag) => onToggle(tag)}
        onCreateAndAssign={(tag) => onCreate(tag)}
        autoFocusSearch={false}
        stopKeyPropagation
      />
    </div>
  );
}
