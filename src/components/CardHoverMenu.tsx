import { memo, useEffect, useState } from "react";
import type { ComponentProps } from "react";
import { MoreHorizontal, Trash2, Plus, ExternalLink, FolderOpen, Copy, Pencil } from "lucide-react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { IndexedBlock, LightBlock, TagCount } from "@/types";
import { getBlock } from "@/lib/commands";
import { CollectionPicker, titleFromTag } from "./CollectionPicker";

interface CardMenuActionsProps<TBlock extends LightBlock | IndexedBlock> {
  block: TBlock;
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestRename: (block: TBlock) => void;
  onRequestDelete: (slug: string) => void;
}

interface CardMoreMenuProps<TBlock extends LightBlock | IndexedBlock> extends CardMenuActionsProps<TBlock> {
  className?: string;
  onOpenChange?: (open: boolean) => void;
  triggerVariant?: ComponentProps<typeof Button>["variant"];
}

type CardHoverMenuProps = CardMenuActionsProps<LightBlock>;

function stopProp(e: React.MouseEvent | React.PointerEvent) {
  e.stopPropagation();
}

export function CardMoreMenu<TBlock extends LightBlock | IndexedBlock>({
  block,
  vaultPath,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
  className,
  onOpenChange,
  triggerVariant = "default",
}: CardMoreMenuProps<TBlock>) {
  const hasUrl = !!block.url;
  const filePath = `${vaultPath}/${block.slug}.md`;
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  useEffect(() => {
    if (!menuOpen) return;
    let cancelled = false;
    void getBlock(block.slug).then((full) => {
      if (!cancelled) {
        setSelectedTags(full?.tags ?? []);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [block.slug, menuOpen]);

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        setMenuOpen(open);
        onOpenChange?.(open);
      }}
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        <Button variant={triggerVariant} size="icon" className={className}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Plus className="size-3" />
            Channel
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="flex w-64 max-h-80 flex-col overflow-hidden p-0">
            <CollectionPicker
              blockSlug={block.slug}
              selectedTags={selectedTags}
              tags={tags}
              currentTag={currentTag}
              onToggleTag={onToggleTag}
              onCreateAndAssign={onCreateAndAssign}
              stopKeyPropagation
            />
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {hasUrl && (
          <DropdownMenuItem onSelect={() => openUrl(block.url!)}>
            <ExternalLink className="size-3" />
            Source
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={() => revealItemInDir(filePath)}>
          <FolderOpen className="size-3" />
          Reveal in Finder
        </DropdownMenuItem>

        <DropdownMenuItem onSelect={() => navigator.clipboard.writeText(filePath)}>
          <Copy className="size-3" />
          Copy Path
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={() => onRequestRename(block)}>
          <Pencil className="size-3" />
          Rename…
        </DropdownMenuItem>

        {currentTag && selectedTags.includes(currentTag) && (
          <DropdownMenuItem
            onSelect={() => onToggleTag(block.slug, currentTag, true)}
          >
            Remove from &ldquo;{titleFromTag(currentTag)}&rdquo;
          </DropdownMenuItem>
        )}

        <DropdownMenuItem
          variant="destructive"
          onSelect={() => onRequestDelete(block.slug)}
        >
          <Trash2 className="size-3" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const CardHoverMenu = memo(function CardHoverMenu({
  block,
  vaultPath,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
}: CardHoverMenuProps) {
  const hasUrl = !!block.url;
  const [menuOpen, setMenuOpen] = useState(false);
  const [channelOpen, setChannelOpen] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const anyOpen = menuOpen || channelOpen;

  const shouldLoadTags = menuOpen || channelOpen;

  useEffect(() => {
    if (!shouldLoadTags) return;
    let cancelled = false;
    void getBlock(block.slug).then((full) => {
      if (!cancelled) {
        setSelectedTags(full?.tags ?? []);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [block.slug, shouldLoadTags]);

  return (
    <>
      {/* Overlay — затенение при hover */}
      <div className={cn("pointer-events-none absolute inset-0 z-[4] bg-[var(--card-hover-overlay)] transition-opacity group-hover:opacity-100", anyOpen ? "opacity-100" : "opacity-0")} />

      {/* More (···) — верхний правый */}
      <div
        className={cn("absolute right-2 top-2 z-[5] transition-opacity group-hover:opacity-100", anyOpen ? "opacity-100" : "opacity-0")}
        onClick={stopProp}
        onPointerDown={stopProp}
      >
        <CardMoreMenu
          block={block}
          vaultPath={vaultPath}
          tags={tags}
          currentTag={currentTag}
          onToggleTag={onToggleTag}
          onCreateAndAssign={onCreateAndAssign}
          onRequestRename={onRequestRename}
          onRequestDelete={onRequestDelete}
          onOpenChange={setMenuOpen}
        />
      </div>

      {/* Нижний ряд: Source (лево) + Channel (право) */}
      <div
        className={cn("absolute bottom-2 left-2 right-2 z-[5] flex gap-2 transition-opacity group-hover:opacity-100", anyOpen ? "opacity-100" : "opacity-0")}
        onClick={stopProp}
        onPointerDown={stopProp}
      >
        {/* Source — низ лево */}
        {hasUrl && (
          <Button
            variant="default"
            size="default"
            className="flex-1"
            onClick={() => { if (block.url) openUrl(block.url); }}
          >
            Source
            <ExternalLink className="size-3" />
          </Button>
        )}

        {/* Channel — низ право */}
        <DropdownMenu onOpenChange={setChannelOpen} modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="default" size="default" className="flex-1">
              Channel
              <Plus className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="flex w-64 max-h-80 flex-col overflow-hidden p-0" align="end">
            <CollectionPicker
              blockSlug={block.slug}
              selectedTags={selectedTags}
              tags={tags}
              currentTag={currentTag}
              onToggleTag={onToggleTag}
              onCreateAndAssign={onCreateAndAssign}
              stopKeyPropagation
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
});
