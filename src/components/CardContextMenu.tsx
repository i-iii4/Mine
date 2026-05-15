import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { useEffect, useState } from "react";
import { Copy, ExternalLink, FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { LightBlock, TagCount } from "@/types";
import { getBlock } from "@/lib/commands";
import { collectionRefLabel } from "@/lib/collections";
import { CollectionPicker } from "./CollectionPicker";

interface CardTagMenuProps {
  block: LightBlock;
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestRename: (block: LightBlock) => void;
  onRequestDelete: (blockSlug: string) => void;
}

/**
 * ContextMenuContent rendered on right-click — mirrors the overflow
 * menu from `CardHoverMenu` so the two entry points produce the same
 * set of actions. Must be used inside a <ContextMenu> wrapper that
 * provides the radix trigger.
 */
export function CardTagMenu({
  block,
  vaultPath,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
}: CardTagMenuProps) {
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const filePath = `${vaultPath}/${block.slug}.md`;
  const hasUrl = !!block.url;

  useEffect(() => {
    let cancelled = false;
    void getBlock(block.slug).then((full) => {
      if (!cancelled) {
        setSelectedTags(full?.tags ?? []);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [block.slug]);

  return (
    <ContextMenuContent>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Plus className="size-3" />
          Connect
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="flex w-64 max-h-80 flex-col overflow-hidden p-0">
          <CollectionPicker
            blockSlug={block.slug}
            selectedTags={selectedTags}
            tags={tags}
            currentTag={currentTag}
            onToggleTag={onToggleTag}
            onCreateAndAssign={onCreateAndAssign}
            stopKeyPropagation
          />
        </ContextMenuSubContent>
      </ContextMenuSub>

      {hasUrl && (
        <ContextMenuItem onSelect={() => openUrl(block.url!)}>
          <ExternalLink className="size-3" />
          Source
        </ContextMenuItem>
      )}

      <ContextMenuSeparator />

      <ContextMenuItem onSelect={() => revealItemInDir(filePath)}>
        <FolderOpen className="size-3" />
        Reveal in Finder
      </ContextMenuItem>

      <ContextMenuItem onSelect={() => navigator.clipboard.writeText(filePath)}>
        <Copy className="size-3" />
        Copy Path
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuItem onSelect={() => onRequestRename(block)}>
        <Pencil className="size-3" />
        Rename…
      </ContextMenuItem>

      {currentTag && selectedTags.includes(currentTag) && (
        <ContextMenuItem onSelect={() => onToggleTag(block.slug, currentTag, true)}>
          Remove from &ldquo;{collectionRefLabel(currentTag)}&rdquo;
        </ContextMenuItem>
      )}

      <ContextMenuItem
        variant="destructive"
        onSelect={() => onRequestDelete(block.slug)}
      >
        <Trash2 className="size-3" />
        Delete
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
