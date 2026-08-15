// Two indicators in the top chrome, next to the space's own numbers.
//
// They answer two different questions and are therefore two different icons:
// "content is coming down from iCloud" and "the space is being indexed". One
// combined spinner would say only "busy", which explains nothing and cannot be
// acted on. See SPEC_CLOUD_STORAGE.md Х14–Х15.

import { CloudDownload, RefreshCw } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CLOUD_STATE_LABEL } from "@/lib/cloudContent";

interface ActivityIndicatorsProps {
  /// Cards whose content is currently held in iCloud.
  cloudPending: number;
  /// Whether the space is being indexed right now.
  indexing: boolean;
  /// Opens the folder in Finder so the user can mark it Keep Downloaded.
  onRevealSpace?: () => void;
}

export function ActivityIndicators({
  cloudPending,
  indexing,
  onRevealSpace,
}: ActivityIndicatorsProps) {
  if (cloudPending === 0 && !indexing) return null;

  return (
    <div
      className="flex shrink-0 items-center gap-2"
      data-main-secondary-activity=""
    >
      {indexing && (
        <span
          className="flex items-center text-tertiary-foreground"
          data-activity-indicator="indexing"
          title="Indexing this space"
        >
          <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
        </span>
      )}

      {cloudPending > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center text-tertiary-foreground hover:text-foreground"
              data-activity-indicator="cloud"
              aria-label={CLOUD_STATE_LABEL}
            >
              <CloudDownload className="size-3.5" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80 p-3">
            <p className="text-base font-semibold text-foreground">
              {CLOUD_STATE_LABEL}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              macOS keeps the contents of {cloudPending}{" "}
              {cloudPending === 1 ? "file" : "files"} in iCloud to save disk
              space, so those cards fill in as their contents arrive. Your files
              are safe — this is how iCloud stores them.
            </p>
            {onRevealSpace && (
              <DropdownMenuItem className="mt-2" onSelect={onRevealSpace}>
                Keep this space on this Mac…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
