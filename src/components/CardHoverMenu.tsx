import { memo } from "react";
import { MoreHorizontal, Trash2, FolderPlus, Link, ExternalLink } from "lucide-react";
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

export const CardHoverMenu = memo(function CardHoverMenu({
  block,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestDelete,
}: CardHoverMenuProps) {
  const hasUrl = !!block.url;

  return (
    <>
      {/* Overlay — затенение при hover */}
      <div className="pointer-events-none absolute inset-0 z-10 bg-black/40 opacity-0 transition-opacity group-hover:opacity-100" />

      {/* Контейнер кнопок — перехватывает клики */}
      <div
        className="absolute inset-0 z-10 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* More (···) — верхний правый */}
        <div className="absolute right-2 top-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="default" size="icon-xs">
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FolderPlus className="size-3" />
                  Collect
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

              {hasUrl && (
                <DropdownMenuItem onSelect={() => window.open(block.url!, "_blank", "noopener,noreferrer")}>
                  <ExternalLink className="size-3" />
                  Source
                </DropdownMenuItem>
              )}

              <DropdownMenuSeparator />

              {currentTag && block.tags.includes(currentTag) && (
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
        </div>

        {/* Нижний ряд: Source (лево) + Collect (право) */}
        <div className="absolute bottom-2 left-2 right-2 flex justify-between">
          {/* Source — низ лево */}
          <Button
            variant="default"
            size="xs"
            disabled={!hasUrl}
            onClick={(e) => {
              e.stopPropagation();
              if (block.url) window.open(block.url, "_blank", "noopener,noreferrer");
            }}
          >
            <ExternalLink className="size-3" />
            Source
          </Button>

          {/* Collect — низ право */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="default" size="xs">
                <FolderPlus className="size-3" />
                Collect
              </Button>
            </DropdownMenuTrigger>
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
        </div>
      </div>
    </>
  );
});
