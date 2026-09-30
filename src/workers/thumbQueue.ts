// The thumbnail worker's queue: a FIFO with a fixed number of requests in
// flight and a time limit on each.
//
// A request that never ends (a stalled read, a decode that hangs on a broken
// file) used to hold its place for good; four of them stopped every other
// thumbnail (SPEC_AUDIT_FIXES.md, А8.5). Past its limit a request is reported
// as failed and its place goes to the next one.

export interface ThumbRequest {
  id: string;
  slug: string;
}

export interface ThumbQueueOptions<R extends ThumbRequest> {
  concurrency: number;
  timeoutMs: number;
  /** Produce the encoded thumbnail; `signal` aborts its reads. */
  produce: (request: R, signal: AbortSignal) => Promise<ArrayBuffer>;
  succeeded: (request: R, bytes: ArrayBuffer) => void;
  failed: (request: R, error: string) => void;
}

interface Entry<R> {
  request: R;
  abort: AbortController;
}

export interface ThumbQueue<R> {
  push(request: R): void;
  /** Drop the waiting requests and abort the running ones, silently. */
  cancelAll(): void;
}

export function createThumbQueue<R extends ThumbRequest>(options: ThumbQueueOptions<R>): ThumbQueue<R> {
  const waiting: Entry<R>[] = [];
  const active = new Set<Entry<R>>();

  async function run(entry: Entry<R>): Promise<void> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        entry.abort.abort();
        reject(new Error(`thumbnail for ${entry.request.slug} took longer than ${options.timeoutMs} ms`));
      }, options.timeoutMs);
    });
    try {
      const bytes = await Promise.race([options.produce(entry.request, entry.abort.signal), deadline]);
      options.succeeded(entry.request, bytes);
    } catch (error) {
      // A cancel asked for silence; a timeout is a failure the main thread
      // must hear about.
      if (entry.abort.signal.aborted && !timedOut) return;
      options.failed(entry.request, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  function pump(): void {
    while (active.size < options.concurrency && waiting.length > 0) {
      const entry = waiting.shift()!;
      active.add(entry);
      void run(entry).finally(() => {
        active.delete(entry);
        pump();
      });
    }
  }

  return {
    push(request) {
      waiting.push({ request, abort: new AbortController() });
      pump();
    },
    cancelAll() {
      for (const entry of active) entry.abort.abort();
      waiting.length = 0;
    },
  };
}
