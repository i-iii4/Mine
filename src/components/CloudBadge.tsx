// The small marker on a card whose content is still in iCloud.
//
// Deliberately quiet and deliberately late: it appears only after the card has
// been waiting long enough that silence would be confusing, so ordinary fast
// loading never flashes it. See SPEC_CLOUD_STORAGE.md Х6.

import { useEffect, useState } from "react";
import { Cloud } from "lucide-react";
import { CLOUD_BADGE_DELAY_MS, CLOUD_STATE_LABEL } from "@/lib/cloudContent";
import { cn } from "@/lib/utils";

interface CloudBadgeProps {
  /// Whether this card's content is known to be in iCloud.
  active: boolean;
  className?: string;
}

export function CloudBadge({ active, className }: CloudBadgeProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), CLOUD_BADGE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [active]);

  if (!visible) return null;

  return (
    <span
      className={cn(
        "pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded-1",
        "bg-card/80 px-1.5 py-0.5 text-sm text-muted-foreground backdrop-blur-sm",
        className,
      )}
      data-card-cloud-badge=""
      title={CLOUD_STATE_LABEL}
    >
      <Cloud className="size-3" aria-hidden="true" />
    </span>
  );
}
