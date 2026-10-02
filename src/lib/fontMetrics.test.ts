import { describe, expect, it, vi } from "vitest";
import type { LightBlock } from "@/types";
import { FONT_METRICS_PREVIEW_MAX_CHARS } from "@/types/fontMetrics";
import {
  createFontMetricsCacheIdentity,
  deriveFontMetricsHash,
  FIRST_MEASURED_BLOCKS,
  getFontHash,
  measureTopFirst,
} from "./fontMetrics";
import type { WordWidths, WorkerInMessage, WorkerOutMessage } from "@/types/fontMetrics";

function makeBlock(overrides: Partial<LightBlock> = {}): LightBlock {
  return {
    id: 1,
    slug: "test-block",
    card_kind: "article",
    block_type: "article",
    title: "Original title",
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    width: null,
    height: null,
    author: null,
    body: "Original body text",
    preview_text: null,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    collections: [],
    feed_playback: null,
    ...overrides,
  };
}

describe("createFontMetricsCacheIdentity", () => {
  it("is stable for the same measured text and font version", () => {
    const a = createFontMetricsCacheIdentity(makeBlock());
    const b = createFontMetricsCacheIdentity(makeBlock());

    expect(a).toEqual(b);
    expect(a.fontHash).toBe(getFontHash());
  });

  it("changes when the same block id receives different layout text", () => {
    const before = createFontMetricsCacheIdentity(makeBlock({ id: 42, title: "Alpha" }));
    const after = createFontMetricsCacheIdentity(makeBlock({ id: 42, title: "Beta" }));

    expect(after.blockId).toBe(before.blockId);
    expect(after.cacheKey).not.toBe(before.cacheKey);
    expect(after.textHash).not.toBe(before.textHash);
  });

  it("uses prepared preview text when present", () => {
    const fromBody = createFontMetricsCacheIdentity(makeBlock({
      body: "Long markdown body",
      preview_text: "Indexer preview",
    }));
    const samePreviewDifferentBody = createFontMetricsCacheIdentity(makeBlock({
      body: "Changed markdown body",
      preview_text: "Indexer preview",
    }));

    expect(samePreviewDifferentBody.cacheKey).toBe(fromBody.cacheKey);
    expect(fromBody.preview).toBe("Indexer preview");
  });

  it("hashes only the preview prefix measured by the worker", () => {
    const prefix = "a".repeat(FONT_METRICS_PREVIEW_MAX_CHARS);
    const first = createFontMetricsCacheIdentity(makeBlock({
      preview_text: `${prefix} first suffix`,
    }));
    const second = createFontMetricsCacheIdentity(makeBlock({
      preview_text: `${prefix} second suffix`,
    }));

    expect(first.cacheKey).toBe(second.cacheKey);
    expect(first.preview).toHaveLength(FONT_METRICS_PREVIEW_MAX_CHARS);
  });

  it("does not invalidate metrics for fields that do not affect measured text", () => {
    const first = createFontMetricsCacheIdentity(makeBlock({
      width: 100,
      height: 200,
    }));
    const second = createFontMetricsCacheIdentity(makeBlock({
      width: 300,
      height: 400,
    }));

    expect(second.cacheKey).toBe(first.cacheKey);
  });
});

describe("measuring a newly opened space", () => {
  const blocks = Array.from({ length: 130 }, (_, index) => makeBlock({ id: index + 1, slug: `b-${index + 1}` }));
  const widthsFor = (batch: LightBlock[]) =>
    new Map(batch.map((block) => [block.id, {} as unknown as WordWidths]));

  it("publishes the top of the feed before the rest is measured", async () => {
    let finishRest: (() => void) | undefined;
    const calls: number[][] = [];
    const published: number[] = [];
    const fetch = (batch: LightBlock[]) => {
      calls.push(batch.map((block) => block.id));
      if (calls.length === 1) return Promise.resolve(widthsFor(batch));
      return new Promise<Map<number, WordWidths>>((resolve) => { finishRest = () => resolve(widthsFor(batch)); });
    };
    const done = measureTopFirst(blocks, fetch, (computed) => published.push(computed.size), () => false);
    await vi.waitFor(() => expect(finishRest).toBeDefined());
    expect(calls[0]).toEqual(blocks.slice(0, FIRST_MEASURED_BLOCKS).map((block) => block.id));
    expect(published).toEqual([FIRST_MEASURED_BLOCKS]);
    finishRest?.();
    await done;
    expect(published).toEqual([FIRST_MEASURED_BLOCKS, blocks.length - FIRST_MEASURED_BLOCKS]);
  });

  it("stops after the top when the feed moved on", async () => {
    const calls: number[] = [];
    await measureTopFirst(
      blocks,
      async (batch) => { calls.push(batch.length); return widthsFor(batch); },
      () => undefined,
      () => true,
    );
    expect(calls).toEqual([FIRST_MEASURED_BLOCKS]);
  });
});

describe("a font-metrics worker that never answers (А8.1)", () => {
  function installSilentWorker() {
    vi.useFakeTimers();
    vi.resetModules();
    const terminate = vi.fn();
    class SilentWorker {
      addEventListener() {}
      postMessage() {}
      terminate = terminate;
    }
    vi.stubGlobal("Worker", SilentWorker);
    vi.stubGlobal("OffscreenCanvas", class {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    return { terminate };
  }

  function restoreGlobals() {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }

  it("measures the cards on the page once the worker has had its time", async () => {
    const { terminate } = installSilentWorker();
    try {
      const { fetchWordWidths, WORKER_INIT_TIMEOUT_MS } = await import("./fontMetrics");
      const measuring = fetchWordWidths([makeBlock({ id: 7, title: "Two words", body: "Some preview" })]);
      await vi.advanceTimersByTimeAsync(WORKER_INIT_TIMEOUT_MS + 1);
      const widths = await measuring;
      // The test canvas measures 7.5 px per character.
      expect(widths.get(7)?.title).toEqual([22.5, 37.5]);
      expect(terminate).toHaveBeenCalled();
    } finally {
      restoreGlobals();
    }
  });

  it("releases a second measurement that waits for the same start (Б5.1)", async () => {
    installSilentWorker();
    try {
      const { fetchWordWidths, WORKER_INIT_TIMEOUT_MS } = await import("./fontMetrics");
      const settled: number[] = [];
      const first = fetchWordWidths([makeBlock({ id: 1, title: "First card" })]);
      void first.then(() => settled.push(1));
      // The feed moves on (a collection switch) while the worker still starts.
      await vi.advanceTimersByTimeAsync(WORKER_INIT_TIMEOUT_MS / 2);
      const second = fetchWordWidths([makeBlock({ id: 2, title: "Second card" })]);
      void second.then(() => settled.push(2));

      await vi.advanceTimersByTimeAsync(WORKER_INIT_TIMEOUT_MS / 2 + 1);
      // Both measure on the page: the second is not left waiting for a
      // `ready` the stopped worker never sends.
      expect(settled.sort()).toEqual([1, 2]);
      // The test canvas measures 7.5 px per character.
      expect((await second).get(2)?.title).toEqual([45, 30]);

      // A later measurement does not wait for the worker again.
      let thirdDone = false;
      const third = fetchWordWidths([makeBlock({ id: 3, title: "Third card" })]);
      void third.then(() => { thirdDone = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(thirdDone).toBe(true);
      expect((await third).get(3)?.title).toEqual([37.5, 30]);
    } finally {
      restoreGlobals();
    }
  });
});

describe("card titles are measured with the weight they are painted with (01.10.2026)", () => {
  /// A card title differs from its text by color alone: regular weight.
  const REGULAR_WEIGHT = 400;
  const REGULAR_SPEC = "400 12px 'Geist', system-ui, sans-serif";
  const SEMIBOLD_SPEC = "600 12px 'Geist', system-ui, sans-serif";
  /// The identity every width measured with the semibold title font was
  /// stored under. Semibold words are wider than regular ones: such a width
  /// must never size a regular title.
  const SEMIBOLD_TITLE_FONT_HASH = "descriptor-preview-v2-geist";

  const weightOf = (fontSpec: string) => Number(fontSpec.split(" ")[0]);
  const emptyWidths: WordWidths = {
    title: [],
    preview: [],
    titleSpace: 0,
    previewSpace: 0,
    titleNoSpaceBefore: [],
    previewNoSpaceBefore: [],
  };

  function stubFontFetch() {
    vi.stubGlobal("OffscreenCanvas", class {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })));
  }

  function restoreGlobals() {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }

  it("sends the worker the regular title font and a cache hash that names it", async () => {
    vi.resetModules();
    type Listener = (event: { data: WorkerOutMessage }) => void;
    const computeMessages: Array<Extract<WorkerInMessage, { type: "compute" }>> = [];
    class AnsweringWorker {
      private listeners: Listener[] = [];
      addEventListener(type: string, listener: Listener) {
        if (type === "message") this.listeners.push(listener);
      }
      removeEventListener(type: string, listener: Listener) {
        this.listeners = this.listeners.filter((candidate) => candidate !== listener);
      }
      postMessage(message: WorkerInMessage) {
        const reply = (data: WorkerOutMessage) => queueMicrotask(() => {
          for (const listener of [...this.listeners]) listener({ data });
        });
        if (message.type === "init") {
          reply({ type: "ready", requestId: message.requestId });
          return;
        }
        computeMessages.push(message);
        reply({
          type: "result",
          requestId: message.requestId,
          results: message.blocks.map((input) => ({ id: input.id, widths: emptyWidths })),
          fontHash: message.fontHash,
        });
      }
      terminate() {}
    }
    vi.stubGlobal("Worker", AnsweringWorker);
    stubFontFetch();
    try {
      const fresh = await import("./fontMetrics");
      await fresh.fetchWordWidths([makeBlock({ id: 9, title: "Headline" })]);

      expect(computeMessages).toHaveLength(1);
      const compute = computeMessages[0]!;
      expect(weightOf(compute.titleFontSpec)).toBe(REGULAR_WEIGHT);
      expect(compute.titleFontSpec).toBe(compute.previewFontSpec);
      expect(compute.fontHash).toBe(fresh.getFontHash());
      expect(compute.fontHash).toBe(
        fresh.deriveFontMetricsHash(compute.titleFontSpec, compute.previewFontSpec),
      );
    } finally {
      restoreGlobals();
    }
  });

  it("measures titles on the page with the regular weight, like the text under them", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal("Worker", class {
      addEventListener() {}
      postMessage() {}
      terminate() {}
    });
    stubFontFetch();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fontByWord = new Map<string, string>();
    const recordingContext = {
      font: "",
      measureText(text: string) {
        fontByWord.set(text, this.font);
        return { width: text.length * 7.5 };
      },
    };
    const getContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => recordingContext,
    });
    try {
      const { fetchWordWidths, WORKER_INIT_TIMEOUT_MS } = await import("./fontMetrics");
      const measuring = fetchWordWidths([
        makeBlock({ id: 7, title: "Headline", body: "paragraph", preview_text: "paragraph" }),
      ]);
      await vi.advanceTimersByTimeAsync(WORKER_INIT_TIMEOUT_MS + 1);
      expect((await measuring).get(7)?.title).toEqual([60]);

      const titleFont = fontByWord.get("Headline");
      expect(titleFont).toBeDefined();
      expect(weightOf(titleFont ?? "")).toBe(REGULAR_WEIGHT);
      expect(titleFont).toBe(fontByWord.get("paragraph"));
    } finally {
      if (getContext) {
        Object.defineProperty(HTMLCanvasElement.prototype, "getContext", getContext);
      }
      restoreGlobals();
    }
  });

  it("never reads back widths measured with the semibold title font", () => {
    const identity = createFontMetricsCacheIdentity(makeBlock({ id: 42 }));

    expect(identity.fontHash).not.toBe(SEMIBOLD_TITLE_FONT_HASH);
    expect(identity.cacheKey).not.toContain(`:${SEMIBOLD_TITLE_FONT_HASH}:`);
    // The hash names the measured weight: measuring titles semibold again
    // would open a different cache, not hit a stale one.
    expect(getFontHash()).toBe(deriveFontMetricsHash(REGULAR_SPEC, REGULAR_SPEC));
    expect(deriveFontMetricsHash(SEMIBOLD_SPEC, REGULAR_SPEC)).not.toBe(getFontHash());
  });
});

