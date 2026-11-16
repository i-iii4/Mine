import { ContextMenuContent } from "@/components/ui/context-menu";
import type { LightBlock, TagCount } from "@/types";
import { CardMenuRows } from "./CardHoverMenu";
import { CONTEXT_MENU_KIT } from "./MenuSpecView";

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
 * ContextMenuContent rendered on right-click: the card menu's one
 * description (src/lib/cardMenuEntries.ts), the same the overflow menu of
 * `CardHoverMenu` and the menu panel draw, here with a context menu's
 * primitives. Must be used inside a <ContextMenu> wrapper that provides the
 * radix trigger. It lives while the menu is open, so every opening starts
 * with Connect's submenu shut; Escape in the submenu closes it alone and
 * gives the focus back to its Connect row, and with a query typed the first
 * Escape clears the query (CollectionPicker.tsx, `usePickerEscape`; user's
 * decision of 15.11.2026).
 */
export function CardTagMenu(props: CardTagMenuProps) {
  return (
    <ContextMenuContent>
      <CardMenuRows {...props} menuOpen kit={CONTEXT_MENU_KIT} />
    </ContextMenuContent>
  );
}
