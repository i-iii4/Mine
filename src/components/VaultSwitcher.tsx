import { useState, useEffect } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTopChromeTriggerInteraction } from "@/hooks/useTopChromeTriggerInteraction";
import { listKnownVaults, selectVault } from "@/lib/commands";
import { cn } from "@/lib/utils";

interface VaultSwitcherProps {
  currentPath: string;
  onVaultSelected: (path: string) => void;
  hotkey?: string;
  surface?: "actionBar" | "topChrome";
  topChromeCollapsed?: boolean;
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
  topChromeCollapsed = false,
}: VaultSwitcherProps) {
  const [knownVaults, setKnownVaults] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    listKnownVaults().then(setKnownVaults).catch(() => {});
  }, []);

  const handleSwitch = async (path: string) => {
    if (path === currentPath) return;
    setOpen(false);
    await selectVault(path);
    onVaultSelected(path);
  };

  const handleAddSpace = async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected) return;
    setOpen(false);
    await selectVault(selected);
    onVaultSelected(selected);
  };

  const sorted = Array.from(new Set(knownVaults))
    .filter((path) => path !== currentPath)
    .sort((a, b) => vaultName(a).localeCompare(vaultName(b)));
  const triggerLabel = vaultName(currentPath);
  const isTopChrome = surface === "topChrome";
  const topChromeTrigger = useTopChromeTriggerInteraction({
    dragDisabled: !isTopChrome,
    deferPointerOpen: isTopChrome,
    onPointerOpen: () => setOpen((current) => !current),
  });

  return (
    <DropdownMenu
      open={isTopChrome ? open : undefined}
      onOpenChange={isTopChrome ? setOpen : undefined}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Switch space: ${triggerLabel}`}
          data-vault-switcher=""
          data-vault-switcher-surface={surface}
          {...(isTopChrome ? topChromeTrigger.triggerProps : {})}
          className={cn(
            "group inline-flex shrink-0 cursor-pointer items-center select-none overflow-hidden bg-transparent text-foreground outline-0",
            isTopChrome
              ? cn(
                  "h-full min-w-0 flex-none justify-start rounded-0 px-3 text-base focus-visible:outline-none",
                  topChromeCollapsed ? "max-w-[159px]" : "max-w-[50%]",
                )
              : "action-button h-6 rounded-1 p-[2px] font-mono text-sm hover:bg-component-fill-hover",
          )}
        >
          {isTopChrome ? (
            <span
              className={cn(
                "inline-flex h-6 min-w-0 max-w-full items-center rounded-1 px-2 text-foreground group-hover:bg-active group-data-[state=open]:bg-active",
                topChromeTrigger.keyboardFocus && "bg-active",
              )}
            >
              <span className="min-w-0 truncate text-left">
                {triggerLabel}
              </span>
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
        widthRole={isTopChrome ? "selector" : "command"}
        onCloseAutoFocus={isTopChrome ? topChromeTrigger.handleCloseAutoFocus : undefined}
        className={isTopChrome ? "overflow-hidden p-0" : undefined}
      >
        <div className={isTopChrome ? "max-h-72 overflow-y-auto p-1" : undefined}>
          {sorted.length > 0 ? (
            sorted.map((path) => (
              <DropdownMenuItem
                key={path}
                onSelect={() => handleSwitch(path)}
              >
                <span className="min-w-0 truncate">
                  {vaultName(path)}
                </span>
              </DropdownMenuItem>
            ))
          ) : (
            <div className="px-2 py-1.5 text-base text-muted-foreground">
              No other spaces
            </div>
          )}
        </div>
        {isTopChrome ? (
          <div className="border-t border-border p-1">
            <DropdownMenuItem onSelect={handleAddSpace}>
              Add space
            </DropdownMenuItem>
          </div>
        ) : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={handleAddSpace}>
              Add space
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
