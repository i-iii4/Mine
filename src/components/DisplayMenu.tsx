// The Display button at the right of the second chrome row and its panel
// (SPEC_FEED_DISPLAY.md, Д1 to Д4). One button with one look in every view;
// the view on screen decides what the panel holds: the feed's options in Grid
// (FeedDisplayMenu), the graph's links in Graph (GraphDisplayMenu,
// SPEC_GRAPH_VIEW.md, «Панель графа»). The panel is described as data
// (src/lib/displayMenu.ts) and opens in the menu panel when the menu mode is
// `window`, else on the page (SPEC_MENU_WINDOW.md, Г2).

import { Settings2 } from "lucide-react";
import { useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useSpecMenu } from "@/hooks/useSpecMenu";
import { useTopChromeTriggerInteraction } from "@/hooks/useTopChromeTriggerInteraction";
import { displaySpec, type DisplayGroups } from "@/lib/displayMenu";
import { menuPlateOf } from "@/lib/floatingLayer";
import { lastInputIsKey } from "@/lib/motionInput";
import type { MenuAction, MenuAnswer } from "@/types";
import { useCardViewGroups } from "./CardViewMenu";
import { MenuSpecView } from "./MenuSpecView";

/** Which view's options the panel holds. */
export type DisplayPanel = "feed" | "graph";

/**
 * The standard chrome icon button with a command menu aligned to its right
 * edge. The panel holds the view's own groups, then the groups every view
 * shares: the open card's view (SPEC_CARD_PEEK.md, О1).
 */
export function DisplayMenu({ panel, view }: { panel: DisplayPanel; view: DisplayGroups }) {
  const { triggerProps, handleCloseAutoFocus } =
    useTopChromeTriggerInteraction({ dragDisabled: true });
  const cardView = useCardViewGroups();

  // The sidebar has no choices here: its columns and its look below the
  // compact threshold, the List, are fixed (user's decisions of 15.11.2026).
  const spec = useMemo(
    () => displaySpec([...view.groups, ...cardView.groups]),
    [view.groups, cardView.groups],
  );
  const largest = useMemo(
    () => displaySpec([...view.largest, ...cardView.largest]),
    [view.largest, cardView.largest],
  );

  // A choice applies at once and the panel stays open (Д3): the setting's
  // owner changes it, and the panel follows the new description.
  const applyView = view.apply;
  const applyCardView = cardView.apply;
  const act = useCallback(async (action: MenuAction): Promise<MenuAnswer> => {
    if (!applyView(action)) applyCardView(action);
    return { kind: "done" };
  }, [applyView, applyCardView]);

  const menu = useSpecMenu({ spec, largest, act });

  return (
    <DropdownMenu
      open={menu.onPage}
      onOpenChange={(next) => {
        const button = triggerProps.ref.current;
        if (!next || button === null) {
          menu.hide();
          return;
        }
        // Asked for now, in the input's handler (МО19).
        menu.show({
          rect: menuPlateOf(button).getBoundingClientRect(),
          opener: { kind: "plate" },
          byKey: lastInputIsKey(),
          contextMenu: false,
        });
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          {...triggerProps}
          aria-label="Display options"
          variant="chrome"
          size="chrome-icon"
          data-display-trigger={panel}
          // The panel is open in the menu panel: the button looks as it
          // does with its panel open on the page.
          {...(menu.inPanel ? { "data-state": "open", "aria-expanded": true } : {})}
        >
          <Settings2 aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        onCloseAutoFocus={handleCloseAutoFocus}
        data-display-panel={panel}
      >
        <MenuSpecView spec={spec} dispatch={act} open={menu.onPage} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
