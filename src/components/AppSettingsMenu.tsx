// The logo's menu on the page: the settings' sections, one row each
// (SPEC_SETTINGS_WINDOW.md). The menu is described as data and opens in the
// menu panel when the menu mode is `window`, else on the page
// (SPEC_MENU_WINDOW.md, Г3). Its rows carry no icon and stand with no
// leading slot.

import { useCallback } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ChromeActions } from "@/components/ChromeRow";
import { MineLogo } from "@/components/MineLogo";
import { useSpecMenu } from "@/hooks/useSpecMenu";
import { useTopChromeTriggerInteraction } from "@/hooks/useTopChromeTriggerInteraction";
import { menuPlateOf } from "@/lib/floatingLayer";
import { menuItem } from "@/lib/menuSpec";
import { lastInputIsKey } from "@/lib/motionInput";
import { SETTINGS_SECTIONS, type SettingsSection } from "@/lib/settingsSections";
import type { MenuAction, MenuAnswer, MenuSpec } from "@/types";
import { MenuSpecView } from "./MenuSpecView";

/** The settings' sections as a menu: a row's id is its section's. */
export const SETTINGS_SECTIONS_SPEC: MenuSpec = {
  role: "action",
  entries: SETTINGS_SECTIONS.map(({ id, label }) => menuItem(id, label, { plain: true })),
};

export function AppSettingsMenu({
  onSelectSection,
}: {
  onSelectSection: (section: SettingsSection) => void;
}) {
  const { triggerProps, handleCloseAutoFocus } =
    useTopChromeTriggerInteraction({ dragDisabled: true });

  const act = useCallback(async (action: MenuAction): Promise<MenuAnswer> => {
    const section = action.kind === "run" ? SETTINGS_SECTIONS.find(({ id }) => id === action.id) : undefined;
    if (section !== undefined) onSelectSection(section.id);
    return { kind: "done" };
  }, [onSelectSection]);

  const menu = useSpecMenu({ spec: SETTINGS_SECTIONS_SPEC, act });

  return (
    <ChromeActions
      data-top-chrome-settings-menu=""
      className="ml-1"
    >
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
            aria-label="Mine settings"
            variant="chrome"
            size="chrome-icon"
            // The menu is open in the menu panel: the button looks as it
            // does with its menu open on the page.
            {...(menu.inPanel ? { "data-state": "open", "aria-expanded": true } : {})}
          >
              <MineLogo />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent onCloseAutoFocus={handleCloseAutoFocus}>
          <MenuSpecView spec={SETTINGS_SECTIONS_SPEC} dispatch={act} open={menu.onPage} />
        </DropdownMenuContent>
      </DropdownMenu>
    </ChromeActions>
  );
}
