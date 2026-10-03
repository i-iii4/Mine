import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SettingRow } from "./SettingRow";
import type { OpenSpace } from "./useOpenSpaces";

interface OpenSpaceSelectProps {
  spaces: readonly OpenSpace[];
  current: OpenSpace;
  onChoose: (vaultId: string) => void;
}

/// Which open space a section acts on (SPEC_TABS.md, В71).
export function OpenSpaceSelect({ spaces, current, onChoose }: OpenSpaceSelectProps) {
  return (
    <SettingRow label="Space" caption="One of the spaces open in tabs">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="default"
            aria-label={`Space: ${current.name}`}
            className="max-w-56 font-normal"
            data-open-space-select=""
          >
            <span className="min-w-0 truncate">{current.name}</span>
            <ChevronDown aria-hidden="true" className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup value={current.vaultId} onValueChange={onChoose}>
            {spaces.map((space) => (
              <DropdownMenuRadioItem key={space.vaultId} value={space.vaultId}>
                <span className="min-w-0 truncate">{space.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingRow>
  );
}
