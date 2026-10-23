// The Display button at the right of the second chrome row and its panel
// (SPEC_FEED_DISPLAY.md, Д1 to Д4). One button with one look in every view;
// the view on screen decides what the panel holds: the feed's options in Grid
// (FeedDisplayMenu), the graph's links in Graph (GraphDisplayMenu,
// SPEC_GRAPH_VIEW.md, «Панель графа»).

import { Settings2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTopChromeTriggerInteraction } from "@/hooks/useTopChromeTriggerInteraction";
import { LightCanvasMenu } from "./LightCanvasMenu";
import { SidebarColumnsMenu } from "./SidebarColumnsMenu";
import { CompactStackMenu } from "./CompactStackMenu";

/** Which view's options the panel holds. */
export type DisplayPanel = "feed" | "graph";

/**
 * The standard chrome icon button with a command menu aligned to its right
 * edge. The panel's groups are its children.
 */
export function DisplayMenu({
  panel,
  children,
}: {
  panel: DisplayPanel;
  children: ReactNode;
}) {
  const { triggerProps, handleCloseAutoFocus } =
    useTopChromeTriggerInteraction({ dragDisabled: true });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          {...triggerProps}
          aria-label="Display options"
          variant="chrome"
          size="chrome-icon"
          data-display-trigger={panel}
        >
          <Settings2 aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={handleCloseAutoFocus}
        data-display-panel={panel}
      >
        {children}
        {/* TRIALS (PLAN 47.6, 50.38, 47.7): the sidebar rows' columns, the
            compact stack and the light canvas, in both panels. */}
        <DropdownMenuSeparator />
        <SidebarColumnsMenu />
        <DropdownMenuSeparator />
        <CompactStackMenu />
        <DropdownMenuSeparator />
        <LightCanvasMenu />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A group's caption, the same as the selection menu's count header. The group
 * below it names itself by this caption's `id` (`aria-labelledby`).
 */
export function DisplayGroupCaption({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  return (
    <div id={id} className="px-plate py-1.5 font-mono text-sm text-muted-foreground">
      {children}
    </div>
  );
}
