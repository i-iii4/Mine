// The one shape every notification takes.
//
// Bottom-right of the feed, the popover surface — the brightest plane the
// system has, same as menu content — no decorative icons, text aligned left.
// Notifications earn attention with words, not pictures: the icon-economy
// rule gives an icon only to what it disambiguates, and a card that
// interrupts is already unambiguous. See DESIGN_SYSTEM.md, «Уведомления».

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The corner every notification appears in: on the feed's own inset from
 * the window's right edge, so it stands on the cards' right edge (user's
 * decision of 08.10.2026), and 16 px above the bottom bar's top edge, which
 * it never covers (decision of 14.10.2026). The page publishes that distance
 * from where the bar stands (`publishNotificationBottom`); without a bar the
 * corner keeps the feed's inset from the window's edge.
 */
export function NotificationAnchor({ children }: { children: ReactNode }) {
  return (
    <div
      className="fixed right-[var(--edge-rhythm,32px)] bottom-[var(--notification-bottom,var(--edge-rhythm,32px))] z-40"
      data-notification-anchor=""
    >
      {children}
    </div>
  );
}

interface NotificationCardProps {
  title: string;
  /** What stands on the title's line at its right end: the count of a notice
   *  of work in progress. */
  aside?: ReactNode;
  /** Closing for good. A notice of work in progress has none: closing it
   *  would hide the work and stop nothing (SPEC_ONBOARDING.md, О13). */
  onClose?: () => void;
  closeLabel?: string;
  children: ReactNode;
}

export function NotificationCard({
  title,
  aside,
  onClose,
  closeLabel = "Dismiss",
  children,
}: NotificationCardProps) {
  return (
    <div
      // A long word, such as a path in an error, breaks inside the card
      // instead of running past its edge.
      className="w-80 rounded-1 border border-border bg-popover p-3 text-popover-foreground shadow-md [overflow-wrap:anywhere]"
      data-notification-card=""
    >
      {/* The title and what stands beside it share a baseline; the close
          button keeps to the top. */}
      <div className="flex items-baseline gap-2">
        {/* A line of the interface, set like a menu item: the notice is on
            the same floating plane as menus, not a heading of a section. */}
        <p className="min-w-0 flex-1 text-base text-foreground">{title}</p>
        {aside}
        {onClose && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={closeLabel}
            className="-mr-1 -mt-1 shrink-0 self-start"
            onClick={onClose}
          >
            <X className="size-[13px]" />
          </Button>
        )}
      </div>
      {/* A line break an error carries stays a line (a refused Trash's way
          out, decision of 14.10.2026). */}
      <div className="mt-1 grid gap-2 text-left whitespace-pre-line">{children}</div>
    </div>
  );
}
