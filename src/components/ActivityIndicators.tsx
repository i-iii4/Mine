// The indexing indicator in the top chrome, next to the space's own numbers
// (SPEC_CLOUD_STORAGE.md, Х15).
//
// The iCloud download icon that stood beside it is gone (Х14, user's
// decision of 08.10.2026): the cards carry their own cloud marks, the opening
// notice counts what is coming, and the Keep Downloaded advice explains it.

import { RefreshCw } from "lucide-react";

interface ActivityIndicatorsProps {
  /// Whether the space is being indexed right now.
  indexing: boolean;
}

export function ActivityIndicators({ indexing }: ActivityIndicatorsProps) {
  if (!indexing) return null;

  return (
    <div
      className="flex shrink-0 items-center gap-2"
      data-main-secondary-activity=""
    >
      <span
        className="flex items-center text-tertiary-foreground"
        data-activity-indicator="indexing"
        title="Indexing this space"
      >
        <RefreshCw className="size-[13px] animate-spin" aria-hidden="true" />
      </span>
    </div>
  );
}
