import {
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { useEffect, useState } from "react";
import type { TagCount } from "@/types";
import { getBlock } from "@/lib/commands";
import { CollectionPicker } from "./CollectionPicker";

interface CardTagMenuProps {
  blockSlug: string;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestDelete: (blockSlug: string) => void;
}

/**
 * Renders ContextMenuContent with tag management UI.
 * Must be used inside a <ContextMenu> wrapper.
 */
export function CardTagMenu({
  blockSlug,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestDelete,
}: CardTagMenuProps) {
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void getBlock(blockSlug).then((block) => {
      if (!cancelled) {
        setSelectedTags(block?.tags ?? []);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [blockSlug]);

  return (
    <ContextMenuContent className="flex w-64 max-h-80 flex-col overflow-hidden p-0">
      <CollectionPicker
        blockSlug={blockSlug}
        selectedTags={selectedTags}
        tags={tags}
        currentTag={currentTag}
        onToggleTag={onToggleTag}
        onCreateAndAssign={onCreateAndAssign}
        stopKeyPropagation
      />
      <ContextMenuItem variant="destructive" onSelect={() => onRequestDelete(blockSlug)}>
        Delete
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
