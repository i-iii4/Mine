import { memo } from "react";
import { Plus, ExternalLink, MoreHorizontal, Trash2, FolderPlus, Link } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
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
import type { LightBlock, TagCount } from "@/types";
import { CollectionPicker, titleFromTag } from "./CollectionPicker";

interface CardHoverMenuProps {
  block: LightBlock;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestDelete: (slug: string) => void;
}

const iconButtonClass = "rounded-1 bg-black/60 text-white backdrop-blur-sm hover:bg-black/80 hover:text-white";

export const CardHoverMenu = memo(function CardHoverMenu({
  block,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestDelete,
}: CardHoverMenuProps) {
  const hasUrl = !!block.url;

  const handleSourceClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (block.url) {
      window.open(block.url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div
      className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Collection (+) */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" className={iconButtonClass}>
                <Plus className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Add to collection</TooltipContent>
        </Tooltip>
        <DropdownMenuContent className="flex w-64 max-h-80 flex-col overflow-hidden p-0" align="end">
          <CollectionPicker
            block={block}
            tags={tags}
            currentTag={currentTag}
            onToggleTag={onToggleTag}
            onCreateAndAssign={onCreateAndAssign}
            stopKeyPropagation
          />
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Source (↗) */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className={iconButtonClass}
            disabled={!hasUrl}
            onClick={handleSourceClick}
          >
            <ExternalLink className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open source</TooltipContent>
      </Tooltip>

      {/* More (···) */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" className={iconButtonClass}>
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">More</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          {/* Add to collection — submenu */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderPlus className="size-3" />
              Add to collection
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="flex w-64 max-h-80 flex-col overflow-hidden p-0">
              <CollectionPicker
                block={block}
                tags={tags}
                currentTag={currentTag}
                onToggleTag={onToggleTag}
                onCreateAndAssign={onCreateAndAssign}
                stopKeyPropagation
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          {/* Open source */}
          {hasUrl && (
            <DropdownMenuItem onSelect={() => window.open(block.url!, "_blank", "noopener,noreferrer")}>
              <Link className="size-3" />
              Open source
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          {/* Remove from current collection */}
          {currentTag && block.tags.includes(currentTag) && (
            <DropdownMenuItem
              onSelect={() => onToggleTag(block.slug, currentTag, true)}
            >
              Remove from &ldquo;{titleFromTag(currentTag)}&rdquo;
            </DropdownMenuItem>
          )}

          {/* Delete from Mine */}
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => onRequestDelete(block.slug)}
          >
            <Trash2 className="size-3" />
            Delete from Mine
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});
