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
import { FolderOpen, FolderPlus, Plus, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuTextTrigger } from "@/components/MenuTextTrigger";
import { MenuIconSlot } from "@/components/ui/menu-icon-slot";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { forgetKnownVault, listKnownVaults, listSpaces, recordStartupMilestone, selectVault } from "@/lib/commands";
import type { SpaceEntry } from "@/types";
import { cn } from "@/lib/utils";

interface VaultSwitcherProps {
  currentPath: string;
  onVaultSelected: (path: string) => void;
  hotkey?: string;
  surface?: "actionBar" | "topChrome";
  topChromeCollapsed?: boolean;
  /// Open the space `vaultId` in a new tab of this window (SPEC_TABS.md,
  /// В52): ⌘-click on a space, or its Open in New Tab action. Absent on a
  /// page that is not a tab, which has no window of tabs to open it in.
  onOpenInNewTab?: (vaultId: string) => void;
}

/// Icon actions inside a menu row: muted at rest, filled on approach.
///
/// Mirrors the search field's clear button, the closest existing case of an
/// icon action living inside a row. Icon size is left to the `icon-xs` button
/// contract rather than restated here — restating it is what made these glyphs
/// larger than the same ones elsewhere in the app.
const ROW_ACTION_CLASS =
  "text-muted-foreground hover:bg-component-fill-hover hover:text-foreground "
  + "focus-visible:bg-component-fill-hover focus-visible:text-foreground";

/// A known space whose folder is not there right now: listed, marked, not a
/// destination. It can still be forgotten (П26).
function UnavailableSpaceRow({
  space,
  onRequestForget,
}: {
  space: SpaceEntry;
  onRequestForget: () => void;
}) {
  return (
    <div
      className="group flex h-[var(--menu-row-height)] items-center gap-2 px-2 text-base text-muted-foreground"
      title={space.path}
      data-vault-switcher-unavailable={space.path}
    >
      <MenuIconSlot />
      <span className="min-w-0 flex-1 truncate">{space.name}</span>
      <span className="shrink-0 text-sm group-hover:hidden">Unavailable</span>
      <button
        type="button"
        className={cn(
          "hidden shrink-0 rounded-1 px-1.5 text-sm group-hover:inline",
          ROW_ACTION_CLASS,
        )}
        onClick={onRequestForget}
        aria-label={`Forget ${space.name}`}
      >
        Forget
      </button>
    </div>
  );
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
  onOpenInNewTab,
}: VaultSwitcherProps) {
  const [knownVaults, setKnownVaults] = useState<string[]>([]);
  // A tab opens a space by its identity, never by its path (В29). A space the
  // registry knows no identity for yet gets one on its first opening here.
  const [vaultIds, setVaultIds] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  // Spaces whose folder cannot be opened right now stay listed and marked
  // instead of vanishing from the list (SPEC_VAULT_LIFECYCLE.md, П26).
  const [unavailableSpaces, setUnavailableSpaces] = useState<SpaceEntry[]>([]);
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
    let cancelled = false;
    listKnownVaults().then((paths) => {
      if (!cancelled) setKnownVaults(paths);
    }).catch((error) => console.error("Could not refresh spaces", error));
    listSpaces().then((spaces) => {
      if (cancelled) return;
      setUnavailableSpaces(spaces.filter((space) => !space.available && !space.current));
      setVaultIds(new Map(spaces.map((space) => [space.path, space.vault_id])));
    }).catch(() => {
      if (!cancelled) setUnavailableSpaces([]);
    });
    return () => { cancelled = true; };
  }, [open]);

  const resetMenuSearch = useCallback(() => {
    setQuery("");
    setActiveIndex(null);
  }, []);

  const handleSwitch = useCallback(async (path: string) => {
    if (path === currentPath) return;
    void recordStartupMilestone("space_switch_requested").catch(() => {});
    setOpen(false);
    resetMenuSearch();
    await selectVault(path);
    onVaultSelected(path);
  }, [currentPath, onVaultSelected, resetMenuSearch]);

  /// The space `path` in a new tab, when this page can open tabs and the
  /// space has an identity; otherwise null.
  const newTabOpener = useCallback((path: string): (() => void) | null => {
    const vaultId = vaultIds.get(path) ?? null;
    if (!onOpenInNewTab || vaultId === null) return null;
    return () => {
      setOpen(false);
      resetMenuSearch();
      onOpenInNewTab(vaultId);
    };
  }, [onOpenInNewTab, resetMenuSearch, vaultIds]);

  /// A plain choice switches this tab; with ⌘ the space opens in a new tab
  /// and this tab keeps its own (В52).
  const handleChoose = useCallback((path: string, metaKey: boolean) => {
    if (metaKey && onOpenInNewTab) {
      newTabOpener(path)?.();
      return;
    }
    void handleSwitch(path);
  }, [handleSwitch, newTabOpener, onOpenInNewTab]);

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
      setUnavailableSpaces((current) => current.filter((space) => space.path !== path));
    } finally {
      setPendingForget(null);
    }
  }, []);

  /// Reveals the space the switcher is currently pointing at.
  ///
  /// Unlike the per-row reveal, this one closes the menu: it hands the window
  /// over to Finder, and a dropdown left hanging behind another app is state
  /// the user did not ask to keep.
  const handleRevealCurrent = useCallback(() => {
    setOpen(false);
    resetMenuSearch();
    void handleReveal(currentPath);
  }, [currentPath, handleReveal, resetMenuSearch]);

  const handleAddSpace = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected) return;
    setOpen(false);
    resetMenuSearch();
    await selectVault(selected);
    onVaultSelected(selected);
  }, [onVaultSelected, resetMenuSearch]);

  // The order the person set in Settings > Spaces, not the alphabet: the
  // switcher and the settings list show one sequence (А6.10).
  const ordered = useMemo(() => (
    Array.from(new Set(knownVaults)).filter((path) => path !== currentPath)
  ), [currentPath, knownVaults]);

  const visibleVaults = useMemo(() => (
    isTopChrome
      ? filterAndRankChannelSearch(
          ordered.map((path) => ({
            item: path,
            texts: [vaultName(path), path],
          })),
          query,
        )
      : ordered
  ), [isTopChrome, query, ordered]);

  const visibleUnavailable = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? unavailableSpaces.filter((space) => (
          space.name.toLocaleLowerCase().includes(needle)
          || space.path.toLocaleLowerCase().includes(needle)
        ))
      : unavailableSpaces;
  }, [query, unavailableSpaces]);

  // Keyboard order follows visual order: destination spaces, then the two
  // pinned actions below the divider.
  const revealActionIndex = visibleVaults.length;
  const addSpaceActionIndex = visibleVaults.length + 1;
  const actionCount = visibleVaults.length + 2;
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

  const activateIndex = useCallback((index: number | null, metaKey = false) => {
    if (index === null) return;
    const path = visibleVaults[index];
    if (path) {
      handleChoose(path, metaKey);
      return;
    }
    if (index === revealActionIndex) {
      handleRevealCurrent();
      return;
    }
    if (index === addSpaceActionIndex) {
      void handleAddSpace();
    }
  }, [
    addSpaceActionIndex,
    handleAddSpace,
    handleChoose,
    handleRevealCurrent,
    revealActionIndex,
    visibleVaults,
  ]);

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
    // ⌘Return opens the chosen space in a new tab, as ⌘-click does (В52).
    activateIndex(activeIndex, event.metaKey);
  }, [activateIndex, activeIndex, moveActiveIndex, query, resetMenuSearch, restoreSearchFocus]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
  }, []);

  return (
    <TooltipProvider>
    <DropdownMenu
      open={open}
      onOpenChange={handleOpenChange}
    >
      <DropdownMenuTrigger asChild>
        <MenuTextTrigger
          aria-label={`Switch space: ${triggerLabel}`}
          label={triggerLabel}
          hotkey={hotkey}
          surface={isTopChrome ? "topChrome" : "actionBar"}
          showChevron={isTopChrome}
          keyboardFocus={topChromeTrigger.keyboardFocus}
          data-vault-switcher=""
          data-vault-switcher-surface={surface}
          {...(isTopChrome ? topChromeTrigger.triggerProps : {})}
          className={cn(
            isTopChrome
              ? cn(
                  // The row of a tab page starts with this trigger: the
                  // traffic lights and the sidebar button live in the tab bar
                  // above (SPEC_TABS.md, В43). Its label lands on the chrome
                  // edge inset, like the collection switcher's.
                  // 8 px of row on both sides of the pill, as round the
                  // collection switcher's: to the window edge and to the
                  // search separator.
                  "justify-start px-[var(--top-collection-pad-x)]",
                  // Collapsed, it is the segment's only content and takes the
                  // segment's whole cap; open, half the space and search zone.
                  topChromeCollapsed ? "max-w-[240px]" : "max-w-[50%]",
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
            rowCount={Math.max(visibleVaults.length + visibleUnavailable.length, 1)}
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
                  onSwitch={({ metaKey }) => handleChoose(path, metaKey)}
                  newTab={onOpenInNewTab ? { open: newTabOpener(path) } : null}
                  onReveal={() => {
                    void handleReveal(path);
                  }}
                  onRequestForget={() => setPendingForget(path)}
                />
              ))
            ) : visibleUnavailable.length === 0 ? (
              <div className="flex h-[var(--menu-row-height)] items-center gap-2 px-2 text-base text-muted-foreground">
                <MenuIconSlot />
                No other spaces
              </div>
            ) : null}
            {visibleUnavailable.map((space) => (
              <UnavailableSpaceRow
                key={space.path}
                space={space}
                onRequestForget={() => setPendingForget(space.path)}
              />
            ))}
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
                  <MenuIconSlot />
                  <span className="min-w-0 truncate">
                    {vaultName(path)}
                  </span>
                </DropdownMenuItem>
              ))
            ) : visibleUnavailable.length === 0 ? (
              <div className="flex items-center gap-2 px-2 py-1.5 text-base text-muted-foreground">
                <MenuIconSlot />
                No other spaces
              </div>
            ) : null}
            {visibleUnavailable.map((space) => (
              <UnavailableSpaceRow
                key={space.path}
                space={space}
                onRequestForget={() => setPendingForget(space.path)}
              />
            ))}
          </div>
        )}
        {isTopChrome ? (
          <div className="border-t border-border p-1" data-vault-switcher-pinned-actions="">
            <SearchMenuAction
              id={`${actionIdPrefix}-space-action-${revealActionIndex}`}
              active={activeIndex === revealActionIndex}
              onActive={() => setActiveIndex(revealActionIndex)}
              onPress={handleRevealCurrent}
            >
              <MenuIconSlot>
                <FolderOpen className="size-[13px]" />
              </MenuIconSlot>
              Reveal in Finder
            </SearchMenuAction>
            <SearchMenuAction
              id={`${actionIdPrefix}-space-action-${addSpaceActionIndex}`}
              active={activeIndex === addSpaceActionIndex}
              onActive={() => setActiveIndex(addSpaceActionIndex)}
              onPress={() => {
                void handleAddSpace();
              }}
            >
              <MenuIconSlot>
                <FolderPlus className="size-[13px]" />
              </MenuIconSlot>
              Add space
            </SearchMenuAction>
          </div>
        ) : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={handleRevealCurrent}>
              <MenuIconSlot>
                <FolderOpen className="size-[13px]" />
              </MenuIconSlot>
              Reveal in Finder
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                void handleAddSpace();
              }}
            >
              <MenuIconSlot>
                <FolderPlus className="size-[13px]" />
              </MenuIconSlot>
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
    </TooltipProvider>
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
  newTab,
  onReveal,
  onRequestForget,
}: {
  id: string;
  path: string;
  active: boolean;
  onActive: () => void;
  onSwitch: (modifiers: { metaKey: boolean }) => void;
  /// The Open in New Tab action, on a page that opens tabs. `open` is null
  /// while the space has no identity yet: the action shows, disabled.
  newTab: { open: (() => void) | null } | null;
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
        // Room for the row's icon actions: two, or three with a new tab.
        className={newTab ? "pr-20" : "pr-14"}
      >
        {/* Empty leading slot: the pinned actions below the divider carry
            icons, and one text column through the whole menu is the icon
            economy rule (DESIGN_SYSTEM.md). */}
        <MenuIconSlot />
        <span className="min-w-0 truncate">{name}</span>
      </SearchMenuAction>
      <div
        className={cn(
          "absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 transition-opacity duration-[120ms]",
          actionsVisible ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        data-vault-switcher-row-actions=""
      >
        {newTab && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Open ${name} in New Tab`}
                className={ROW_ACTION_CLASS}
                disabled={newTab.open === null}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  newTab.open?.();
                }}
                data-vault-switcher-open-in-new-tab=""
              >
                {/* The tab bar's own sign for a new tab (В43). */}
                <Plus />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Open in New Tab</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Reveal ${name} in Finder`}
              className={ROW_ACTION_CLASS}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onReveal();
              }}
            >
              <FolderOpen />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Reveal in Finder</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${name} from the list`}
              // The detach colour belongs to the moment the action is aimed at,
              // not to an icon sitting in a list: a row painted orange at rest
              // reads as a warning about the space itself.
              className={cn(ROW_ACTION_CLASS, "hover:text-detach focus-visible:text-detach")}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRequestForget();
              }}
            >
              <X />
            </Button>
          </TooltipTrigger>
          {/* The X is the one action in this menu whose consequence is easy to
              misread, so the tooltip states what stays untouched. */}
          <TooltipContent side="top">
            Remove from the list — files stay on disk
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
