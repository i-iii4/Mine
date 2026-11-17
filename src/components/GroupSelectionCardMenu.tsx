import { useCallback, useEffect, useRef } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cardMenuBadgeOf } from "./CardHoverMenu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useGroupSelectionMenu, type GroupSelectionMenuInput } from "@/hooks/useGroupSelectionMenu";
import { useSpecMenu } from "@/hooks/useSpecMenu";
import { menuPlateOf } from "@/lib/floatingLayer";
import { lastInputIsKey } from "@/lib/motionInput";
import { MenuSpecView } from "./MenuSpecView";

/**
 * The selection's menu on a selected card, opened by ⌘K: the selection's one
 * description (src/lib/groupSelectionMenu.ts), in the menu panel when the
 * menu mode is `window`, else on the page, out of the chord's plate either
 * way (SPEC_CARD_STATES.md, С8.8; SPEC_MENU_WINDOW.md, МО16).
 */
export function GroupSelectionCardMenu({
  openRequestSequence = 0,
  ...props
}: GroupSelectionMenuInput & { openRequestSequence?: number }) {
  const menu = useGroupSelectionMenu("menu", props);
  const specMenu = useSpecMenu({ spec: menu.spec, largest: menu.largest, act: menu.act, onOpenChange: menu.setOpen });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const lastOpenRequestSequenceRef = useRef(0);
  const openRef = useRef(false);
  openRef.current = specMenu.open;
  const { show, hide } = specMenu;

  const updateMenuOpen = useCallback((open: boolean) => {
    const trigger = triggerRef.current;
    if (!open || trigger === null) {
      hide();
      return;
    }
    // The menu comes out of the chord's plate at the card's corner.
    show({
      rect: (cardMenuBadgeOf(trigger) ?? menuPlateOf(trigger)).getBoundingClientRect(),
      opener: { kind: "plate" },
      byKey: lastInputIsKey(),
      contextMenu: false,
    });
  }, [hide, show]);

  useEffect(() => {
    if (openRequestSequence <= lastOpenRequestSequenceRef.current) return;
    lastOpenRequestSequenceRef.current = openRequestSequence;
    updateMenuOpen(!openRef.current);
  }, [openRequestSequence, updateMenuOpen]);

  if (props.selectedBlocks.length === 0) return null;

  return (
    <DropdownMenu open={specMenu.onPage} onOpenChange={updateMenuOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="default"
          size="icon-xs"
          // Only an anchor: the menu comes out of the chord's plate at this corner
          // (SPEC_CARD_STATES.md, С8.8).
          className="pointer-events-none absolute right-2 top-2 z-[7] opacity-0"
          data-feed-grid-batch-menu-trigger=""
          // The menu is open in the panel: the anchor says so as it does with
          // its menu open on the page.
          {...(specMenu.inPanel ? { "data-state": "open", "aria-expanded": true } : {})}
        >
          <MoreHorizontal className="size-[13px]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent plateOf={cardMenuBadgeOf} data-feed-grid-batch-menu="">
        <MenuSpecView spec={menu.spec} dispatch={menu.act} open={specMenu.onPage} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
