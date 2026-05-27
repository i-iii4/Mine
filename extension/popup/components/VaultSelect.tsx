import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChromeCloseButton } from "@/components/ChromeCloseButton";
import { MenuTextTrigger } from "@/components/MenuTextTrigger";
import { QuantizedMenuScrollArea } from "@/components/QuantizedMenuScrollArea";
import { SearchMenuAction } from "@/components/SearchMenuAction";
import { SearchMenuInput } from "@/components/SearchMenuInput";
import { filterAndRankChannelSearch } from "@/lib/channelSearch";

interface VaultSelectProps {
  value: string | null;
  options: string[];
  onChange: (value: string) => void;
  onClose?: () => void;
}

function vaultName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() || path;
}

export function VaultSelect({ value, options, onChange, onClose }: VaultSelectProps) {
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
      if (current < visibleVaults.length) return current;
      return visibleVaults.length > 0 ? visibleVaults.length - 1 : null;
    });
  }, [visibleVaults.length]);

  const selectVault = useCallback((path: string) => {
    setOpen(false);
    setQuery("");
    setActiveIndex(null);
    onChange(path);
  }, [onChange]);

  const moveActiveIndex = useCallback((direction: 1 | -1) => {
    if (visibleVaults.length <= 0) return;
    setActiveIndex((current) => {
      if (current === null) return direction > 0 ? 0 : visibleVaults.length - 1;
      const nextIndex = current + direction;
      if (nextIndex < 0) return 0;
      if (nextIndex >= visibleVaults.length) return visibleVaults.length - 1;
      return nextIndex;
    });
  }, [visibleVaults.length]);

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
    const path = visibleVaults[activeIndex];
    if (!path) return;
    event.preventDefault();
    event.stopPropagation();
    selectVault(path);
  }, [activeIndex, moveActiveIndex, query, selectVault, visibleVaults]);

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
                  <span className="min-w-0 truncate">
                    {vaultName(path)}
                  </span>
                </SearchMenuAction>
              ))
            ) : (
              <div className="flex h-[var(--menu-row-height)] items-center px-2 text-base text-muted-foreground">
                No other spaces
              </div>
            )}
          </QuantizedMenuScrollArea>
        </DropdownMenuContent>
      </DropdownMenu>
      {onClose && (
        <ChromeCloseButton
          className="ml-auto"
          label="Close clipper"
          onClick={onClose}
        />
      )}
    </div>
  );
}
