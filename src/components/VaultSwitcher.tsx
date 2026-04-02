import { useState, useEffect } from "react";
import { Check, Plus } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { listKnownVaults, selectVault } from "@/lib/commands";

interface VaultSwitcherProps {
  currentPath: string;
  hotkey?: string;
}

function vaultName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function VaultSwitcher({ currentPath, hotkey }: VaultSwitcherProps) {
  const [knownVaults, setKnownVaults] = useState<string[]>([]);

  useEffect(() => {
    listKnownVaults().then(setKnownVaults).catch(() => {});
  }, []);

  const handleSwitch = async (path: string) => {
    if (path === currentPath) return;
    await selectVault(path);
    window.location.reload();
  };

  const handleAddSpace = async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected) return;
    await selectVault(selected);
    window.location.reload();
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
        <Button variant="ghost" size="xs">
          {vaultName(currentPath)}
          {hotkey && (
            <kbd className="ml-2 text-sm text-muted-foreground">{hotkey}</kbd>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start">
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
