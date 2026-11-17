import { RemoveSpaceDialog } from "./RemoveSpaceDialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealInFinder } from "@/lib/systemActions";
import { FolderOpen, FolderPlus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuTextTrigger } from "@/components/MenuTextTrigger";
import { MenuIconSlot } from "@/components/ui/menu-icon-slot";
import { MenuSpecView } from "@/components/MenuSpecView";
import { UnavailableSpaceRow } from "@/components/SpaceList";
import { useSpecMenu } from "@/hooks/useSpecMenu";
import { useTopChromeTriggerInteraction } from "@/hooks/useTopChromeTriggerInteraction";
import { TooltipProvider } from "@/components/ui/tooltip";
import { forgetKnownVault, listKnownVaults, listSpaces, recordStartupMilestone, selectVault } from "@/lib/commands";
import { menuPlateOf } from "@/lib/floatingLayer";
import { lastInputIsKey } from "@/lib/motionInput";
import type { MenuAction, MenuAnswer, MenuSpace, MenuSpec, SpaceEntry } from "@/types";
import { cn } from "@/lib/utils";

interface VaultSwitcherProps {
  currentPath: string;
  onVaultSelected: (path: string) => void;
  hotkey?: string;
  surface?: "actionBar" | "topChrome";
  /// Open the space `vaultId` in a new tab of this window (SPEC_TABS.md,
  /// В52): ⌘-click on a space, or its Open in New Tab action. Absent on a
  /// page that is not a tab, which has no window of tabs to open it in.
  onOpenInNewTab?: (vaultId: string) => void;
}

/** The list of spaces in the space menu's description. */
export const SPACE_LIST_ID = "spaces";

/**
 * The space menu as data (SPEC_MENU_WINDOW.md, Г1): the list of spaces as
 * the whole menu, a list under a search field. `spaces` are the known
 * spaces but the one on screen, in the order set in the settings.
 */
export function spaceMenuSpec(spaces: readonly MenuSpace[], unavailable: readonly MenuSpace[], tabs: boolean): MenuSpec {
  return {
    role: "search",
    entries: [{ kind: "widget", id: SPACE_LIST_ID, widget: { kind: "space_list", spaces: [...spaces], unavailable: [...unavailable], tabs } }],
  };
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
  onOpenInNewTab,
}: VaultSwitcherProps) {
  const [knownVaults, setKnownVaults] = useState<string[]>([]);
  // A tab opens a space by its identity, never by its path (В29). A space the
  // registry knows no identity for yet gets one on its first opening here.
  const [vaultIds, setVaultIds] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  // Spaces whose folder cannot be opened right now stay listed and marked
  // instead of vanishing from the list (SPEC_VAULT_LIFECYCLE.md, П26).
  const [unavailableSpaces, setUnavailableSpaces] = useState<SpaceEntry[]>([]);
  // The menu of the action bar's switcher, a plain menu on the page. The top
  // chrome's is described as data (`menu` below).
  const [barOpen, setBarOpen] = useState(false);
  // The space awaiting removal confirmation. Held here rather than inside the
  // row so the dialog outlives the menu that opened it.
  const [pendingForget, setPendingForget] = useState<string | null>(null);
  const triggerLabel = vaultName(currentPath);
  const isTopChrome = surface === "topChrome";

  // The order the person set in Settings > Spaces, not the alphabet: the
  // switcher and the settings list show one sequence (А6.10).
  const ordered = useMemo(() => (
    Array.from(new Set(knownVaults)).filter((path) => path !== currentPath)
  ), [currentPath, knownVaults]);

  // The top chrome's menu as data: the list of spaces, in the menu panel
  // when the menu mode is `window`, else on the page (SPEC_MENU_WINDOW.md,
  // Г1). A space with no identity yet cannot open in a new tab.
  const spec = useMemo(() => spaceMenuSpec(
    ordered.map((path) => ({ path, name: vaultName(path), tab: (vaultIds.get(path) ?? null) !== null })),
    unavailableSpaces.map((space) => ({ path: space.path, name: space.name, tab: false })),
    Boolean(onOpenInNewTab),
  ), [onOpenInNewTab, ordered, unavailableSpaces, vaultIds]);
  const menu = useSpecMenu({ spec, act: (action) => actOnMenu(action) });
  const { hide: hideMenu } = menu;
  const open = isTopChrome ? menu.open : barOpen;

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

  /** The menu goes: a command of it takes the window somewhere else. */
  const closeMenu = useCallback(() => {
    hideMenu();
    setBarOpen(false);
  }, [hideMenu]);

  const handleSwitch = useCallback(async (path: string) => {
    if (path === currentPath) return;
    void recordStartupMilestone("space_switch_requested").catch(() => {});
    closeMenu();
    await selectVault(path);
    onVaultSelected(path);
  }, [closeMenu, currentPath, onVaultSelected]);

  /// The space `path` in a new tab of this window, when this page can open
  /// tabs and the space has an identity (В52).
  const openInNewTab = useCallback((path: string) => {
    const vaultId = vaultIds.get(path) ?? null;
    if (!onOpenInNewTab || vaultId === null) return;
    closeMenu();
    onOpenInNewTab(vaultId);
  }, [closeMenu, onOpenInNewTab, vaultIds]);

  // A folder Finder could not show is the tab's notice (SPEC_DEEP_AUDIT.md,
  // Н11, Е6.16); the menu stays put.
  const handleReveal = useCallback((path: string) => {
    revealInFinder(path);
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
    closeMenu();
    handleReveal(currentPath);
  }, [closeMenu, currentPath, handleReveal]);

  // The menu closes before the folder dialog opens, as after any other
  // chosen row (user's decision of 15.11.2026).
  const handleAddSpace = useCallback(async () => {
    closeMenu();
    const selected = await openDialog({ directory: true, multiple: false, canCreateDirectories: true });
    if (!selected) return;
    await selectVault(selected);
    onVaultSelected(selected);
  }, [closeMenu, onVaultSelected]);

  /** Carry out what the list of spaces asks: the menu on the page and the
   *  menu in the panel both come here. */
  const actOnMenu = async (action: MenuAction): Promise<MenuAnswer> => {
    if (action.kind !== "widget") return { kind: "done" };
    const asked = action.action;
    switch (asked.kind) {
      case "switch_space":
        if (asked.new_tab) openInNewTab(asked.path);
        else void handleSwitch(asked.path);
        break;
      case "reveal_space":
        handleReveal(asked.path);
        break;
      case "forget_space":
        setPendingForget(asked.path);
        break;
      case "reveal_current_space":
        handleRevealCurrent();
        break;
      case "add_space":
        void handleAddSpace();
        break;
      // What another widget asks: the list of spaces never does.
      default:
        break;
    }
    return { kind: "done" };
  };

  const topChromeTrigger = useTopChromeTriggerInteraction({
    dragDisabled: !isTopChrome,
    deferPointerOpen: isTopChrome,
    onPointerOpen: () => setMenuOpen(!menu.open),
  });

  /** Open the top chrome's menu off the trigger's plate, asked for in the
   *  input's own handler (МО19), or take it away. */
  const setMenuOpen = (next: boolean) => {
    const trigger = topChromeTrigger.triggerProps.ref.current;
    if (!next || trigger === null) {
      hideMenu();
      return;
    }
    menu.show({
      rect: menuPlateOf(trigger).getBoundingClientRect(),
      opener: { kind: "plate" },
      byKey: lastInputIsKey(),
      contextMenu: false,
    });
  };

  return (
    <TooltipProvider>
    <DropdownMenu
      open={isTopChrome ? menu.onPage : barOpen}
      onOpenChange={isTopChrome ? setMenuOpen : setBarOpen}
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
          // The filter row may narrow the name first (useSidebarRowFit.ts).
          data-row-fit-name={isTopChrome ? "" : undefined}
          {...(isTopChrome ? topChromeTrigger.triggerProps : {})}
          // The menu is open in the menu panel: the trigger looks as it does
          // with its menu open on the page.
          {...(isTopChrome && menu.inPanel ? { "data-state": "open", "aria-expanded": true } : {})}
          className={cn(
            isTopChrome
              ? cn(
                  // The row of a tab page starts with this trigger: the
                  // traffic lights and the sidebar button live in the tab bar
                  // above (SPEC_TABS.md, В43). Its label lands on the chrome
                  // edge inset, like the collection switcher's.
                  // 8 px of row on both sides of the pill, as round the
                  // place's name: to the window edge and to the search
                  // separator after it (11.10.2026). A collapsed sidebar has
                  // no switcher in the row (DESIGN_SYSTEM.md, «Одно название
                  // в ряду»; user's decision of 11.11.2026).
                  "justify-start pl-[var(--top-collection-pad-x)] pr-[var(--top-collection-pad-x)]",
                  // Never wider than a tab, 200px (`TAB_MAX_WIDTH_PX`; user's
                  // decision of 25.10.2026), nor than half the space and
                  // search zone.
                  "max-w-[min(50%,200px)]",
                )
              : undefined,
          )}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={isTopChrome ? "bottom" : "top"}
        onCloseAutoFocus={isTopChrome ? topChromeTrigger.handleCloseAutoFocus : undefined}
        widthRole={isTopChrome ? "search" : "action"}
        className={isTopChrome ? "overflow-hidden p-0" : undefined}
        data-vault-switcher-menu={isTopChrome ? "" : undefined}
      >
        {isTopChrome ? (
          <MenuSpecView spec={spec} dispatch={actOnMenu} open={menu.onPage} />
        ) : (
          <>
            <div>
              {ordered.length > 0 ? (
                ordered.map((path) => (
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
              ) : unavailableSpaces.length === 0 ? (
                <div className="flex items-center gap-2 px-plate py-1.5 text-base text-muted-foreground">
                  <MenuIconSlot />
                  No other spaces
                </div>
              ) : null}
              {unavailableSpaces.map((space) => (
                <UnavailableSpaceRow
                  key={space.path}
                  space={space}
                  onRequestForget={() => setPendingForget(space.path)}
                />
              ))}
            </div>
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

    <RemoveSpaceDialog
      path={pendingForget}
      onCancel={() => setPendingForget(null)}
      onConfirm={(path) => void handleForget(path)}
    />
    </TooltipProvider>
  );
}
