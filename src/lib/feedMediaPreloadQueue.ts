import type { FeedMediaCandidateRole } from "@/lib/feedMediaCandidates";

export interface FeedMediaPreloadCandidate {
  url: string;
  role: FeedMediaCandidateRole;
  distancePx: number;
  visualIndex: number;
}

export interface FeedMediaPreloadInput {
  generation: string;
  candidates: readonly FeedMediaPreloadCandidate[];
  skippedNoPreview?: number;
}

export interface FeedMediaPreloadStats {
  queued: number;
  active: number;
  decoded: number;
  failed: number;
  skippedLru: number;
  skippedNoPreview: number;
  generation: string;
}

export interface FeedMediaPreloadQueueLimits {
  maxConcurrency: number;
  cacheLimit: number;
  queueLimit: number;
  decodeTimeoutMs: number;
}

export const DEFAULT_FEED_MEDIA_PRELOAD_LIMITS: FeedMediaPreloadQueueLimits = {
  maxConcurrency: 4,
  cacheLimit: 400,
  queueLimit: 160,
  decodeTimeoutMs: 3000,
};

export type DecodeImage = (url: string) => Promise<void>;

interface QueuedCandidate extends FeedMediaPreloadCandidate {
  generation: string;
}

function roleRank(role: FeedMediaCandidateRole): number {
  switch (role) {
    case "poster-preview":
    case "primary-preview":
      return 0;
    case "tile-preview":
      return 1;
  }
}

function compareCandidates(
  first: FeedMediaPreloadCandidate,
  second: FeedMediaPreloadCandidate,
): number {
  const distance = first.distancePx - second.distancePx;
  if (distance !== 0) return distance;
  const role = roleRank(first.role) - roleRank(second.role);
  if (role !== 0) return role;
  return first.visualIndex - second.visualIndex;
}

function imageLoadedOrErrored(image: HTMLImageElement): Promise<void> {
  return new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Image preload failed"));
  });
}

function decodeBrowserImage(url: string): Promise<void> {
  if (typeof Image === "undefined") {
    return Promise.resolve();
  }

  const image = new Image();
  image.decoding = "async";
  const loaded = imageLoadedOrErrored(image);
  image.src = url;
  return image.decode ? image.decode() : loaded;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof window.setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(
      () => reject(new Error("Image preload timed out")),
      ms,
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}

export class FeedMediaPreloadQueue {
  private readonly limits: FeedMediaPreloadQueueLimits;
  private readonly decodeImage: DecodeImage;
  private generation = "";
  private queue: QueuedCandidate[] = [];
  private active = new Map<string, string>();
  private decoded = new Map<string, true>();
  private failed = new Set<string>();
  private disposed = false;
  private skippedLru = 0;
  private skippedNoPreview = 0;

  constructor({
    limits = DEFAULT_FEED_MEDIA_PRELOAD_LIMITS,
    decodeImage = decodeBrowserImage,
  }: {
    limits?: Partial<FeedMediaPreloadQueueLimits>;
    decodeImage?: DecodeImage;
  } = {}) {
    this.limits = {
      ...DEFAULT_FEED_MEDIA_PRELOAD_LIMITS,
      ...limits,
    };
    this.decodeImage = decodeImage;
  }

  update(input: FeedMediaPreloadInput): FeedMediaPreloadStats {
    if (this.disposed) return this.stats();
    if (input.generation !== this.generation) {
      this.reset(input.generation);
    }

    this.skippedLru = 0;
    this.skippedNoPreview = input.skippedNoPreview ?? 0;

    const queuedUrls = new Set(this.queue.map((candidate) => candidate.url));
    const incoming = [...input.candidates].sort(compareCandidates);
    const seenIncoming = new Set<string>();

    for (const candidate of incoming) {
      if (seenIncoming.has(candidate.url)) continue;
      seenIncoming.add(candidate.url);

      if (this.decoded.has(candidate.url)) {
        this.touchDecoded(candidate.url);
        this.skippedLru += 1;
        continue;
      }
      if (
        this.failed.has(candidate.url) ||
        this.active.has(candidate.url) ||
        queuedUrls.has(candidate.url)
      ) {
        continue;
      }

      this.queue.push({ ...candidate, generation: this.generation });
      queuedUrls.add(candidate.url);
    }

    this.queue.sort(compareCandidates);
    if (this.queue.length > this.limits.queueLimit) {
      this.queue = this.queue.slice(0, this.limits.queueLimit);
    }

    this.pump();
    return this.stats();
  }

  reset(generation: string): void {
    this.generation = generation;
    this.queue = [];
    this.active.clear();
    this.failed.clear();
    this.skippedLru = 0;
    this.skippedNoPreview = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.active.clear();
    this.failed.clear();
    this.decoded.clear();
  }

  stats(): FeedMediaPreloadStats {
    return {
      queued: this.queue.length,
      active: this.active.size,
      decoded: this.decoded.size,
      failed: this.failed.size,
      skippedLru: this.skippedLru,
      skippedNoPreview: this.skippedNoPreview,
      generation: this.generation,
    };
  }

  private pump(): void {
    if (this.disposed) return;
    while (
      this.active.size < this.limits.maxConcurrency &&
      this.queue.length > 0
    ) {
      const candidate = this.queue.shift();
      if (!candidate) return;
      if (this.decoded.has(candidate.url) || this.failed.has(candidate.url)) {
        continue;
      }
      this.active.set(candidate.url, candidate.generation);
      void this.run(candidate);
    }
  }

  private async run(candidate: QueuedCandidate): Promise<void> {
    try {
      await withTimeout(
        this.decodeImage(candidate.url),
        this.limits.decodeTimeoutMs,
      );
      if (this.active.get(candidate.url) === candidate.generation) {
        this.rememberDecoded(candidate.url);
      }
    } catch {
      if (this.active.get(candidate.url) === candidate.generation) {
        this.failed.add(candidate.url);
      }
    } finally {
      if (this.active.get(candidate.url) === candidate.generation) {
        this.active.delete(candidate.url);
        this.pump();
      }
    }
  }

  private rememberDecoded(url: string): void {
    this.touchDecoded(url);
    while (this.decoded.size > this.limits.cacheLimit) {
      const oldest = this.decoded.keys().next().value as string | undefined;
      if (!oldest) return;
      this.decoded.delete(oldest);
    }
  }

  private touchDecoded(url: string): void {
    if (this.decoded.has(url)) {
      this.decoded.delete(url);
    }
    this.decoded.set(url, true);
  }
}
