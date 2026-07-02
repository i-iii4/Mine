import { cn } from "@/lib/utils";

/**
 * Decorative play affordance drawn over a still poster. It marks a card as a
 * video whenever the live surface is not actually playing — the poster,
 * loading and failed states — so a degraded clip never sits as a bare frame
 * indistinguishable from an image. Pointer events pass through so the parent
 * card keeps click, hover and drag ownership.
 *
 * Lives in its own module (not exported from Card) so `FeedVideoSurface` can
 * render it without importing Card, which would create a cycle.
 */
export function PlayBadge({ className }: { className?: string }) {
  return (
    <div
      data-feed-play-badge=""
      className={cn(
        "pointer-events-none absolute inset-0 flex items-center justify-center",
        className,
      )}
    >
      <div className="flex size-8 items-center justify-center rounded-full bg-black/50 text-white">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 2.5v11l10-5.5L4 2.5z" />
        </svg>
      </div>
    </div>
  );
}
