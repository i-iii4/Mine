import { useState, useEffect } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
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
  surface?: "actionBar" | "topChrome";
}

function vaultName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() || path;
}

export function VaultSwitcher({
  currentPath,
  onVaultSelected,
  hotkey,
  surface = "actionBar",
}: VaultSwitcherProps) {
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
  const sorted = Array.from(new Set([currentPath, ...knownVaults])).sort((a, b) => {
    if (a === currentPath) return -1;
    if (b === currentPath) return 1;
    return vaultName(a).localeCompare(vaultName(b));
  });
  const triggerLabel = vaultName(currentPath);
  const isTopChrome = surface === "topChrome";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Switch space: ${triggerLabel}`}
          data-vault-switcher=""
          data-vault-switcher-surface={surface}
          className={cn(
            "group inline-flex shrink-0 cursor-pointer items-center select-none overflow-hidden bg-transparent text-foreground outline-0",
            isTopChrome
              ? "h-full min-w-0 max-w-[50%] flex-none justify-start rounded-0 px-3 text-base focus-visible:outline-none"
              : "action-button h-6 rounded-1 p-[2px] font-mono text-sm hover:bg-component-fill-hover",
          )}
        >
          {isTopChrome ? (
            <span className="inline-flex h-6 min-w-0 max-w-full items-center rounded-1 px-2 text-foreground group-hover:bg-component-fill-hover group-focus-visible:bg-component-fill-hover group-data-[state=open]:bg-component-fill-hover">
              <span className="min-w-0 truncate text-left">
                {triggerLabel}
              </span>
              <ChevronDown
                aria-hidden="true"
                className="ml-2 size-3 shrink-0 text-muted-foreground"
              />
            </span>
          ) : (
            <>
              {hotkey && (
                <span className="shrink-0 px-[1ch] py-[2px] text-foreground">
                  {hotkey}
                </span>
              )}
              <span className="min-w-0 truncate text-foreground shrink-0 rounded-[2px] bg-component-fill-inner px-[1ch] py-[2px]">
                {triggerLabel}
              </span>
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={isTopChrome ? "bottom" : "top"}
        align="start"
        sideOffset={isTopChrome ? 4 : 8}
      >
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
