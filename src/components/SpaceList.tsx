// The list of spaces one may go to (SPEC_FRONTEND.md, the space switcher;
// SPEC_TABS.md, В52; SPEC_VAULT_LIFECYCLE.md, П26): a search field, the
// spaces in the order set in the settings, each with its actions beside it,
// the spaces whose folder is not there, and under a line the two actions of
// the space on screen. The menu described as data holds it as a widget
// (`space_list`, src/components/MenuSpecView.tsx; SPEC_MENU_WINDOW.md,
// МО27, Г1): the query, the row lit, the blink of a chosen row and the
// tooltips of the row's buttons live here, on the page and in the menu
// panel alike; what a choice does, the page the menu came from knows.
//
// A row's button says what it does through `Button`'s own tooltip, the one
// place that decides where a tooltip shows (src/components/ui/tooltip.tsx):
// in the menu panel it stays inside the panel's frame, shifted and turned
// at its edges as at a window's (SPEC_MENU_WINDOW.md, МО27; a rule the user
// may still change, and a change of it is a change there, not here).

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { FolderOpen, FolderPlus, Plus, X } from "lucide-react";
import { QuantizedMenuScrollArea } from "@/components/QuantizedMenuScrollArea";
import { SearchMenuAction } from "@/components/SearchMenuAction";
import { SearchMenuInput } from "@/components/SearchMenuInput";
import { Button } from "@/components/ui/button";
import { MenuIconSlot } from "@/components/ui/menu-icon-slot";
import { TooltipProvider } from "@/components/ui/tooltip";
import { filterAndRankChannelSearch } from "@/lib/channelSearch";
import { useMenuRowBlink } from "@/lib/menuBlink";
import { responseFadeClass } from "@/lib/motionClasses";
import { cn } from "@/lib/utils";
import type { MenuSpace } from "@/types";

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
export function UnavailableSpaceRow({
  space,
  onRequestForget,
}: {
  space: Pick<MenuSpace, "path" | "name">;
  onRequestForget: () => void;
}) {
  return (
    <div
      className="group flex h-[var(--menu-row-height)] items-center gap-2 px-plate text-base text-muted-foreground"
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

export interface SpaceListProps {
  /** Every known space but the one on screen, in the order set in the
   *  settings (А6.10), not the alphabet. */
  spaces: readonly MenuSpace[];
  /** Known spaces whose folder is not there now. */
  unavailable: readonly MenuSpace[];
  /** The page opens tabs: each space offers to open in a new one, and ⌘
   *  with a choice opens it there (В52). */
  tabs: boolean;
  /** The menu is open. A menu that closed drops a blinking row's command
   *  and starts again with no query. */
  open: boolean;
  /** Go to the space at `path`: in this tab, or in a new one. */
  onSwitch: (path: string, newTab: boolean) => void;
  /** Show the folder of the space at `path`; the menu stays. */
  onReveal: (path: string) => void;
  /** Ask to take the space at `path` off the list. */
  onRequestForget: (path: string) => void;
  /** Show the folder of the space on screen. */
  onRevealCurrent: () => void;
  /** Ask for a folder to add as a space. */
  onAddSpace: () => void;
}

export function SpaceList({
  spaces,
  unavailable,
  tabs,
  open,
  onSwitch,
  onReveal,
  onRequestForget,
  onRevealCurrent,
  onAddSpace,
}: SpaceListProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // A row is blinked by what it is, a space or a pinned action, not by its
  // place in the list.
  const rowBlink = useMenuRowBlink<string>();
  const actionIdPrefix = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const resetMenuSearch = useCallback(() => {
    setQuery("");
    setActiveIndex(null);
  }, []);

  const visibleSpaces = useMemo(() => (
    filterAndRankChannelSearch(
      spaces.map((space) => ({ item: space, texts: [space.name, space.path] })),
      query,
    )
  ), [query, spaces]);

  const visibleUnavailable = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? unavailable.filter((space) => (
          space.name.toLocaleLowerCase().includes(needle)
          || space.path.toLocaleLowerCase().includes(needle)
        ))
      : unavailable;
  }, [query, unavailable]);

  // Keyboard order follows visual order: destination spaces, then the two
  // pinned actions below the divider.
  const revealActionIndex = visibleSpaces.length;
  const addSpaceActionIndex = visibleSpaces.length + 1;
  const actionCount = visibleSpaces.length + 2;
  const activeActionId = activeIndex === null
    ? undefined
    : `${actionIdPrefix}-space-action-${activeIndex}`;

  useEffect(() => {
    if (!open) {
      // The menu closed during a row's blink: its command does not run.
      rowBlink.cancel();
      resetMenuSearch();
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
      searchInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, resetMenuSearch, rowBlink.cancel]);

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

  /// A plain choice switches this tab; with ⌘ the space opens in a new tab
  /// and this tab keeps its own (В52). A space with no identity yet has no
  /// tab to open in: ⌘ with it does nothing.
  const activateIndex = useCallback((index: number | null, metaKey = false) => {
    if (index === null) return;
    const space = visibleSpaces[index];
    if (space) {
      if (metaKey && tabs) {
        if (space.tab) onSwitch(space.path, true);
        return;
      }
      onSwitch(space.path, false);
      return;
    }
    if (index === revealActionIndex) {
      onRevealCurrent();
      return;
    }
    if (index === addSpaceActionIndex) onAddSpace();
  }, [addSpaceActionIndex, onAddSpace, onRevealCurrent, onSwitch, revealActionIndex, tabs, visibleSpaces]);

  /// What the row at `index` is: a space, or one of the pinned actions.
  const rowKeyAt = useCallback((index: number): string => {
    const space = visibleSpaces[index];
    if (space) return `space:${space.path}`;
    return index === revealActionIndex ? "reveal" : "add";
  }, [revealActionIndex, visibleSpaces]);

  // A chosen row blinks once before the menu closes and its command runs, as
  // an item of any other menu does (src/lib/menuBlink.ts; user's decision of
  // 15.11.2026). A press and Enter in the field choose a row by this one path.
  const chooseIndex = useCallback((index: number | null, metaKey = false) => {
    if (index === null) return;
    rowBlink.choose(rowKeyAt(index), () => activateIndex(index, metaKey));
  }, [activateIndex, rowBlink.choose, rowKeyAt]);

  // While a row blinks it is the one row lit, out for the first half, so its
  // highlight comes back in the second half whether a press or Enter chose it,
  // wherever the pointer goes meanwhile.
  const rowLit = (index: number): boolean => rowBlink.lit(rowKeyAt(index), activeIndex === index);
  const rowOff = (index: number): boolean => rowBlink.outAt(rowKeyAt(index));
  const blinking = rowBlink.blinking;

  const restoreSearchFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
    });
  }, []);

  const handleSearchKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // The list's own Escape decides (below): it is heard on the window
      // before the field, and by now has cleared the query, or the menu
      // above has closed, dropping a blinking row's command.
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // During a row's blink the menu takes no other key: the list and the
    // query stay as they were chosen from.
    if (blinking) {
      event.preventDefault();
      event.stopPropagation();
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
    chooseIndex(activeIndex, event.metaKey);
  }, [activeIndex, blinking, chooseIndex, moveActiveIndex, restoreSearchFocus]);

  // With a query typed, the first Escape clears it, the menu stays open with
  // the caret in the field, and the next one closes it, as in every field
  // over a list (SPEC_KEYBOARD.md, «Ввод текста в меню»). During a row's
  // blink Escape is the menu's: it closes, and the command is dropped. Heard
  // on the window ahead of every menu: the menu above hears Escape on the
  // document and would close over a query.
  const escapeState = useRef({ query, blinking, resetMenuSearch, restoreSearchFocus });
  useLayoutEffect(() => {
    escapeState.current = { query, blinking, resetMenuSearch, restoreSearchFocus };
  });
  useEffect(() => {
    const view = rootRef.current?.ownerDocument.defaultView ?? window;
    const handle = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      const root = rootRef.current;
      if (!root || !event.composedPath().includes(root)) return;
      const state = escapeState.current;
      if (!state.query || state.blinking) return;
      event.preventDefault();
      event.stopPropagation();
      state.resetMenuSearch();
      state.restoreSearchFocus();
    };
    view.addEventListener("keydown", handle, true);
    return () => view.removeEventListener("keydown", handle, true);
  }, []);

  return (
    <TooltipProvider>
      {/* The field, the list and the pinned actions are the surface's own
          children in its layout: this box draws nothing. */}
      <div ref={rootRef} className="contents" data-space-list="">
        <SearchMenuInput
          ref={searchInputRef}
          aria-label="Search spaces"
          aria-activedescendant={activeActionId}
          placeholder="Search spaces..."
          value={query}
          onChange={(event) => {
            if (blinking) return;
            setQuery(event.target.value);
            setActiveIndex(null);
          }}
          onKeyDown={handleSearchKeyDown}
          data-top-space-search=""
        />
        <QuantizedMenuScrollArea
          rowCount={Math.max(visibleSpaces.length + visibleUnavailable.length, 1)}
          maxRows={8}
          innerClassName="p-surface"
        >
          {visibleSpaces.length > 0 ? (
            visibleSpaces.map((space, index) => (
              <SpaceRow
                key={space.path}
                id={`${actionIdPrefix}-space-action-${index}`}
                space={space}
                active={rowLit(index)}
                onActive={() => setActiveIndex(index)}
                blinkOff={rowOff(index)}
                onSwitch={({ metaKey }) => chooseIndex(index, metaKey)}
                newTab={tabs ? { open: space.tab ? () => onSwitch(space.path, true) : null } : null}
                onReveal={() => onReveal(space.path)}
                onRequestForget={() => onRequestForget(space.path)}
              />
            ))
          ) : visibleUnavailable.length === 0 ? (
            <div className="flex h-[var(--menu-row-height)] items-center gap-2 px-plate text-base text-muted-foreground">
              <MenuIconSlot />
              No other spaces
            </div>
          ) : null}
          {visibleUnavailable.map((space) => (
            <UnavailableSpaceRow
              key={space.path}
              space={space}
              onRequestForget={() => onRequestForget(space.path)}
            />
          ))}
        </QuantizedMenuScrollArea>
        <div className="border-t border-border p-surface" data-vault-switcher-pinned-actions="">
          <SearchMenuAction
            id={`${actionIdPrefix}-space-action-${revealActionIndex}`}
            active={rowLit(revealActionIndex)}
            blinkOff={rowOff(revealActionIndex)}
            onActive={() => setActiveIndex(revealActionIndex)}
            onPress={() => chooseIndex(revealActionIndex)}
          >
            <MenuIconSlot>
              <FolderOpen className="size-[13px]" />
            </MenuIconSlot>
            Reveal in Finder
          </SearchMenuAction>
          <SearchMenuAction
            id={`${actionIdPrefix}-space-action-${addSpaceActionIndex}`}
            active={rowLit(addSpaceActionIndex)}
            blinkOff={rowOff(addSpaceActionIndex)}
            onActive={() => setActiveIndex(addSpaceActionIndex)}
            onPress={() => chooseIndex(addSpaceActionIndex)}
          >
            <MenuIconSlot>
              <FolderPlus className="size-[13px]" />
            </MenuIconSlot>
            Add space
          </SearchMenuAction>
        </div>
      </div>
    </TooltipProvider>
  );
}

/// One space in the list: the row switches, the icons beside it act on the
/// folder itself.
///
/// The icons sit next to the row rather than inside it — the row is a `button`,
/// and a control nested in a button is invalid markup. They are also plain
/// buttons rather than an overflow menu: a menu inside an open menu fights the
/// outer one for pointer and focus, and two actions do not need a container.
function SpaceRow({
  id,
  space,
  active,
  blinkOff,
  onActive,
  onSwitch,
  newTab,
  onReveal,
  onRequestForget,
}: {
  id: string;
  space: MenuSpace;
  active: boolean;
  /// The row was chosen and its highlight is out (menuBlink.ts).
  blinkOff: boolean;
  onActive: () => void;
  onSwitch: (modifiers: { metaKey: boolean }) => void;
  /// The Open in New Tab action, on a page that opens tabs. `open` is null
  /// while the space has no identity yet: the action shows, disabled.
  newTab: { open: (() => void) | null } | null;
  onReveal: () => void;
  onRequestForget: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const { name, path } = space;
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
        blinkOff={blinkOff}
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
          "absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 transition-opacity",
          // Buttons that come up under the pointer answer as Отклик: in on
          // the enter time, out on the exit time (В2; user's decision of
          // 12.11.2026).
          responseFadeClass(actionsVisible),
          actionsVisible ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        data-vault-switcher-row-actions=""
      >
        {/* Each button says its own tooltip through `Button` itself, the
            one tooltip it shows; its `aria-label` names the space for
            assistive technology (user's decision of 15.11.2026: an icon
            button showed its label as a second tooltip beside this one). */}
        {newTab && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Open ${name} in New Tab`}
            tooltip="Open in New Tab"
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
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Reveal ${name} in Finder`}
          tooltip="Reveal in Finder"
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
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${name} from the list`}
          // The X is the one action in this menu whose consequence is easy to
          // misread, so the tooltip states what stays untouched.
          tooltip="Remove from the list — files stay on disk"
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
      </div>
    </div>
  );
}
