import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink, Plus } from "lucide-react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { LightBlock, TagCount } from "@/types";
import { getBlock } from "@/lib/commands";
import { collectionRefLabel } from "@/lib/collections";
import {
  COLLECTION_PICKER_CONTENT_CLASS,
  CollectionPicker,
} from "./CollectionPicker";

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

function MenuIconSlot({ children }: { children?: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-3 shrink-0 items-center justify-center"
      data-card-menu-icon-slot=""
    >
      {children}
    </span>
  );
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
          <MenuIconSlot>
            <Plus className="size-3" />
          </MenuIconSlot>
          Connect
        </ContextMenuSubTrigger>
        <ContextMenuSubContent widthRole="picker" className={COLLECTION_PICKER_CONTENT_CLASS}>
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
          <MenuIconSlot>
            <ExternalLink className="size-3" />
          </MenuIconSlot>
          Source
        </ContextMenuItem>
      )}

      <ContextMenuSeparator />

      <ContextMenuItem onSelect={() => revealItemInDir(filePath)}>
        <MenuIconSlot />
        Reveal in Finder
      </ContextMenuItem>

      <ContextMenuItem onSelect={() => navigator.clipboard.writeText(filePath)}>
        <MenuIconSlot />
        Copy Path
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuItem onSelect={() => onRequestRename(block)}>
        <MenuIconSlot />
        Rename…
      </ContextMenuItem>

      {currentTag && selectedTags.includes(currentTag) && (
        <ContextMenuItem onSelect={() => onToggleTag(block.slug, currentTag, true)}>
          <MenuIconSlot />
          Disconnect from &ldquo;{collectionRefLabel(currentTag)}&rdquo;
        </ContextMenuItem>
      )}

      <ContextMenuItem
        variant="destructive"
        onSelect={() => onRequestDelete(block.slug)}
      >
        <MenuIconSlot />
        Delete
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
