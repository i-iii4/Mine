import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ChromeActions } from "@/components/ChromeRow";
import { MineLogo } from "@/components/MineLogo";
import { useTopChromeTriggerInteraction } from "@/hooks/useTopChromeTriggerInteraction";
import { SETTINGS_SECTIONS, type SettingsSection } from "@/lib/settingsSections";

export function AppSettingsMenu({
  onSelectSection,
}: {
  onSelectSection: (section: SettingsSection) => void;
}) {
  const { triggerProps, handleCloseAutoFocus } =
    useTopChromeTriggerInteraction({ dragDisabled: true });

  return (
    <ChromeActions
      data-top-chrome-settings-menu=""
      className="ml-1"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            {...triggerProps}
            aria-label="Mine settings"
            variant="chrome"
            size="chrome-icon"
          >
              <MineLogo />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={handleCloseAutoFocus}>
          <DropdownMenuGroup>
            {SETTINGS_SECTIONS.map(({ id, label }) => (
              <DropdownMenuItem key={id} onSelect={() => onSelectSection(id)}>
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </ChromeActions>
  );
}
