// DecodeQueue — a concurrency-limited FIFO for main-thread media decodes.
//
// The image thumbnail path runs off-main-thread inside a Web Worker with
// its own MAX_CONCURRENCY. Video frame extraction, by contrast, has to run
// on the main thread — a `<video>` element is unavailable inside a
// Dedicated Worker on WKWebView. Without a governor, a startup backlog of
// videos fires every decode at once, floods the browser's media-decoder
// pool, and the tail starves out on timeouts.
//
// DecodeQueue is that governor. It bounds parallelism, deduplicates work by
// key so the startup backlog drain and live watcher events never queue the
// same target twice, and retries a failed key once after a backoff before
// giving up for the session.
//
// It is deliberately generic: a task is just `() => Promise<void>` keyed by
// an opaque string, so the same primitive serves both block-thumb and
// tile-poster decodes. See SPEC_THUMBNAILS.md#concurrency.

export interface DecodeQueueOptions {
  /** Maximum number of tasks running concurrently. */
  concurrency: number;
  /** Delay before the single in-session retry of a failed key, in ms. */
  retryDelayMs: number;
  /** Retries allowed per key per session, beyond the first attempt. */
  maxRetries: number;
  /** Called when a key fails and no retries remain. */
  onGaveUp?: (key: string, error: unknown) => void;
}

export type DecodeTask = () => Promise<void>;

type TimerHandle = ReturnType<typeof setTimeout>;

interface Entry {
  key: string;
  task: DecodeTask;
  /** How many times the task has been started, including retries. */
  attempts: number;
}

export class DecodeQueue {
  private readonly concurrency: number;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;
  private readonly onGaveUp?: (key: string, error: unknown) => void;

  private readonly waiting: Entry[] = [];
  private readonly active = new Map<string, Entry>();
  /** Keys that are queued, running, or waiting on a retry backoff. */
  private readonly known = new Set<string>();
  private readonly retryTimers = new Map<string, TimerHandle>();
  private disposed = false;

  constructor(options: DecodeQueueOptions) {
    this.concurrency = Math.max(1, options.concurrency);
    this.retryDelayMs = options.retryDelayMs;
    this.maxRetries = options.maxRetries;
    this.onGaveUp = options.onGaveUp;
  }

  /**
   * Enqueue `task` under `key`. No-op if `key` is already queued, running,
   * or waiting on a retry backoff. Returns `true` if newly enqueued.
   */
  enqueue(key: string, task: DecodeTask): boolean {
    if (this.disposed || this.known.has(key)) return false;
    this.known.add(key);
    this.waiting.push({ key, task, attempts: 0 });
    this.pump();
    return true;
  }

  /** Whether `key` is queued, running, or awaiting a retry. */
  has(key: string): boolean {
    return this.known.has(key);
  }

  /** Tasks waiting for a free slot. */
  get size(): number {
    return this.waiting.length;
  }

  /** Tasks currently running. */
  get activeCount(): number {
    return this.active.size;
  }

  /** Cancel pending retries and drop all state. Safe to call more than once. */
  dispose(): void {
    this.disposed = true;
    this.waiting.length = 0;
    this.active.clear();
    this.known.clear();
    for (const handle of this.retryTimers.values()) {
      clearTimeout(handle);
    }
    this.retryTimers.clear();
  }

  private pump(): void {
    if (this.disposed) return;
    while (this.active.size < this.concurrency && this.waiting.length > 0) {
      const entry = this.waiting.shift();
      if (!entry) break;
      this.active.set(entry.key, entry);
      void this.run(entry);
    }
  }

  private async run(entry: Entry): Promise<void> {
    entry.attempts += 1;
    try {
      await entry.task();
      if (this.disposed) return;
      this.settle(entry.key);
    } catch (error) {
      if (this.disposed) return;
      this.active.delete(entry.key);
      if (entry.attempts <= this.maxRetries) {
        this.scheduleRetry(entry);
      } else {
        this.known.delete(entry.key);
        this.onGaveUp?.(entry.key, error);
      }
      this.pump();
    }
  }

  private settle(key: string): void {
    this.active.delete(key);
    this.known.delete(key);
    this.pump();
  }

  private scheduleRetry(entry: Entry): void {
    // `entry.key` stays in `known` for the whole backoff window, so a
    // duplicate enqueue arriving before the retry runs is ignored.
    const handle = setTimeout(() => {
      this.retryTimers.delete(entry.key);
      if (this.disposed || !this.known.has(entry.key)) return;
      this.waiting.push(entry);
      this.pump();
    }, this.retryDelayMs);
    this.retryTimers.set(entry.key, handle);
  }
}
