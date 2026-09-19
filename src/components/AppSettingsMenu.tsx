import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuTextTrigger } from "@/components/MenuTextTrigger";
import { useTopChromeTriggerInteraction } from "@/hooks/useTopChromeTriggerInteraction";
import { SETTINGS_SECTIONS, type SettingsSection } from "@/lib/settingsSections";

export function AppSettingsMenu({
  onSelectSection,
}: {
  onSelectSection: (section: SettingsSection) => void;
}) {
  const { keyboardFocus, triggerProps, handleCloseAutoFocus } =
    useTopChromeTriggerInteraction({ dragDisabled: true });

  return (
    <div
      data-top-chrome-settings-menu=""
      // Include the trigger's 8px inner padding in the 16px visible-glyph inset.
      className="ml-2 mr-[calc(var(--chrome-edge-pad)-8px)] flex h-full shrink-0 items-center"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <MenuTextTrigger
            {...triggerProps}
            aria-label="Mine settings"
            keyboardFocus={keyboardFocus}
            label={
              <svg
                data-mine-logo=""
                aria-hidden="true"
                focusable="false"
                viewBox="0 0 800 500"
                fill="currentColor"
                className="size-4 text-foreground"
              >
                {/* Exact m outline from Redaction100-Italic; tight bounds, no icon tile. */}
                <path d="M800 200V100H700V0H600V100H500V0H300V100H200V0H100V400H0V500H100V400H200V200H300V100H400V300H300V500H400V300H500V200H600V100H700V200ZM600 500H700V300H600Z" />
              </svg>
            }
          />
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
    </div>
  );
}
