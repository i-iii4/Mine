import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { ExternalLink, Plus, Trash2, Unlink } from "lucide-react";
import type { LightBlock, TagCount } from "@/types";
import { collectionRefLabel } from "@/lib/collections";
import { isSafeUrl } from "@/lib/assets";
import { MenuIconSlot } from "@/components/ui/menu-icon-slot";
import {
  COLLECTION_PICKER_CONTENT_CLASS,
  CollectionPicker,
} from "./CollectionPicker";
import { COPY_PATH_FAILED_TITLE, copyTextToClipboard } from "@/lib/clipboard";
import { openLinkInBrowser, revealInFinder } from "@/lib/systemActions";
import { useCardMembership } from "@/hooks/useCardMembership";

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
  // The collections the feed knows, then what the file says (Е6.12).
  const selectedTags = useCardMembership(block, true);
  const filePath = `${vaultPath}/${block.slug}.md`;
  const hasUrl = block.url != null && isSafeUrl(block.url);

  return (
    <ContextMenuContent>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <MenuIconSlot>
            <Plus className="size-[13px]" />
          </MenuIconSlot>
          Connect
        </ContextMenuSubTrigger>
        <ContextMenuSubContent widthRole="search" className={COLLECTION_PICKER_CONTENT_CLASS}>
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
        <ContextMenuItem onSelect={() => openLinkInBrowser(block.url!)}>
          <MenuIconSlot>
            <ExternalLink className="size-[13px]" />
          </MenuIconSlot>
          Source
        </ContextMenuItem>
      )}

      <ContextMenuSeparator />

      <ContextMenuItem onSelect={() => revealInFinder(filePath)}>
        <MenuIconSlot />
        Reveal in Finder
      </ContextMenuItem>

      <ContextMenuItem onSelect={() => copyTextToClipboard(filePath, COPY_PATH_FAILED_TITLE)}>
        <MenuIconSlot />
        Copy Path
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuItem onSelect={() => onRequestRename(block)}>
        <MenuIconSlot />
        Rename…
      </ContextMenuItem>

      {currentTag && selectedTags.includes(currentTag) && (
        <ContextMenuItem variant="detach" onSelect={() => onToggleTag(block.slug, currentTag, true)}>
          <MenuIconSlot>
            <Unlink className="size-[13px]" />
          </MenuIconSlot>
          <span className="min-w-0 truncate">
            Disconnect from &ldquo;{collectionRefLabel(currentTag)}&rdquo;
          </span>
        </ContextMenuItem>
      )}

      <ContextMenuItem
        variant="destructive"
        onSelect={() => onRequestDelete(block.slug)}
      >
        <MenuIconSlot>
          <Trash2 className="size-[13px]" />
        </MenuIconSlot>
        Delete
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
