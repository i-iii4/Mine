import { useMemo, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { MenuSpecView } from "@/components/MenuSpecView";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useSpecMenu } from "@/hooks/useSpecMenu";
import { menuPlateOf } from "@/lib/floatingLayer";
import { lastInputIsKey } from "@/lib/motionInput";
import type { MenuAction, MenuAnswer, MenuSpec } from "@/types";
import { SettingRow } from "./SettingRow";
import type { OpenSpace } from "./useOpenSpaces";

interface OpenSpaceSelectProps {
  spaces: readonly OpenSpace[];
  current: OpenSpace;
  onChoose: (vaultId: string) => void;
}

/** The choice of the open space in the menu's description. */
export const OPEN_SPACE_ID = "space";

/** The open spaces as a menu: one choice, a row for each space, the
 *  section's own ticked. Choosing closes the menu: it is there for this one
 *  choice. The list follows the tabs as they open and close. */
export function openSpaceSpec(spaces: readonly OpenSpace[], current: OpenSpace): MenuSpec {
  return {
    role: "action",
    entries: [{
      kind: "radio",
      id: OPEN_SPACE_ID,
      value: current.vaultId,
      options: spaces.map((space) => ({ value: space.vaultId, label: space.name })),
      closes: true,
    }],
  };
}

/// Which open space a section acts on (SPEC_TABS.md, В71). The menu is
/// described as data and opens in the menu panel when the menu mode is
/// `window`, else on the page (SPEC_MENU_WINDOW.md, Д1).
export function OpenSpaceSelect({ spaces, current, onChoose }: OpenSpaceSelectProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const spec = useMemo(() => openSpaceSpec(spaces, current), [spaces, current]);
  const act = async (action: MenuAction): Promise<MenuAnswer> => {
    // A space whose last tab closed under the open menu is no choice.
    if (action.kind === "choose" && action.id === OPEN_SPACE_ID && spaces.some((space) => space.vaultId === action.value)) {
      onChoose(action.value);
    }
    return { kind: "done" };
  };
  const menu = useSpecMenu({ spec, act });

  return (
    <SettingRow label="Space" caption="One of the spaces open in tabs">
      <DropdownMenu
        open={menu.onPage}
        onOpenChange={(next) => {
          const button = buttonRef.current;
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
        modal={false}
      >
        <DropdownMenuTrigger asChild>
          <Button
            ref={buttonRef}
            variant="default"
            aria-label={`Space: ${current.name}`}
            className="max-w-56 font-normal"
            data-open-space-select=""
            // The menu is open in the menu panel: the button looks as it
            // does with its menu open on the page.
            {...(menu.inPanel ? { "data-state": "open", "aria-expanded": true } : {})}
          >
            <span className="min-w-0 truncate">{current.name}</span>
            <ChevronDown aria-hidden="true" className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <MenuSpecView spec={spec} dispatch={act} open={menu.onPage} />
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingRow>
  );
}
