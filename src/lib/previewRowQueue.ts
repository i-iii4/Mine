import type { GridRowsSnapshot } from "@/types";

const BATCH_DELAY_MS = 32;
const BATCH_LIMIT = 200;

/** Coalesce invalidations with one bounded request in flight. Dispose on route changes. */
export function createPreviewRowQueue(options: {
  fetch: (slugs: string[]) => Promise<GridRowsSnapshot>;
  apply: (snapshot: GridRowsSnapshot) => void;
  onError: (error: unknown) => void;
}) {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let disposed = false;
  function schedule() {
    if (disposed || running || timer !== undefined || pending.size === 0) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, BATCH_DELAY_MS);
  }
  async function flush() {
    const slugs = [...pending].slice(0, BATCH_LIMIT);
    for (const slug of slugs) pending.delete(slug);
    running = true;
    try {
      const snapshot = await options.fetch(slugs);
      if (!disposed) options.apply(snapshot);
    } catch (error) {
      if (!disposed) options.onError(error);
    } finally {
      running = false;
      schedule();
    }
  }
  return {
    add(slug: string) { if (!disposed) { pending.add(slug); schedule(); } },
    dispose() { disposed = true; clearTimeout(timer); pending.clear(); },
  };
}
