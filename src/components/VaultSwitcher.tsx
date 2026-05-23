import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SearchMenuAction } from "@/components/SearchMenuAction";
import { useTopChromeTriggerInteraction } from "@/hooks/useTopChromeTriggerInteraction";
import { filterAndRankChannelSearch } from "@/lib/channelSearch";
import { listKnownVaults, selectVault } from "@/lib/commands";
import { SEARCH_INPUT_SUPPRESSION_PROPS } from "@/lib/searchInputSuppression";
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
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const actionIdPrefix = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const triggerLabel = vaultName(currentPath);
  const isTopChrome = surface === "topChrome";
  const menuAlignOffset = isTopChrome ? 12 : 0;

  useEffect(() => {
    listKnownVaults().then(setKnownVaults).catch(() => {});
  }, []);

  const resetMenuSearch = useCallback(() => {
    setQuery("");
    setActiveIndex(null);
  }, []);

  const handleSwitch = useCallback(async (path: string) => {
    if (path === currentPath) return;
    setOpen(false);
    resetMenuSearch();
    await selectVault(path);
    onVaultSelected(path);
  }, [currentPath, onVaultSelected, resetMenuSearch]);

  const handleAddSpace = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected) return;
    setOpen(false);
    resetMenuSearch();
    await selectVault(selected);
    onVaultSelected(selected);
  }, [onVaultSelected, resetMenuSearch]);

  const sorted = useMemo(() => (
    Array.from(new Set(knownVaults))
      .filter((path) => path !== currentPath)
      .sort((a, b) => vaultName(a).localeCompare(vaultName(b)))
  ), [currentPath, knownVaults]);

  const visibleVaults = useMemo(() => (
    isTopChrome
      ? filterAndRankChannelSearch(
          sorted.map((path) => ({
            item: path,
            texts: [vaultName(path), path],
          })),
          query,
        )
      : sorted
  ), [isTopChrome, query, sorted]);

  const actionCount = visibleVaults.length + 1;
  const addSpaceActionIndex = visibleVaults.length;
  const activeActionId = activeIndex === null
    ? undefined
    : `${actionIdPrefix}-space-action-${activeIndex}`;

  const topChromeTrigger = useTopChromeTriggerInteraction({
    dragDisabled: !isTopChrome,
    deferPointerOpen: isTopChrome,
    onPointerOpen: () => setOpen((current) => !current),
  });

  useEffect(() => {
    if (!isTopChrome) return;
    if (!open) {
      resetMenuSearch();
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
      searchInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isTopChrome, open, resetMenuSearch]);

  useEffect(() => {
    setActiveIndex((current) => {
      if (current === null) return current;
      if (current < actionCount) return current;
      return actionCount > 0 ? actionCount - 1 : null;
    });
  }, [actionCount]);

  const moveActiveIndex = useCallback((direction: 1 | -1) => {
    if (actionCount <= 0) return;
    setActiveIndex((current) => {
      if (current === null) {
        return direction > 0 ? 0 : actionCount - 1;
      }
      const nextIndex = current + direction;
      if (nextIndex < 0) return 0;
      if (nextIndex >= actionCount) return actionCount - 1;
      return nextIndex;
    });
  }, [actionCount]);

  const activateIndex = useCallback((index: number | null) => {
    if (index === null) return;
    const path = visibleVaults[index];
    if (path) {
      void handleSwitch(path);
      return;
    }
    if (index === addSpaceActionIndex) {
      void handleAddSpace();
    }
  }, [addSpaceActionIndex, handleAddSpace, handleSwitch, visibleVaults]);

  const restoreSearchFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
    });
  }, []);

  const handleSearchKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (query) {
        resetMenuSearch();
      } else {
        setOpen(false);
      }
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      moveActiveIndex(event.key === "ArrowDown" ? 1 : -1);
      restoreSearchFocus();
      return;
    }

    if (event.key !== "Enter" || activeIndex === null) return;
    event.preventDefault();
    event.stopPropagation();
    activateIndex(activeIndex);
  }, [activateIndex, activeIndex, moveActiveIndex, query, resetMenuSearch, restoreSearchFocus]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!isTopChrome) return;
    setOpen(nextOpen);
  }, [isTopChrome]);

  return (
    <DropdownMenu
      open={isTopChrome ? open : undefined}
      onOpenChange={isTopChrome ? handleOpenChange : undefined}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Switch space: ${triggerLabel}`}
          data-vault-switcher=""
          data-vault-switcher-surface={surface}
          {...(isTopChrome ? topChromeTrigger.triggerProps : {})}
          className={cn(
            "group inline-flex shrink-0 cursor-pointer items-center select-none overflow-hidden bg-transparent outline-0",
            isTopChrome
              ? cn(
                  "h-full min-w-0 flex-none justify-start rounded-0 px-3 font-mono text-sm text-muted-foreground focus-visible:outline-none",
                  topChromeCollapsed ? "max-w-[159px]" : "max-w-[50%]",
                )
              : "action-button h-6 rounded-1 p-[2px] font-mono text-sm hover:bg-component-fill-hover",
          )}
        >
          {isTopChrome ? (
            <span
              className={cn(
                "inline-flex h-6 min-w-0 max-w-full items-center rounded-1 px-2 text-muted-foreground group-hover:bg-active group-hover:text-foreground group-data-[state=open]:bg-active group-data-[state=open]:text-foreground",
                topChromeTrigger.keyboardFocus && "bg-active text-foreground",
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
              <span className="min-w-0 shrink-0 truncate rounded-[2px] bg-component-fill-inner px-[1ch] py-[2px] text-foreground">
                {triggerLabel}
              </span>
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={isTopChrome ? "bottom" : "top"}
        align="start"
        alignOffset={menuAlignOffset}
        sideOffset={isTopChrome ? 4 : 8}
        widthRole={isTopChrome ? "selector" : "command"}
        onCloseAutoFocus={isTopChrome ? topChromeTrigger.handleCloseAutoFocus : undefined}
        className={isTopChrome ? "overflow-hidden p-0" : undefined}
        data-vault-switcher-menu={isTopChrome ? "" : undefined}
        data-vault-switcher-menu-align-offset={isTopChrome ? menuAlignOffset : undefined}
      >
        {isTopChrome && (
          <div className="border-b border-border p-1">
            <Input
              ref={searchInputRef}
              {...SEARCH_INPUT_SUPPRESSION_PROPS}
              aria-label="Search spaces"
              aria-activedescendant={activeActionId}
              placeholder="Search spaces..."
              variant="ghost"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(null);
              }}
              onKeyDown={handleSearchKeyDown}
              className="h-8 rounded-0 px-2 py-0 hover:placeholder:text-muted-foreground focus:placeholder:text-muted-foreground"
              data-top-space-search=""
            />
          </div>
        )}
        <div className={isTopChrome ? "max-h-72 overflow-y-auto p-1" : undefined}>
          {visibleVaults.length > 0 ? (
            visibleVaults.map((path, index) => (
              isTopChrome ? (
                <SearchMenuAction
                  id={`${actionIdPrefix}-space-action-${index}`}
                  key={path}
                  active={activeIndex === index}
                  onActive={() => setActiveIndex(index)}
                  onPress={() => {
                    void handleSwitch(path);
                  }}
                >
                  <span className="min-w-0 truncate">
                    {vaultName(path)}
                  </span>
                </SearchMenuAction>
              ) : (
                <DropdownMenuItem
                  key={path}
                  onSelect={() => {
                    void handleSwitch(path);
                  }}
                >
                  <span className="min-w-0 truncate">
                    {vaultName(path)}
                  </span>
                </DropdownMenuItem>
              )
            ))
          ) : (
            <div className="px-2 py-1.5 text-base text-muted-foreground">
              No other spaces
            </div>
          )}
        </div>
        {isTopChrome ? (
          <div className="border-t border-border p-1">
            <SearchMenuAction
              id={`${actionIdPrefix}-space-action-${addSpaceActionIndex}`}
              active={activeIndex === addSpaceActionIndex}
              onActive={() => setActiveIndex(addSpaceActionIndex)}
              onPress={() => {
                void handleAddSpace();
              }}
            >
              Add space
            </SearchMenuAction>
          </div>
        ) : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                void handleAddSpace();
              }}
            >
              Add space
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
