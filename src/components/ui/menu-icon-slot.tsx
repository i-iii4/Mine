import type { ReactNode } from "react";

// Fixed-size leading icon slot for menu items: rows with and without icons
// stay vertically aligned (icon economy rules, DESIGN_SYSTEM.md).
export function MenuIconSlot({ children }: { children?: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-3 shrink-0 items-center justify-center"
      data-card-menu-icon-slot=""
    >
      {children}
    </span>
  );
}
