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
  onToggle: (tag: string) => void;
  onCreate: (name: string) => void;
}

export function ChannelList({
  channels,
  selectedTags,
  onToggle,
  onCreate,
}: ChannelListProps) {
  // Canonical collection order: exactly what the backend returns — sidebar
  // positions first, positionless tags after (single source of ordering).
  const tags = useMemo<TagCount[]>(() => {
    return channels.map((channel) => ({
      tag: channel.tag,
      count: channel.block_count,
    }));
  }, [channels]);

  return (
    // The quantized list inside re-measures on squeeze and yields rows down
    // to this floor (search row + two channel rows), never to zero. Above the
    // floor the picker keeps its usual capped height with its own scroll.
    <div className={`${COLLECTION_PICKER_INLINE_SURFACE_CLASS} min-h-[136px]`}>
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
