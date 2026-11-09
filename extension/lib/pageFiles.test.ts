import { describe, expect, it, vi } from "vitest";

import "./browserFile.js";
import "./pageFiles.js";
import type { BrowserFileEntry, FileAnswer, PageFile, PageFilePlan, PageFileWork } from "./pageFiles.types";
import type { PageFileAnswer } from "./browserFile.types";

const { createLimiter, requestFile, collect, withoutFragment, hostOf, IDLE_MS } = globalThis.MinePageFiles;

// SPEC_CLIPPER.md, «Один путь файла со страницы», Б4 to Б6, Б11.

function fileAt(url: string, more: Partial<PageFile> = {}): PageFile {
  return { url, referer: "https://shop.example/", cookies: false, reachable: true, poster_of: null, ...more } as PageFile;
}

function planOf(...files: PageFile[]): PageFilePlan {
  return { parallel: 3, per_domain: 2, files };
}

const file = (source: FileAnswer["source"], finalUrl = ""): FileAnswer => ({ kind: "file", blob: new Blob(["bytes"]), source, finalUrl });

interface Scene {
  page?: Record<string, { cache?: PageFileAnswer | FileAnswer; request?: PageFileAnswer | FileAnswer }>;
  outside?: Record<string, PageFileAnswer | FileAnswer>;
  stored?: (url: string) => string | null;
}

/** A collection over answers that are known in advance, recording who was asked. */
function workOf(scene: Scene, signal = new AbortController().signal) {
  const asked: string[] = [];
  const work: PageFileWork = {
    signal,
    limiter: createLimiter(),
    pageRead: async (url, mode) => {
      asked.push(`${mode} ${url}`);
      const on = scene.page?.[url];
      if (!on) return { kind: "elsewhere" };
      return on[mode] ?? { kind: "miss" };
    },
    request: async (planned) => {
      asked.push(`outside ${planned.url}`);
      return scene.outside?.[planned.url] ?? { kind: "failure", failure: "no_answer" };
    },
    store: async (_blob, url) => (scene.stored ? scene.stored(url) : `upload-of-${url}`),
  };
  return { work, asked };
}

const CACHED = "https://shop.example/cached.jpg";
const BELOW = "https://shop.example/below.jpg";
const OTHER = "https://cdn.example/other.jpg";

describe("collect", () => {
  it("takes a file from the cache without a request", async () => {
    const { work, asked } = workOf({ page: { [CACHED]: { cache: file("cache") } } });
    const entries = await collect(planOf(fileAt(CACHED)), work);
    expect(entries).toEqual([{ url: CACHED, upload_id: `upload-of-${CACHED}`, source: "cache" }]);
    expect(asked).toEqual([`cache ${CACHED}`]);
  });

  it("gives a file of the page's origin one request of the page", async () => {
    const { work, asked } = workOf({ page: { [BELOW]: { request: file("page", BELOW) } } });
    const entries = await collect(planOf(fileAt(BELOW)), work);
    expect(entries).toEqual([{ url: BELOW, upload_id: `upload-of-${BELOW}`, source: "page" }]);
    expect(asked).toEqual([`cache ${BELOW}`, `request ${BELOW}`]);
  });

  it("gives a file of another domain one request from outside, and says where it ended", async () => {
    const { work, asked } = workOf({ outside: { [OTHER]: file("browser", "https://cdn.example/final.jpg") } });
    const entries = await collect(planOf(fileAt(OTHER)), work);
    expect(entries).toEqual([{ url: OTHER, upload_id: `upload-of-${OTHER}`, source: "browser", final_url: "https://cdn.example/final.jpg" }]);
    expect(asked).toEqual([`cache ${OTHER}`, `outside ${OTHER}`]);
  });

  it("asks from outside when the browser refused the page's request", async () => {
    const { work, asked } = workOf({
      page: { [BELOW]: { request: { kind: "refused" } } },
      outside: { [BELOW]: file("browser", "https://cdn.example/moved.jpg") },
    });
    const askedOutside: PageFile[] = [];
    const request = work.request;
    work.request = async (planned) => {
      askedOutside.push(planned);
      return request(planned);
    };
    const entries = await collect(planOf(fileAt(BELOW, { cookies: true })), work);
    expect(entries[0]).toMatchObject({ upload_id: `upload-of-${BELOW}`, source: "browser" });
    expect(asked).toEqual([`cache ${BELOW}`, `request ${BELOW}`, `outside ${BELOW}`]);
    expect(askedOutside[0]?.cookies).toBe(false);
  });

  it("does not ask from outside for an address the helper says leads inside; the page may", async () => {
    const internal = "http://nas.local/own.jpg";
    const { work, asked } = workOf({ page: { [internal]: { request: file("page") } } });
    const entries = await collect(planOf(fileAt(internal, { reachable: false }), fileAt("http://10.0.0.5/a.jpg", { reachable: false })), work);
    expect(entries).toEqual([{ url: internal, upload_id: `upload-of-${internal}`, source: "page" }]);
    expect(asked).not.toContain("outside http://10.0.0.5/a.jpg");
  });

  it("reports what the site refused with, and a 429 closes its host for the next files", async () => {
    const limited = "https://cdn.example/limited.jpg";
    const next = "https://cdn.example/next.jpg";
    const third = "https://cdn.example/third.jpg";
    const { work, asked } = workOf({
      outside: { [limited]: { kind: "status", status: 429, retryAfter: 600 } },
      page: { [third]: { cache: file("cache") } },
    });
    // One at a time, so that the order of this test is the order of the answers.
    const entries = await collect({ parallel: 1, per_domain: 1, files: [fileAt(limited), fileAt(next), fileAt(third)] }, work);
    expect(entries).toEqual([
      { url: limited, status: 429, retry_after: 600 },
      { url: next, failure: "host_limited", retry_after: 600 },
      { url: third, upload_id: `upload-of-${third}`, source: "cache" },
    ]);
    expect(asked).not.toContain(`outside ${next}`);
  });

  it("keeps a closed host closed without a wait the site named", async () => {
    const limited = "https://cdn.example/limited.jpg";
    const next = "https://cdn.example/next.jpg";
    const { work } = workOf({ outside: { [limited]: { kind: "status", status: 429, retryAfter: null } } });
    const entries = await collect({ parallel: 1, per_domain: 1, files: [fileAt(limited), fileAt(next)] }, work);
    expect(entries).toEqual([{ url: limited, status: 429 }, { url: next, failure: "host_limited" }]);
  });

  // SPEC_CLIPPER.md, Б13: a browser folder has no helper to take over.
  describe("with pauses before further requests", () => {
    const SLOW = "https://cdn.example/slow.jpg";
    const retried = (scene: Scene, signal?: AbortSignal) => {
      const made = workOf(scene, signal);
      made.work.retryPausesMs = [500, 1_000];
      return made;
    };
    /** The outside requests one after another, then the same answer. */
    const answersInTurn = (work: PageFileWork, answers: Array<PageFileAnswer | FileAnswer>, times: number[] = []) => {
      let turn = 0;
      work.request = vi.fn(async () => {
        times.push(Date.now());
        const answer = answers[Math.min(turn, answers.length - 1)];
        turn += 1;
        return answer as PageFileAnswer | FileAnswer;
      });
      return work.request;
    };

    it("asks up to three times, 500 ms and 1 s apart, like the helper", async () => {
      vi.useFakeTimers();
      try {
        const { work } = retried({});
        const times: number[] = [];
        const request = answersInTurn(work, [{ kind: "status", status: 503, retryAfter: null }], times);
        const entries = collect(planOf(fileAt(SLOW)), work);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(await entries).toEqual([{ url: SLOW, status: 503 }]);
        expect(request).toHaveBeenCalledTimes(3);
        expect(times.map((time, index) => (index === 0 ? 0 : time - (times[index - 1] as number)))).toEqual([0, 500, 1_000]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops asking as soon as the file comes", async () => {
      vi.useFakeTimers();
      try {
        const { work } = retried({});
        const request = answersInTurn(work, [{ kind: "failure", failure: "no_answer" }, file("browser", SLOW)]);
        const entries = collect(planOf(fileAt(SLOW)), work);
        await vi.advanceTimersByTimeAsync(600);
        expect(await entries).toEqual([{ url: SLOW, upload_id: `upload-of-${SLOW}`, source: "browser", final_url: SLOW }]);
        expect(request).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each<[string, PageFileAnswer | FileAnswer]>([
      ["a refusal of another code", { kind: "status", status: 403, retryAfter: null }],
      ["a 429", { kind: "status", status: 429, retryAfter: 60 }],
      ["a web page", { kind: "failure", failure: "not_a_file" }],
      ["a file too large", { kind: "failure", failure: "too_large" }],
    ])("does not ask again after %s", async (_case, answer) => {
      const { work } = retried({});
      const request = answersInTurn(work, [answer]);
      await collect(planOf(fileAt(SLOW)), work);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it("counts the page's refused request among the three", async () => {
      vi.useFakeTimers();
      try {
        const { work, asked } = retried({ page: { [BELOW]: { request: { kind: "refused" } } } });
        const request = answersInTurn(work, [{ kind: "failure", failure: "no_answer" }]);
        const entries = collect(planOf(fileAt(BELOW, { cookies: true })), work);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(await entries).toEqual([{ url: BELOW, failure: "no_answer" }]);
        expect(asked.filter((entry) => entry === `request ${BELOW}`)).toHaveLength(1);
        expect(request).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("asks the page again after its own failure", async () => {
      vi.useFakeTimers();
      try {
        const { work, asked } = retried({ page: { [BELOW]: { request: { kind: "status", status: 500, retryAfter: null } } } });
        const entries = collect(planOf(fileAt(BELOW)), work);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(await entries).toEqual([{ url: BELOW, status: 500 }]);
        expect(asked.filter((entry) => entry === `request ${BELOW}`)).toHaveLength(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not ask again once the clipper is gone", async () => {
      const controller = new AbortController();
      const { work } = retried({}, controller.signal);
      const request = answersInTurn(work, [{ kind: "failure", failure: "no_answer" }]);
      const entries = collect(planOf(fileAt(SLOW)), work);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      controller.abort();
      expect(await entries).toEqual([]);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it("does not ask again a host another file closed meanwhile", async () => {
      vi.useFakeTimers();
      try {
        const closing = "https://cdn.example/closing.jpg";
        const { work } = retried({});
        work.request = vi.fn(async (planned: PageFile) => (planned.url === closing
          ? { kind: "status", status: 429, retryAfter: 60 } as const
          : { kind: "failure", failure: "no_answer" } as const));
        const entries = collect(planOf(fileAt(SLOW), fileAt(closing)), work);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(await entries).toEqual([
          { url: SLOW, failure: "host_limited", retry_after: 60 },
          { url: closing, status: 429, retry_after: 60 },
        ]);
        expect(work.request).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("makes one request of a file without pauses, as with the helper, which takes over", async () => {
    const slow = "https://cdn.example/slow.jpg";
    const { work, asked } = workOf({ outside: { [slow]: { kind: "status", status: 503, retryAfter: null } } });
    expect(await collect(planOf(fileAt(slow)), work)).toEqual([{ url: slow, status: 503 }]);
    expect(asked.filter((entry) => entry === `outside ${slow}`)).toHaveLength(1);
  });

  it("says when the storage refused the bytes", async () => {
    const { work } = workOf({ page: { [CACHED]: { cache: file("cache") } } });
    work.store = async () => { throw new DOMException("the disk is full", "QuotaExceededError"); };
    expect(await collect(planOf(fileAt(CACHED)), work)).toEqual([{ url: CACHED, failure: "not_stored" }]);
  });

  it("reports the failures of a request", async () => {
    const page = "https://cdn.example/page.jpg";
    const large = "https://cdn.example/large.mp4";
    const silent = "https://other.example/silent.jpg";
    const gone = "https://other.example/gone.jpg";
    const { work } = workOf({
      outside: {
        [page]: { kind: "failure", failure: "not_a_file" },
        [large]: { kind: "failure", failure: "too_large" },
        [silent]: { kind: "failure", failure: "no_answer" },
        [gone]: { kind: "status", status: 404, retryAfter: null },
      },
    });
    expect(await collect(planOf(fileAt(page), fileAt(large), fileAt(silent), fileAt(gone)), work)).toEqual([
      { url: page, failure: "not_a_file" },
      { url: large, failure: "too_large" },
      { url: silent, failure: "no_answer" },
      { url: gone, status: 404 },
    ]);
  });

  it("asks for a poster only when the browser did not get its video", async () => {
    const got = "https://cdn.example/got.mp4";
    const gotPoster = "https://cdn.example/got.jpg";
    const failed = "https://cdn.example/failed.mp4";
    const failedPoster = "https://cdn.example/failed.jpg";
    const { work, asked } = workOf({
      outside: { [got]: file("browser", got), [failed]: { kind: "failure", failure: "too_large" }, [failedPoster]: file("browser", failedPoster) },
    });
    const entries = await collect(planOf(
      fileAt(got), fileAt(gotPoster, { poster_of: got }),
      fileAt(failed), fileAt(failedPoster, { poster_of: failed }),
    ), work);
    expect(entries.map((entry) => entry.url)).toEqual([got, failed, failedPoster]);
    expect(asked).not.toContain(`outside ${gotPoster}`);
  });

  it("turns an upload the server refused into a file the helper downloads", async () => {
    const { work } = workOf({ page: { [CACHED]: { cache: file("cache") } }, stored: () => null });
    expect(await collect(planOf(fileAt(CACHED)), work)).toEqual([{ url: CACHED, failure: "no_answer" }]);
  });

  it("stops asking the page after it fell silent over its cache", async () => {
    const second = "https://shop.example/second.jpg";
    const { work, asked } = workOf({
      page: { [CACHED]: { cache: { kind: "stalled" } } },
      outside: { [CACHED]: file("browser"), [second]: file("browser") },
    });
    await collect(planOf(fileAt(CACHED), fileAt(second)), work);
    expect(asked).not.toContain(`cache ${second}`);
    expect(asked).toContain(`outside ${second}`);
  });

  it("stops when the clipper closes", async () => {
    const controller = new AbortController();
    const { work, asked } = workOf({ page: { [CACHED]: { cache: file("cache") } } }, controller.signal);
    controller.abort();
    expect(await collect(planOf(fileAt(CACHED)), work)).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("keeps to the limits of the plan: three requests in all and two per host", async () => {
    const urls = ["a", "b", "c", "d"].map((name) => `https://cdn.example/${name}.jpg`)
      .concat(["e", "f"].map((name) => `https://other.example/${name}.jpg`));
    let running = 0;
    let most = 0;
    const perHost = new Map<string, number>();
    let mostPerHost = 0;
    const { work } = workOf({});
    work.request = async (planned) => {
      const host = hostOf(planned.url);
      running += 1;
      perHost.set(host, (perHost.get(host) ?? 0) + 1);
      most = Math.max(most, running);
      mostPerHost = Math.max(mostPerHost, perHost.get(host) ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      perHost.set(host, (perHost.get(host) ?? 0) - 1);
      return file("browser", planned.url);
    };
    const entries: BrowserFileEntry[] = await collect(planOf(...urls.map((url) => fileAt(url))), work);
    expect(entries).toHaveLength(urls.length);
    expect(most).toBe(3);
    expect(mostPerHost).toBe(2);
  });
});

describe("createLimiter", () => {
  it("shares the limits between two collections", async () => {
    const limiter = createLimiter();
    const signal = new AbortController().signal;
    const one = await limiter.acquire("a", 2, 2, signal);
    await limiter.acquire("a", 2, 2, signal);
    let third = false;
    const waiting = limiter.acquire("b", 2, 2, signal).then((release) => {
      third = true;
      return release;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    one();
    await waiting;
    expect(third).toBe(true);
  });

  it("lets a waiting request leave when its collection closes", async () => {
    const limiter = createLimiter();
    const controller = new AbortController();
    await limiter.acquire("a", 1, 1, new AbortController().signal);
    const waiting = limiter.acquire("a", 1, 1, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow("aborted");
  });

  it("gives a place back once", async () => {
    const limiter = createLimiter();
    const signal = new AbortController().signal;
    const release = await limiter.acquire("a", 1, 1, signal);
    release();
    release();
    const second = await limiter.acquire("a", 1, 1, signal);
    let third = false;
    void limiter.acquire("a", 1, 1, signal).then(() => { third = true; });
    await Promise.resolve();
    expect(third).toBe(false);
    second();
  });
});

function responseOf(body: Uint8Array[] | null, init: { status?: number; type?: string; length?: string; retryAfter?: string; url?: string } = {}) {
  const headers = new Headers({ "content-type": init.type ?? "image/jpeg" });
  if (init.length !== undefined) headers.set("content-length", init.length);
  if (init.retryAfter !== undefined) headers.set("retry-after", init.retryAfter);
  let next = 0;
  const cancel = vi.fn(async () => undefined);
  return {
    status: init.status ?? 200, headers, url: init.url ?? "https://cdn.example/a.jpg",
    body: body && {
      cancel,
      getReader: () => ({ cancel, read: async () => (next < body.length ? { done: false, value: body[next++] } : { done: true, value: undefined }) }),
    },
  } as unknown as Response;
}

function requesterOf(fetchFile: typeof fetch, signal = new AbortController().signal) {
  const rules = { added: [] as Array<{ address: string; referer: string | null }>, removed: [] as Array<number | null> };
  return {
    rules,
    requester: {
      signal, fetchFile,
      addRefererRule: async (address: string, referer: string | null) => {
        rules.added.push({ address, referer });
        return rules.added.length;
      },
      removeRefererRule: async (rule: number | null) => { rules.removed.push(rule); },
    },
  };
}

describe("requestFile", () => {
  const planned = fileAt("https://cdn.example/a.jpg#zoom", { referer: "https://shop.example/", cookies: false });

  it("gives the request its Referer and takes the rule away after the answer", async () => {
    const fetchFile = vi.fn(async () => responseOf([new Uint8Array([1, 2, 3])], { url: "https://cdn.example/moved.jpg" }));
    const { requester, rules } = requesterOf(fetchFile as unknown as typeof fetch);
    const answer = await requestFile(planned, requester);
    expect(rules.added).toEqual([{ address: "https://cdn.example/a.jpg", referer: "https://shop.example/" }]);
    expect(rules.removed).toEqual([1]);
    expect(answer).toMatchObject({ kind: "file", source: "browser", finalUrl: "https://cdn.example/moved.jpg" });
    expect(await (answer as FileAnswer).blob.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect((answer as FileAnswer).blob.type).toBe("image/jpeg");
  });

  it("carries cookies only when the plan says so", async () => {
    const fetchFile = vi.fn(async () => responseOf([new Uint8Array([1])]));
    await requestFile(fileAt("https://files.example/a.jpg", { cookies: true }), requesterOf(fetchFile as unknown as typeof fetch).requester);
    await requestFile(fileAt("https://cdn.example/a.jpg", { cookies: false }), requesterOf(fetchFile as unknown as typeof fetch).requester);
    expect((fetchFile.mock.calls as unknown as Array<[string, RequestInit]>)[0]?.[1]?.credentials).toBe("include");
    expect((fetchFile.mock.calls as unknown as Array<[string, RequestInit]>)[1]?.[1]?.credentials).toBe("omit");
  });

  it("carries cookies to the first address only: a redirect is asked without them", async () => {
    const redirect = { type: "opaqueredirect", status: 0, headers: new Headers(), body: null, url: "" } as unknown as Response;
    const fetchFile = vi.fn(async (_url: string, options: RequestInit) =>
      (options.redirect === "manual" ? redirect : responseOf([new Uint8Array([1])], { url: "https://cdn.other/moved.jpg" })));
    const { requester, rules } = requesterOf(fetchFile as unknown as typeof fetch);
    const answer = await requestFile(fileAt("https://files.example/a.jpg", { cookies: true }), requester);
    const asked = (fetchFile.mock.calls as unknown as Array<[string, RequestInit]>).map(([, options]) => [options.credentials, options.redirect]);
    expect(asked).toEqual([["include", "manual"], ["omit", undefined]]);
    expect(answer).toMatchObject({ kind: "file", finalUrl: "https://cdn.other/moved.jpg" });
    expect(rules.removed).toEqual([1]);
  });

  it("takes the rule away when the request fails", async () => {
    const { requester, rules } = requesterOf((async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch);
    expect(await requestFile(planned, requester)).toEqual({ kind: "failure", failure: "no_answer" });
    expect(rules.removed).toEqual([1]);
  });

  it("reports a refusal with the wait the site names", async () => {
    const limited = responseOf(null, { status: 429, retryAfter: "120" });
    const { requester } = requesterOf((async () => limited) as unknown as typeof fetch);
    expect(await requestFile(planned, requester)).toEqual({ kind: "status", status: 429, retryAfter: 120 });
  });

  it("does not take a web page or an empty answer for the file", async () => {
    const page = requesterOf((async () => responseOf([], { type: "text/html" })) as unknown as typeof fetch);
    expect(await requestFile(planned, page.requester)).toEqual({ kind: "failure", failure: "not_a_file" });
    const empty = requesterOf((async () => responseOf([])) as unknown as typeof fetch);
    expect(await requestFile(planned, empty.requester)).toEqual({ kind: "failure", failure: "not_a_file" });
  });

  it("refuses at once a file that declares more than the limit, and cuts one that does not", async () => {
    const declared = responseOf([new Uint8Array([1])], { length: String(globalThis.MineBrowserFile.MAX_BYTES + 1) });
    expect(await requestFile(planned, requesterOf((async () => declared) as unknown as typeof fetch).requester))
      .toEqual({ kind: "failure", failure: "too_large" });
    const stream = responseOf([{ length: globalThis.MineBrowserFile.MAX_BYTES + 1 } as unknown as Uint8Array]);
    expect(await requestFile(planned, requesterOf((async () => stream) as unknown as typeof fetch).requester))
      .toEqual({ kind: "failure", failure: "too_large" });
  });

  it("gives up after its time without bytes, and only then", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const fetchFile = ((_url: string, options: RequestInit) => new Promise((_, reject) => {
        options.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as unknown as typeof fetch;
      const answer = requestFile(planned, requesterOf(fetchFile).requester);
      await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(aborted).toBe(true);
      await expect(answer).resolves.toEqual({ kind: "failure", failure: "no_answer" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the request when the collection closes", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | null | undefined;
    const fetchFile = ((_url: string, options: RequestInit) => {
      signal = options.signal;
      return new Promise((_, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    const answer = requestFile(planned, requesterOf(fetchFile, controller.signal).requester);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(answer).resolves.toEqual({ kind: "failure", failure: "no_answer" });
    expect(signal?.aborted).toBe(true);
  });
});

describe("withoutFragment", () => {
  it("keeps everything of the address but its fragment", () => {
    expect(withoutFragment("https://cdn.example/a.jpg?w=1#zoom")).toBe("https://cdn.example/a.jpg?w=1");
  });
});
