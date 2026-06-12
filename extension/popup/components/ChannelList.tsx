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
