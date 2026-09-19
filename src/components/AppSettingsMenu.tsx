import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ChromeActions } from "@/components/ChromeRow";
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
              <svg
                data-mine-logo=""
                aria-hidden="true"
                focusable="false"
                viewBox="-100 -250 1000 1000"
                fill="currentColor"
              >
                {/* Original outline centered in a padded icon canvas: 12.8×8px at 16px. */}
                <path d="M800 200V100H700V0H600V100H500V0H300V100H200V0H100V400H0V500H100V400H200V200H300V100H400V300H300V500H400V300H500V200H600V100H700V200ZM600 500H700V300H600Z" />
              </svg>
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
