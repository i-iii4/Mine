// Shared metadata-row language: mono muted label on the left, sans value on
// the right, a hairline separator under every row except the last. Owned by
// the Detail metadata panel and reused by the search-overlay metadata block —
// one visual contract for "metadata about a card" everywhere.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const METADATA_LABEL_CLASSES =
  "whitespace-nowrap font-mono text-sm leading-4 text-muted-foreground";
export const METADATA_VALUE_BASE_CLASSES =
  "block min-w-0 font-sans text-sm leading-4 text-foreground";

/** Clickable metadata value (e.g. Source domain): plain text, underline on hover. */
export function MetadataLinkValue({
  value,
  onClick,
}: {
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // Leaves the app for the browser, which is the one thing the pointing
      // hand means in macOS. Controls that act inside Mine keep the arrow.
      className={cn(
        METADATA_VALUE_BASE_CLASSES,
        "w-full cursor-pointer truncate text-right hover:underline",
      )}
      title={value}
    >
      {value}
    </button>
  );
}

interface MetadataRowProps {
  label: string;
  children: ReactNode;
}

export function MetadataRow({
  label,
  children,
}: MetadataRowProps) {
  return (
    <div
      className="relative grid w-full grid-cols-[max-content_minmax(0,1fr)] items-start gap-x-4 pb-2 after:absolute after:bottom-1 after:left-0 after:right-0 after:border-t after:border-border last:pb-0 last:after:hidden"
      data-metadata-row
    >
      <div className={METADATA_LABEL_CLASSES}>
        {label}
      </div>
      <div className="min-w-0 text-right">{children}</div>
    </div>
  );
}
