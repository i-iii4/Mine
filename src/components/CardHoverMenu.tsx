import { memo, useEffect, useRef, useState } from "react";
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
import { collectionRefLabel } from "@/lib/collections";
import { CollectionPicker } from "./CollectionPicker";

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
  openRequestSequence?: number;
  triggerVariant?: ComponentProps<typeof Button>["variant"];
}

type CardHoverMenuProps = CardMenuActionsProps<LightBlock>;
type CardHoverMenuPropsWithState = CardHoverMenuProps & {
  openMoreMenuRequestSequence?: number;
  onInteractiveOpenChange?: (open: boolean) => void;
  onInteractionStart?: () => void;
};

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
  openRequestSequence = 0,
  triggerVariant = "default",
}: CardMoreMenuProps<TBlock>) {
  const hasUrl = !!block.url;
  const filePath = `${vaultPath}/${block.slug}.md`;
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const lastOpenRequestSequenceRef = useRef(0);

  useEffect(() => {
    if (openRequestSequence <= lastOpenRequestSequenceRef.current) return;
    lastOpenRequestSequenceRef.current = openRequestSequence;
    setMenuOpen(true);
    onOpenChange?.(true);
  }, [onOpenChange, openRequestSequence]);

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
      open={menuOpen}
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
            Connect
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
            Remove from &ldquo;{collectionRefLabel(currentTag)}&rdquo;
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
  openMoreMenuRequestSequence = 0,
  onInteractiveOpenChange,
  onInteractionStart,
}: CardHoverMenuPropsWithState) {
  const hasUrl = !!block.url;
  const [menuOpen, setMenuOpen] = useState(false);
  const [channelOpen, setChannelOpen] = useState(false);
  const [keyboardMenuOpen, setKeyboardMenuOpen] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const lastOpenMoreMenuRequestSequenceRef = useRef(0);
  const keyboardMenuRequestPending =
    openMoreMenuRequestSequence > lastOpenMoreMenuRequestSequenceRef.current;
  const effectiveKeyboardMenuOpen = keyboardMenuOpen || keyboardMenuRequestPending;
  const anyMenuOpen = menuOpen || channelOpen;
  const hoverActionsPinned = channelOpen || (menuOpen && !effectiveKeyboardMenuOpen);

  useEffect(() => {
    if (openMoreMenuRequestSequence <= lastOpenMoreMenuRequestSequenceRef.current) return;
    lastOpenMoreMenuRequestSequenceRef.current = openMoreMenuRequestSequence;
    setKeyboardMenuOpen(true);
  }, [openMoreMenuRequestSequence]);

  useEffect(() => {
    onInteractiveOpenChange?.(anyMenuOpen);
  }, [anyMenuOpen, onInteractiveOpenChange]);

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
      <div
        className={cn("pointer-events-none absolute inset-0 z-[4] bg-[var(--card-hover-overlay)] transition-opacity group-hover:opacity-100", hoverActionsPinned ? "opacity-100" : "opacity-0")}
        data-card-hover-overlay=""
      />

      {/* More (···) — верхний правый */}
      <div
        className={cn("absolute right-2 top-2 z-[5] transition-opacity group-hover:opacity-100", anyMenuOpen ? "opacity-100" : "opacity-0")}
        data-card-hover-more-action=""
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
          openRequestSequence={openMoreMenuRequestSequence}
          onOpenChange={(open) => {
            if (open) {
              onInteractionStart?.();
            } else {
              setKeyboardMenuOpen(false);
            }
            setMenuOpen(open);
          }}
        />
      </div>

      {/* Нижний ряд: Source (лево) + Connect (право) */}
      <div
        className={cn("absolute bottom-2 left-2 right-2 z-[5] flex gap-2 transition-opacity group-hover:opacity-100", hoverActionsPinned ? "opacity-100" : "opacity-0")}
        data-card-hover-bottom-actions=""
        onClick={stopProp}
        onPointerDown={stopProp}
      >
        {/* Source — низ лево */}
        {hasUrl && (
          <Button
            variant="default"
            size="default"
            className="flex-1"
            onClick={() => {
              onInteractionStart?.();
              if (block.url) openUrl(block.url);
            }}
          >
            Source
            <ExternalLink className="size-3" />
          </Button>
        )}

        {/* Connect — низ право */}
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) {
              onInteractionStart?.();
            }
            setChannelOpen(open);
          }}
          modal={false}
        >
          <DropdownMenuTrigger asChild>
            <Button variant="default" size="default" className="flex-1">
              Connect
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
