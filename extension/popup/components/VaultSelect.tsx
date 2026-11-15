import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { FolderOpen, FolderPlus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChromeCloseButton } from "@/components/ChromeCloseButton";
import { MenuIconSlot } from "@/components/ui/menu-icon-slot";
import { MenuTextTrigger } from "@/components/MenuTextTrigger";
import { QuantizedMenuScrollArea } from "@/components/QuantizedMenuScrollArea";
import { SearchMenuAction } from "@/components/SearchMenuAction";
import { SearchMenuInput } from "@/components/SearchMenuInput";
import { filterAndRankChannelSearch } from "@/lib/channelSearch";
import { useMenuRowBlink } from "@/lib/menuBlink";
import { ClipperOverflowMenu } from "./ClipperOverflowMenu";

interface VaultSelectProps {
  value: string | null;
  options: string[];
  onChange: (value: string) => void;
  /// Desktop parity: the pinned actions below the space list. Reveal targets
  /// the current space; Add opens the host's system folder chooser.
  onReveal: (path: string) => void;
  onAddSpace: () => void;
  onClose?: () => void;
  canOpenApp?: boolean;
  onRetryConnection?: () => Promise<unknown>;
}

function vaultName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() || path;
}

export function VaultSelect({ value, options, onChange, onReveal, onAddSpace, onClose, canOpenApp = false, onRetryConnection }: VaultSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // A chosen row blinks once before the list closes and its command runs, as
  // a row of the app's menu of spaces does (src/lib/menuBlink.ts; user's
  // decision of 15.11.2026). A row is blinked by what it is, a space or a
  // pinned action, not by its place in the list.
  const rowBlink = useMenuRowBlink<string>();
  const actionIdPrefix = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The pointer press on the name whose click decides the menu: whether the
  // menu was shut when it began. A press on an open menu shuts it.
  const pointerPressRef = useRef<{ opensMenu: boolean } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const label = value ? vaultName(value) : "";

  const destinationVaults = useMemo(() => (
    Array.from(new Set(options))
      .filter((path) => path !== value)
      .sort((a, b) => vaultName(a).localeCompare(vaultName(b)))
  ), [options, value]);

  const visibleVaults = useMemo(() => (
    filterAndRankChannelSearch(
      destinationVaults.map((path) => ({
        item: path,
        texts: [vaultName(path), path],
      })),
      query,
    )
  ), [destinationVaults, query]);

  const revealActionIndex = visibleVaults.length;
  const addSpaceActionIndex = visibleVaults.length + 1;
  const actionCount = visibleVaults.length + 2;

  const activeActionId = activeIndex === null
    ? undefined
    : `${actionIdPrefix}-clipper-space-action-${activeIndex}`;

  useEffect(() => {
    if (!open) {
      // The list closed during a row's blink: its command does not run.
      rowBlink.cancel();
      setQuery("");
      setActiveIndex(null);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
      searchInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, rowBlink.cancel]);

  useEffect(() => {
    setActiveIndex((current) => {
      if (current === null) return current;
      if (current < actionCount) return current;
      return actionCount > 0 ? actionCount - 1 : null;
    });
  }, [actionCount]);

  const selectVault = useCallback((path: string) => {
    setOpen(false);
    setQuery("");
    setActiveIndex(null);
    onChange(path);
  }, [onChange]);

  /// What the row at `index` is: a space, or one of the pinned actions.
  const rowKeyAt = useCallback((index: number): string => {
    const path = visibleVaults[index];
    if (path) return `space:${path}`;
    return index === revealActionIndex ? "reveal" : "add";
  }, [revealActionIndex, visibleVaults]);

  /// The command of the row at `index`; null for a row that does nothing
  /// (Reveal in Finder with no space chosen), which does not blink either.
  const commandAt = useCallback((index: number): (() => void) | null => {
    const path = visibleVaults[index];
    if (path) return () => selectVault(path);
    if (index === revealActionIndex) {
      if (!value) return null;
      return () => {
        setOpen(false);
        onReveal(value);
      };
    }
    if (index === addSpaceActionIndex) {
      return () => {
        setOpen(false);
        onAddSpace();
      };
    }
    return null;
  }, [addSpaceActionIndex, onAddSpace, onReveal, revealActionIndex, selectVault, value, visibleVaults]);

  // A press and Enter in the field choose a row by this one path: the row
  // blinks, then the list closes and the command runs, once.
  const chooseIndex = useCallback((index: number | null) => {
    if (index === null) return;
    const command = commandAt(index);
    if (!command) return;
    rowBlink.choose(rowKeyAt(index), command);
  }, [commandAt, rowBlink.choose, rowKeyAt]);

  // While a row blinks it is the one row lit, out for the first half.
  const rowLit = (index: number): boolean => rowBlink.lit(rowKeyAt(index), activeIndex === index);
  const rowOff = (index: number): boolean => rowBlink.outAt(rowKeyAt(index));
  const blinking = rowBlink.blinking;

  const moveActiveIndex = useCallback((direction: 1 | -1) => {
    if (actionCount <= 0) return;
    setActiveIndex((current) => {
      if (current === null) return direction > 0 ? 0 : actionCount - 1;
      const nextIndex = current + direction;
      if (nextIndex < 0) return 0;
      if (nextIndex >= actionCount) return actionCount - 1;
      return nextIndex;
    });
  }, [actionCount]);

  const handleSearchKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // The menu's own Escape decides (onEscapeKeyDown below): Radix hears
      // the key on the document before the field, and by now has cleared
      // the query or closed the menu, dropping a blinking row's command.
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // During a row's blink the list takes no other key: the rows and the
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
      return;
    }

    if (event.key !== "Enter" || activeIndex === null) return;
    event.preventDefault();
    event.stopPropagation();
    chooseIndex(activeIndex);
  }, [
    activeIndex,
    blinking,
    chooseIndex,
    moveActiveIndex,
    query,
    rowBlink.cancel,
  ]);

  return (
    // The header: in the overlay a press anywhere in it, the space's name
    // included, drags the panel past the threshold (SPEC_CLIPPER.md, Р10).
    <div className="flex h-10 shrink-0 select-none items-center border-b border-border bg-accent px-2" data-clipper-space-row="" data-clipper-drag-handle="">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          asChild
          // A press on the name may become a drag of the overlay, so the
          // pointer opens the menu on the click that follows a press without
          // movement, not on the press, as the app's top chrome does
          // (useTopChromeTriggerInteraction.ts, deferPointerOpen). The
          // keyboard keeps Radix's own Enter, Space and ArrowDown.
          onPointerDown={(event) => {
            if (event.button !== 0 || event.ctrlKey) return;
            event.preventDefault();
            pointerPressRef.current = { opensMenu: !open };
          }}
          onClick={() => {
            const press = pointerPressRef.current;
            pointerPressRef.current = null;
            if (press) setOpen(press.opensMenu);
          }}
        >
          <MenuTextTrigger
            ref={triggerRef}
            aria-label={`Switch space: ${label}`}
            label={label}
            surface="clipperHeader"
            showChevron
            data-clipper-space-switcher=""
            data-clipper-drag-control=""
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="bottom"
          widthRole="search"
          className="overflow-hidden bg-accent p-0 text-foreground"
          // Radix hears Escape on the document before the field does and
          // would close the whole list: with a query typed, the first Escape
          // clears it and the list stays open with the caret in the field,
          // the next one closes it. During a row's blink Escape drops the
          // command and closes the list.
          onEscapeKeyDown={(event) => {
            if (!query || rowBlink.blinking) return;
            event.preventDefault();
            setQuery("");
            setActiveIndex(null);
            searchInputRef.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.blur();
          }}
        >
          <SearchMenuInput
            ref={searchInputRef}
            aria-label="Search spaces"
            aria-activedescendant={activeActionId}
            placeholder="Search spaces..."
            controlSize="clipper"
            value={query}
            onChange={(event) => {
              if (blinking) return;
              setQuery(event.target.value);
              setActiveIndex(null);
            }}
            onKeyDown={handleSearchKeyDown}
          />
          <QuantizedMenuScrollArea
            rowCount={Math.max(visibleVaults.length, 1)}
            rowSize="clipper"
            maxRows={7}
            innerClassName="p-1"
          >
            {visibleVaults.length > 0 ? (
              visibleVaults.map((path, index) => (
                <SearchMenuAction
                  id={`${actionIdPrefix}-clipper-space-action-${index}`}
                  key={path}
                  active={rowLit(index)}
                  blinkOff={rowOff(index)}
                  rowSize="clipper"
                  onActive={() => setActiveIndex(index)}
                  onPress={() => chooseIndex(index)}
                >
                  <MenuIconSlot />
                  <span className="min-w-0 truncate">
                    {vaultName(path)}
                  </span>
                </SearchMenuAction>
              ))
            ) : (
              <div className="flex h-[var(--menu-row-height)] items-center gap-2 px-2 text-base text-muted-foreground">
                <MenuIconSlot />
                No other spaces
              </div>
            )}
          </QuantizedMenuScrollArea>
          <div className="border-t border-border p-1" data-clipper-space-pinned-actions="">
            <SearchMenuAction
              id={`${actionIdPrefix}-clipper-space-action-${revealActionIndex}`}
              active={rowLit(revealActionIndex)}
              blinkOff={rowOff(revealActionIndex)}
              rowSize="clipper"
              onActive={() => setActiveIndex(revealActionIndex)}
              onPress={() => chooseIndex(revealActionIndex)}
            >
              <MenuIconSlot>
                <FolderOpen className="size-[13px]" />
              </MenuIconSlot>
              Reveal in Finder
            </SearchMenuAction>
            <SearchMenuAction
              id={`${actionIdPrefix}-clipper-space-action-${addSpaceActionIndex}`}
              active={rowLit(addSpaceActionIndex)}
              blinkOff={rowOff(addSpaceActionIndex)}
              rowSize="clipper"
              onActive={() => setActiveIndex(addSpaceActionIndex)}
              onPress={() => chooseIndex(addSpaceActionIndex)}
            >
              <MenuIconSlot>
                <FolderPlus className="size-[13px]" />
              </MenuIconSlot>
              Add space
            </SearchMenuAction>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Above the overlay's resize corner: the buttons keep every pixel. */}
      <span className="relative z-10 ml-auto flex items-center gap-1">
        <ClipperOverflowMenu canOpenApp={canOpenApp} vaultPath={value} onRetryConnection={onRetryConnection} />
        {onClose && (
          <ChromeCloseButton label="Close" onClick={onClose} />
        )}
      </span>
    </div>
  );
}
