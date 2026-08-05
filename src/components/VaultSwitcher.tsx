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
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen, Unlink } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuTextTrigger } from "@/components/MenuTextTrigger";
import { QuantizedMenuScrollArea } from "@/components/QuantizedMenuScrollArea";
import { SearchMenuAction } from "@/components/SearchMenuAction";
import { SearchMenuInput } from "@/components/SearchMenuInput";
import { useTopChromeTriggerInteraction } from "@/hooks/useTopChromeTriggerInteraction";
import { filterAndRankChannelSearch } from "@/lib/channelSearch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { forgetKnownVault, listKnownVaults, selectVault } from "@/lib/commands";
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
  // The space awaiting removal confirmation. Held here rather than inside the
  // row so the dialog outlives the menu that opened it.
  const [pendingForget, setPendingForget] = useState<string | null>(null);
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

  const handleReveal = useCallback(async (path: string) => {
    try {
      await revealItemInDir(path);
    } catch {
      // Finder refused to open it; nothing here can recover, and the menu
      // staying put is better than an error the user cannot act on.
    }
  }, []);

  const handleForget = useCallback(async (path: string) => {
    try {
      setKnownVaults(await forgetKnownVault(path));
    } finally {
      setPendingForget(null);
    }
  }, []);

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
    if (nextOpen) {
      // The settings window can reorder/add/forget spaces while this menu is
      // closed — re-read the canonical config order on every open.
      listKnownVaults().then(setKnownVaults).catch(() => {});
    }
    if (!isTopChrome) return;
    setOpen(nextOpen);
  }, [isTopChrome]);

  return (
    <>
    <DropdownMenu
      open={isTopChrome ? open : undefined}
      onOpenChange={handleOpenChange}
    >
      <DropdownMenuTrigger asChild>
        <MenuTextTrigger
          aria-label={`Switch space: ${triggerLabel}`}
          label={triggerLabel}
          hotkey={hotkey}
          surface={isTopChrome ? "topChrome" : "actionBar"}
          keyboardFocus={topChromeTrigger.keyboardFocus}
          data-vault-switcher=""
          data-vault-switcher-surface={surface}
          {...(isTopChrome ? topChromeTrigger.triggerProps : {})}
          className={cn(
            isTopChrome
              ? cn(
                  "justify-start px-3",
                  topChromeCollapsed ? "max-w-[159px]" : "max-w-[50%]",
                )
              : undefined,
          )}
        />
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
          <SearchMenuInput
            ref={searchInputRef}
            aria-label="Search spaces"
            aria-activedescendant={activeActionId}
            placeholder="Search spaces..."
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(null);
            }}
            onKeyDown={handleSearchKeyDown}
            data-top-space-search=""
          />
        )}
        {isTopChrome ? (
          <QuantizedMenuScrollArea
            rowCount={Math.max(visibleVaults.length, 1)}
            maxRows={8}
            innerClassName="p-1"
          >
            {visibleVaults.length > 0 ? (
              visibleVaults.map((path, index) => (
                <SpaceRow
                  key={path}
                  id={`${actionIdPrefix}-space-action-${index}`}
                  path={path}
                  active={activeIndex === index}
                  onActive={() => setActiveIndex(index)}
                  onSwitch={() => {
                    void handleSwitch(path);
                  }}
                  onReveal={() => {
                    void handleReveal(path);
                  }}
                  onRequestForget={() => setPendingForget(path)}
                />
              ))
            ) : (
              <div className="flex h-[var(--menu-row-height)] items-center px-2 text-base text-muted-foreground">
                No other spaces
              </div>
            )}
          </QuantizedMenuScrollArea>
        ) : (
          <div>
            {visibleVaults.length > 0 ? (
              visibleVaults.map((path) => (
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
              ))
            ) : (
              <div className="px-2 py-1.5 text-base text-muted-foreground">
                No other spaces
              </div>
            )}
          </div>
        )}
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

    <AlertDialog
      open={pendingForget !== null}
      onOpenChange={(next) => {
        if (!next) setPendingForget(null);
      }}
    >
      <AlertDialogContent size="default" className="sm:max-w-md">
        <AlertDialogHeader className="place-items-start text-left">
          <AlertDialogTitle>
            Remove {pendingForget ? vaultName(pendingForget) : "space"} from the list?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Nothing is deleted from your computer. The folder and everything in
            it stay where they are — Mine just stops listing the space. You can
            add it back later with Add space.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {/* Deliberately not destructive: red would say "data is about to be
              lost", which is the exact misreading this dialog exists to
              prevent. The menu item carries the detach colour instead. */}
          <AlertDialogAction
            variant="default"
            onClick={() => {
              if (pendingForget) void handleForget(pendingForget);
            }}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}

/// One space in the switcher: the row switches, the two icons beside it act on
/// the folder itself.
///
/// The icons sit next to the row rather than inside it — the row is a `button`,
/// and a control nested in a button is invalid markup. They are also plain
/// buttons rather than an overflow menu: a menu inside an open menu fights the
/// outer one for pointer and focus, and two actions do not need a container.
function SpaceRow({
  id,
  path,
  active,
  onActive,
  onSwitch,
  onReveal,
  onRequestForget,
}: {
  id: string;
  path: string;
  active: boolean;
  onActive: () => void;
  onSwitch: () => void;
  onReveal: () => void;
  onRequestForget: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const name = vaultName(path);
  const actionsVisible = hovered || active;

  return (
    <div
      className="relative"
      data-vault-switcher-row={path}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <SearchMenuAction
        id={id}
        active={active}
        onActive={onActive}
        onPress={onSwitch}
        className="pr-14"
      >
        <span className="min-w-0 truncate">{name}</span>
      </SearchMenuAction>
      <div
        className={cn(
          "absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 transition-opacity duration-[120ms]",
          actionsVisible ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        data-vault-switcher-row-actions=""
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Reveal ${name} in Finder`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onReveal();
          }}
        >
          <FolderOpen className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${name} from the list`}
          className="text-detach hover:text-detach"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRequestForget();
          }}
        >
          <Unlink className="size-4" />
        </Button>
      </div>
    </div>
  );
}
