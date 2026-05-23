import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SearchMenuActionProps {
  id?: string;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
  onPress: () => void;
  onActive?: () => void;
}

export function SearchMenuAction({
  id,
  active = false,
  disabled = false,
  children,
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
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-1 px-2 py-1.5 text-left text-base outline-hidden select-none",
        "hover:bg-active focus-visible:bg-active",
        active && "bg-active",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
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
          onPress();
        }
      }}
    >
      {children}
    </button>
  );
}
