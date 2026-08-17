// The one shape every notification takes.
//
// Bottom-right, fixed offsets, the popover surface — the brightest plane the
// system has, same as menu content — no decorative icons, the standard close
// button, text aligned left. Notifications earn attention with words, not
// pictures: the icon-economy rule gives an icon only to what it disambiguates,
// and a card that interrupts is already unambiguous.
// See DESIGN_SYSTEM.md.

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The fixed corner every notification appears in. */
export function NotificationAnchor({ children }: { children: ReactNode }) {
  return (
    <div className="fixed bottom-4 right-4 z-40" data-notification-anchor="">
      {children}
    </div>
  );
}

interface NotificationCardProps {
  title: string;
  onClose: () => void;
  closeLabel?: string;
  children: ReactNode;
}

export function NotificationCard({
  title,
  onClose,
  closeLabel = "Dismiss",
  children,
}: NotificationCardProps) {
  return (
    <div
      className="w-80 rounded-1 border border-border bg-popover p-3 text-popover-foreground shadow-md"
      data-notification-card=""
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-base font-semibold">{title}</p>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={closeLabel}
          className="-mr-1 -mt-1 shrink-0"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="mt-1 grid gap-2 text-left">{children}</div>
    </div>
  );
}
