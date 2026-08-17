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
}

function vaultName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() || path;
}

export function VaultSelect({ value, options, onChange, onReveal, onAddSpace, onClose }: VaultSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const actionIdPrefix = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
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
      setQuery("");
      setActiveIndex(null);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
      searchInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

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
      event.preventDefault();
      event.stopPropagation();
      if (query) {
        setQuery("");
      } else {
        setOpen(false);
      }
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
    const path = visibleVaults[activeIndex];
    if (path) {
      selectVault(path);
      return;
    }
    if (activeIndex === revealActionIndex && value) {
      setOpen(false);
      onReveal(value);
      return;
    }
    if (activeIndex === addSpaceActionIndex) {
      setOpen(false);
      onAddSpace();
    }
  }, [
    activeIndex,
    addSpaceActionIndex,
    moveActiveIndex,
    onAddSpace,
    onReveal,
    query,
    revealActionIndex,
    selectVault,
    value,
    visibleVaults,
  ]);

  return (
    <div className="flex h-10 shrink-0 items-center border-b border-border bg-accent px-2" data-clipper-space-row="">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <MenuTextTrigger
            ref={triggerRef}
            aria-label={`Switch space: ${label}`}
            label={label}
            surface="clipperHeader"
            showChevron
            data-clipper-space-switcher=""
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={4}
          widthRole="selector"
          className="overflow-hidden bg-accent p-0 text-foreground"
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
                  active={activeIndex === index}
                  rowSize="clipper"
                  onActive={() => setActiveIndex(index)}
                  onPress={() => selectVault(path)}
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
              active={activeIndex === revealActionIndex}
              rowSize="clipper"
              onActive={() => setActiveIndex(revealActionIndex)}
              onPress={() => {
                if (!value) return;
                setOpen(false);
                onReveal(value);
              }}
            >
              <MenuIconSlot>
                <FolderOpen className="size-3" />
              </MenuIconSlot>
              Reveal in Finder
            </SearchMenuAction>
            <SearchMenuAction
              id={`${actionIdPrefix}-clipper-space-action-${addSpaceActionIndex}`}
              active={activeIndex === addSpaceActionIndex}
              rowSize="clipper"
              onActive={() => setActiveIndex(addSpaceActionIndex)}
              onPress={() => {
                setOpen(false);
                onAddSpace();
              }}
            >
              <MenuIconSlot>
                <FolderPlus className="size-3" />
              </MenuIconSlot>
              Add space
            </SearchMenuAction>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="ml-auto flex items-center gap-1">
        <ClipperOverflowMenu appInstalled />
        {onClose && (
          <ChromeCloseButton label="Close" onClick={onClose} />
        )}
      </span>
    </div>
  );
}
