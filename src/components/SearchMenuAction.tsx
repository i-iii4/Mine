import type { ReactNode } from "react";
import {
  menuRowHeightStyle,
  type MenuRowSize,
} from "@/components/QuantizedMenuScrollArea";
import { cn } from "@/lib/utils";

interface SearchMenuActionProps {
  id?: string;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
  rowSize?: MenuRowSize;
  className?: string;
  /** `metaKey`: the row was pressed with ⌘, which some menus read as "elsewhere". */
  onPress: (modifiers: { metaKey: boolean }) => void;
  onActive?: () => void;
}

export function SearchMenuAction({
  id,
  active = false,
  disabled = false,
  children,
  rowSize = "default",
  className,
  onPress,
  onActive,
}: SearchMenuActionProps) {
  return (
    <button
      id={id}
      type="button"
      role="menuitem"
      aria-selected={active ? "true" : undefined}
      disabled={disabled}
      data-search-menu-action-active={active ? "true" : undefined}
      data-menu-row-size={rowSize}
      className={cn(
        "relative flex h-[var(--menu-row-height)] w-full cursor-default items-center gap-2 rounded-1 px-2 py-0 text-left text-base outline-hidden select-none",
        "hover:state-active focus-visible:state-active",
        active && "state-active",
        disabled && "pointer-events-none text-tertiary-foreground",
        className,
      )}
      style={menuRowHeightStyle(rowSize)}
      onPointerMove={() => {
        if (!disabled) {
          onActive?.();
        }
      }}
      onPointerDown={(event) => {
        event.preventDefault();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!disabled) {
          onPress({ metaKey: event.metaKey });
        }
      }}
    >
      {children}
    </button>
  );
}
