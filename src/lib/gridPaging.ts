/// How many blocks a refresh of the current route must ask for.
///
/// A refresh is not a first load: the user may have scrolled through several
/// pages, and asking for one page again would drop everything below it. Those
/// cards unmount and mount again — video restarts, posters refetch, the feed
/// visibly rebuilds — as the cost of an edit that touched a single card.
///
/// Rounded up to whole pages so the backend returns one contiguous span, and
/// never below a single page so an empty route still loads.
export function refreshPageLimit(loadedCount: number, pageSize: number): number {
  if (pageSize <= 0) throw new Error("page size must be positive");
  const loaded = Math.max(0, loadedCount);
  return Math.max(pageSize, Math.ceil(loaded / pageSize) * pageSize);
}
