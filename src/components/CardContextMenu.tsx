import {
  ContextMenuContent,
} from "@/components/ui/context-menu";
import type { LightBlock, TagCount } from "@/types";
import { CollectionPicker } from "./CollectionPicker";

interface CardTagMenuProps {
  block: LightBlock;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
}

/**
 * Renders ContextMenuContent with tag management UI.
 * Must be used inside a <ContextMenu> wrapper.
 */
export function CardTagMenu({
  block,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
}: CardTagMenuProps) {
  return (
    <ContextMenuContent className="flex w-64 max-h-80 flex-col overflow-hidden p-0">
      <CollectionPicker
        block={block}
        tags={tags}
        currentTag={currentTag}
        onToggleTag={onToggleTag}
        onCreateAndAssign={onCreateAndAssign}
        stopKeyPropagation
      />
    </ContextMenuContent>
  );
}
