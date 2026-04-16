import { useState, useEffect } from "react";
import { Check, Plus } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { listKnownVaults, selectVault } from "@/lib/commands";
import { cn } from "@/lib/utils";

interface VaultSwitcherProps {
  currentPath: string;
  onVaultSelected: (path: string) => void;
  hotkey?: string;
}

function vaultName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function VaultSwitcher({ currentPath, onVaultSelected, hotkey }: VaultSwitcherProps) {
  const [knownVaults, setKnownVaults] = useState<string[]>([]);

  useEffect(() => {
    listKnownVaults().then(setKnownVaults).catch(() => {});
  }, []);

  const handleSwitch = async (path: string) => {
    if (path === currentPath) return;
    await selectVault(path);
    onVaultSelected(path);
  };

  const handleAddSpace = async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected) return;
    await selectVault(selected);
    onVaultSelected(selected);
  };

  // Sort: current first, then alphabetical
  const sorted = [...knownVaults].sort((a, b) => {
    if (a === currentPath) return -1;
    if (b === currentPath) return 1;
    return vaultName(a).localeCompare(vaultName(b));
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          className={cn(
            "action-button group inline-flex h-6 shrink-0 cursor-pointer items-center rounded-1 p-[2px] font-mono text-sm",
            "select-none overflow-hidden outline-0",
            "bg-transparent hover:bg-component-fill-hover",
          )}
        >
          {hotkey && (
            <span className="shrink-0 px-[1ch] py-[2px] text-foreground">
              {hotkey}
            </span>
          )}
          <span className="shrink-0 rounded-[2px] bg-component-fill-inner px-[1ch] py-[2px] text-foreground">
            {vaultName(currentPath)}
          </span>
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8}>
        {sorted.map((path) => (
          <DropdownMenuItem
            key={path}
            onSelect={() => handleSwitch(path)}
          >
            {path === currentPath && <Check className="size-3" />}
            {vaultName(path)}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleAddSpace}>
          <Plus className="size-3" />
          Add space
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
