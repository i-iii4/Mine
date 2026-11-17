import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRef } from "react";
import { ChromeCloseButton } from "./ChromeCloseButton";
import { ChromeActions } from "./ChromeRow";
import { MenuSpecView, menuSurfaceClass } from "./MenuSpecView";
import { commandById } from "@/lib/commandRegistry";
import { menuPlateOf } from "@/lib/floatingLayer";
import { lastInputIsKey } from "@/lib/motionInput";
import { selectedElementCountLabel } from "@/lib/groupSelection";
import { useGroupSelectionMenu, type GroupSelectionMenuInput } from "@/hooks/useGroupSelectionMenu";
import { useSpecMenu } from "@/hooks/useSpecMenu";

/** The feed's `requestDeleteSelection()` is the window's owner, not the
 *  row's (SPEC_GROUP_SELECTION.md, «Точки входа»). */
type GroupSelectionCommandsProps = GroupSelectionMenuInput;

export function GroupSelectionCommands(props: GroupSelectionCommandsProps) {
  const { selectedBlocks, currentTag, onRequestDeleteSelection, onMergeSelectedBlocks, onClearSelection } = props;
  // Connect's picker: the selection's collections as a list under a search
  // field, in the menu panel when the menu mode is `window`, else on the
  // page (src/lib/groupSelectionMenu.ts; SPEC_MENU_WINDOW.md, Б3).
  const menu = useGroupSelectionMenu("connect", props);
  const connect = useSpecMenu({ spec: menu.spec, act: menu.act, onOpenChange: menu.setOpen });
  const connectRef = useRef<HTMLButtonElement>(null);

  // The row's Disconnect is the menu's own command: the selection stays
  // until the answer, and a Disconnect that was not made keeps it, to be
  // tried again, while the tab's notice says why (SPEC_DEEP_AUDIT.md, Е6.1).
  const handleRemoveFromCollection = () => {
    void menu.act({ kind: "run", id: "disconnect" });
  };

  if (selectedBlocks.length === 0) return null;

  return (
    <div
      className="relative h-full w-full text-foreground"
      data-feed-selection-action-bar=""
    >
      {/* The count holds the left; the commands and the close control stand
          at the right in ChromeActions, which owns the right edge inset as in
          every chrome row (DESIGN_SYSTEM.md, «Иконочные кнопки хрома»). When
          the row narrows, the count truncates (`w-0` keeps its text out of the
          row's min-content) while the commands keep their size; commands the
          top row cannot hold send this half to a second row
          (SPEC_NARROW_WINDOW.md, У10), and where even that row is too narrow
          they scroll. A truncated count alone moves nothing. The pads live on
          the scrolled content, not the scrollport: a scroll container's end
          padding never renders past its content. */}
      <div className="h-full max-w-full overflow-x-auto overflow-y-hidden">
        <div
          className="flex h-full w-full min-w-min items-center gap-1 pl-[var(--main-secondary-pad-x,0.5rem)]"
          data-top-row-part="whole"
        >
          <div
            className="w-0 min-w-0 flex-1 truncate px-2 font-mono text-sm text-muted-foreground"
            data-feed-selection-count=""
          >
            {`${selectedElementCountLabel(selectedBlocks.length)} selected`}
          </div>

          <ChromeActions data-feed-selection-actions="">
            <DropdownMenu
              open={connect.onPage}
              onOpenChange={(next) => {
                const button = connectRef.current;
                if (!next || button === null) {
                  connect.hide();
                  return;
                }
                // Asked for now, in the input's handler (МО19).
                connect.show({
                  rect: menuPlateOf(button).getBoundingClientRect(),
                  opener: { kind: "plate" },
                  byKey: lastInputIsKey(),
                  contextMenu: false,
                });
              }}
              modal={false}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  ref={connectRef}
                  type="button"
                  variant="default"
                  size="xs"
                  className="shrink-0"
                  // The picker is open in the panel: the button looks as it
                  // does with its picker open on the page.
                  {...(connect.inPanel ? { "data-state": "open", "aria-expanded": true } : {})}
                >
                  <Plus className="size-[13px]" />
                  Connect
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent widthRole={menu.spec.role} className={menuSurfaceClass(menu.spec.role)}>
                <MenuSpecView spec={menu.spec} dispatch={menu.act} open={connect.onPage} />
              </DropdownMenuContent>
            </DropdownMenu>

            {currentTag && (
              <Button
                type="button"
                variant="default"
                size="xs"
                className="shrink-0 text-detach"
                onClick={handleRemoveFromCollection}
              >
                Disconnect
              </Button>
            )}

            {selectedBlocks.length >= 2 && (
              <Button
                type="button"
                variant="default"
                size="xs"
                className="shrink-0"
                onClick={onMergeSelectedBlocks}
              >
                Merge
              </Button>
            )}

            <Button
              type="button"
              variant="destructive"
              size="xs"
              className="shrink-0"
              onClick={onRequestDeleteSelection}
            >
              Delete
            </Button>

            <ChromeCloseButton
              label="Clear selection"
              shortcut={commandById("clear-selection").combo}
              onClick={onClearSelection}
            />
          </ChromeActions>
        </div>
      </div>
      {menu.error && (
        <p className="absolute left-1/2 top-full z-40 mt-2 -translate-x-1/2 rounded-1 border border-destructive bg-background px-3 py-1 text-sm text-destructive">
          {menu.error}
        </p>
      )}
    </div>
  );
}
