import { Trash2 } from "lucide-react";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import type { LightBlock, TagCount } from "@/types";
import { CollectionPicker } from "./CollectionPicker";

interface CardTagMenuProps {
  block: LightBlock;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestDelete: (slug: string) => void;
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
  onRequestDelete,
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

      {/* Delete — fixed at bottom */}
      <div className="shrink-0">
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onSelect={() => onRequestDelete(block.slug)}
        >
          <Trash2 className="size-3" />
          Delete card
        </ContextMenuItem>
      </div>
    </ContextMenuContent>
  );
}
