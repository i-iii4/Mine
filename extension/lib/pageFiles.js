// The collection of a clip's files by the browser, before its Save
// (SPEC_CLIPPER.md, «Один путь файла со страницы», Б4 to Б6, Б11). The plan comes
// from the save core; here is only the order of the work: the cache of the page
// costs the site nothing and comes first, then one request per file within the
// limits of the plan, a poster only for a video the browser did not get. What is
// done with the bytes is the caller's, so the same order serves any executor.
(function (root) {
  "use strict";

  /** Name of the port the clipper asks for a collection on, before its id. */
  const PORT_PREFIX = "mine-page-files:";
  /** Name of the port a Save into a browser folder runs on, before its id (Б13). */
  const SAVE_PORT_PREFIX = "mine-standalone-save:";
  /** How long a request may stay without new bytes (Б11). */
  const IDLE_MS = 15_000;
  /** Bytes of an answer read into memory before they become a `Blob` part. */
  const PART_BYTES = 4 * 1024 * 1024;
  /** The first status of a failure of the server, which may pass (Б13). */
  const FIRST_SERVER_ERROR = 500;

  /** @typedef {import("./browserFile.types").PageFileAnswer} PageFileAnswer */
  /** @typedef {import("./pageFiles.types").FileAnswer} FileAnswer */
  /** @typedef {import("./pageFiles.types").PageFile} PageFile */
  /** @typedef {import("./pageFiles.types").PageFilePlan} PageFilePlan */
  /** @typedef {import("./pageFiles.types").BrowserFileEntry} BrowserFileEntry */
  /** @typedef {import("./pageFiles.types").PageFileWork} PageFileWork */
  /** @typedef {import("./pageFiles.types").RequestLimiter} RequestLimiter */

  /**
   * The host of an address, the key of the limits and of a closed host.
   * @param {string} url
   */
  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  /**
   * The address a request goes to: a fragment never leaves the browser, and the
   * rule of the `Referer` names the address exactly.
   * @param {string} url
   */
  function withoutFragment(url) {
    const address = new URL(url);
    address.hash = "";
    return address.href;
  }

  /**
   * Whether an answer is worth asking for again: the file may still come after a
   * failure of the server or the network, and a refusal stays a refusal (Б13).
   * @param {PageFileAnswer | FileAnswer | null} answer
   */
  function repeatable(answer) {
    if (answer === null) return false;
    switch (answer.kind) {
      case "stalled":
      case "refused":
        return true;
      case "failure":
        return answer.failure === "no_answer";
      case "status":
        return answer.status >= FIRST_SERVER_ERROR;
      default:
        return false;
    }
  }

  /**
   * A wait that ends early when `signal` aborts.
   * @param {number} ms
   * @param {AbortSignal} signal
   * @returns {Promise<void>}
   */
  function pause(ms, signal) {
    return new Promise((resolve) => {
      const end = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", end);
        resolve();
      };
      const timer = setTimeout(end, ms);
      signal.addEventListener("abort", end, { once: true });
    });
  }

  /**
   * Requests of all Saves together: at most `parallel` at once and `perHost` to
   * one host (Б11), in the order they were asked for.
   * @returns {RequestLimiter}
   */
  function createLimiter() {
    let open = 0;
    /** @type {Map<string, number>} */
    const perHostOpen = new Map();
    /** @type {Array<{ host: string, parallel: number, perHost: number, grant: () => void }>} */
    const queue = [];
    const pump = () => {
      for (let index = 0; index < queue.length;) {
        const entry = queue[index];
        if (entry && open < entry.parallel && (perHostOpen.get(entry.host) ?? 0) < entry.perHost) {
          queue.splice(index, 1);
          entry.grant();
        } else {
          index += 1;
        }
      }
    };
    return {
      acquire(host, parallel, perHost, signal) {
        return new Promise((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          const entry = {
            host, parallel, perHost,
            grant() {
              signal.removeEventListener("abort", leave);
              open += 1;
              perHostOpen.set(host, (perHostOpen.get(host) ?? 0) + 1);
              let released = false;
              resolve(() => {
                if (released) return;
                released = true;
                open -= 1;
                perHostOpen.set(host, (perHostOpen.get(host) ?? 1) - 1);
                pump();
              });
            },
          };
          function leave() {
            const index = queue.indexOf(entry);
            if (index >= 0) queue.splice(index, 1);
            reject(new Error("aborted"));
          }
          signal.addEventListener("abort", leave, { once: true });
          queue.push(entry);
          pump();
        });
      },
    };
  }

  /**
   * Read an answer in portions into a `Blob`, cut at the size limit; `awake` after
   * every portion, so only a stalled answer runs out of its time.
   * @param {Response} response
   * @param {number} limit
   * @param {() => void} awake
   * @returns {Promise<Blob | null>} the file, or null past the limit
   */
  async function readAnswer(response, limit, awake) {
    const type = response.headers.get("content-type") ?? "";
    const reader = response.body?.getReader();
    if (!reader) return new Blob([await response.arrayBuffer()], { type });
    /** @type {Blob[]} */
    const parts = [];
    /** @type {Uint8Array<ArrayBuffer>[]} */
    let held = [];
    let heldBytes = 0;
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      awake();
      total += value.length;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      held.push(value);
      heldBytes += value.length;
      if (heldBytes >= PART_BYTES) {
        parts.push(new Blob(held));
        held = [];
        heldBytes = 0;
      }
    }
    if (heldBytes > 0) parts.push(new Blob(held));
    return new Blob(parts, { type });
  }

  /**
   * The request from outside the page (Б6): under its `Referer` rule, which goes
   * away as soon as the answer starts. Without a host permission or for a site that
   * asks for its own cookie this may be refused like any request; the helper or
   * the link takes over.
   * @param {PageFile} file
   * @param {import("./pageFiles.types").FileRequester} requester
   * @returns {Promise<PageFileAnswer | FileAnswer>}
   */
  async function requestFile(file, requester) {
    const watch = new AbortController();
    const stop = () => watch.abort();
    if (requester.signal.aborted) stop();
    requester.signal.addEventListener("abort", stop);
    /** @type {ReturnType<typeof setTimeout>} */
    let idle = setTimeout(stop, requester.idleMs ?? IDLE_MS);
    const awake = () => {
      clearTimeout(idle);
      idle = setTimeout(stop, requester.idleMs ?? IDLE_MS);
    };
    try {
      const address = withoutFragment(file.url);
      const rule = await requester.addRefererRule(address, file.referer);
      /** @type {Response} */
      let response;
      try {
        // Cookies go to the site of the clip's page and no further: the page
        // wrote the address, and with cookies a redirect of its own site would
        // carry the person's login to any site it names (Б6). So a request with
        // cookies does not follow a redirect, and the redirect is asked without.
        response = await requester.fetchFile(address, file.cookies
          ? { credentials: "include", redirect: "manual", signal: watch.signal }
          : { credentials: "omit", signal: watch.signal });
        if (response.type === "opaqueredirect") {
          awake();
          response = await requester.fetchFile(address, { credentials: "omit", signal: watch.signal });
        }
      } finally {
        await requester.removeRefererRule(rule);
      }
      awake();
      if (response.status !== 200) {
        await response.body?.cancel();
        return { kind: "status", status: response.status,
          retryAfter: root.MineBrowserFile.retryAfterSeconds(response.headers.get("retry-after"), Date.now()) };
      }
      if (root.MineBrowserFile.declaresWebPage(response)) {
        await response.body?.cancel();
        return { kind: "failure", failure: "not_a_file" };
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > root.MineBrowserFile.MAX_BYTES) {
        await response.body?.cancel();
        return { kind: "failure", failure: "too_large" };
      }
      const blob = await readAnswer(response, root.MineBrowserFile.MAX_BYTES, awake);
      if (blob === null) return { kind: "failure", failure: "too_large" };
      if (blob.size === 0) return { kind: "failure", failure: "not_a_file" };
      return { kind: "file", blob, source: "browser", finalUrl: response.url };
    } catch {
      return { kind: "failure", failure: "no_answer" };
    } finally {
      clearTimeout(idle);
      requester.signal.removeEventListener("abort", stop);
    }
  }

  /**
   * Collect the files of `plan`: what each came to, in the order of the plan. A
   * file the browser did not ask for has no entry, and the helper handles it as
   * it always has (Б8). Nothing here rejects: every failure is an entry.
   * @param {PageFilePlan} plan
   * @param {PageFileWork} work
   * @returns {Promise<BrowserFileEntry[]>}
   */
  async function collect(plan, work) {
    /** @type {Map<string, BrowserFileEntry>} */
    const results = new Map();
    /** A `429` closes its host for the following files of this Save (Б8). */
    /** @type {Map<string, number | null>} */
    const closedHosts = new Map();
    // A page that stays silent over its cache will not answer the next file
    // either: the background asks from outside instead of waiting for each.
    let pageSilent = false;

    /** @param {string} host @param {number | null | undefined} retryAfter */
    const closeHost = (host, retryAfter) => closedHosts.set(host, retryAfter ?? closedHosts.get(host) ?? null);

    /**
     * @param {PageFile} file
     * @param {string} host
     * @returns {BrowserFileEntry}
     */
    const limitedEntry = (file, host) => {
      const retryAfter = closedHosts.get(host);
      return { url: file.url, failure: "host_limited", ...(retryAfter === null || retryAfter === undefined ? {} : { retry_after: retryAfter }) };
    };

    /**
     * @param {PageFile} file
     * @param {FileAnswer} answer
     * @returns {Promise<BrowserFileEntry>}
     */
    const stored = async (file, answer) => {
      /** @type {string | null} */
      let uploadId;
      try {
        uploadId = await work.store(answer.blob, file.url);
      } catch (failure) {
        console.warn("[Mine] a file of the page was not kept:", file.url, String(failure));
        return { url: file.url, failure: "not_stored" };
      }
      if (uploadId === null) return { url: file.url, failure: "no_answer" };
      return { url: file.url, upload_id: uploadId, source: answer.source,
        ...(answer.source === "browser" ? { final_url: answer.finalUrl } : {}) };
    };

    /**
     * What an answer of a request comes to.
     * @param {PageFile} file
     * @param {string} host
     * @param {PageFileAnswer | FileAnswer} answer
     * @returns {Promise<BrowserFileEntry | null>}
     */
    const settled = async (file, host, answer) => {
      switch (answer.kind) {
        case "file":
          return stored(file, answer);
        case "status":
          if (answer.status === 429) closeHost(host, answer.retryAfter);
          return { url: file.url, status: answer.status,
            ...(answer.retryAfter === null || answer.retryAfter === undefined ? {} : { retry_after: answer.retryAfter }) };
        case "failure":
          return { url: file.url, failure: answer.failure };
        case "stalled":
        case "refused":
          return { url: file.url, failure: "no_answer" };
        default:
          return null;
      }
    };

    /**
     * What the requests of a file came to: the page's own for its own origin, from
     * outside for another. With `retryPausesMs` a failure that may pass is asked
     * again, up to one request more than there are pauses (Б13); without them, as
     * with the helper, which takes over from there, one request is the end (Б8).
     * Null when no answer stands: a file of a closed host has its entry already.
     * @param {PageFile} file
     * @param {boolean} startsOnPage
     * @param {string} host
     * @returns {Promise<PageFileAnswer | FileAnswer | null>}
     */
    const asked = async (file, startsOnPage, host) => {
      const pauses = work.retryPausesMs ?? [];
      let onPage = startsOnPage;
      let outsideFile = file;
      let requests = 0;
      const outside = () => {
        requests += 1;
        return work.request(outsideFile);
      };
      /** @returns {Promise<PageFileAnswer | FileAnswer | null>} */
      const askOnce = async () => {
        if (!onPage) return file.reachable ? outside() : null;
        const answer = await work.pageRead(file.url, "request");
        // The browser refused the page's request (a redirect to another domain)
        // or the page cannot make it: the file is asked for from outside, unless
        // the plan says that address leads inside. After a refused request of the
        // page the cookies stay behind: the redirect that was refused leads to
        // another domain (Б8).
        if (answer.kind === "elsewhere") {
          onPage = false;
          return file.reachable ? outside() : answer;
        }
        requests += 1;
        if (answer.kind === "refused" && file.reachable) {
          onPage = false;
          outsideFile = { ...file, cookies: false };
          return outside();
        }
        return answer;
      };
      let answer = await askOnce();
      for (let retry = 0; requests <= pauses.length && repeatable(answer) && !work.signal.aborted; retry += 1) {
        await pause(/** @type {number} */ (pauses[retry]), work.signal);
        if (work.signal.aborted) break;
        if (closedHosts.has(host)) {
          results.set(file.url, limitedEntry(file, host));
          return null;
        }
        answer = await askOnce();
      }
      return answer;
    };

    /**
     * The requests of a file within the limits, and its entry.
     * @param {PageFile} file
     * @param {boolean} onPage
     */
    const requested = async (file, onPage) => {
      const host = hostOf(file.url);
      if (closedHosts.has(host)) {
        results.set(file.url, limitedEntry(file, host));
        return;
      }
      /** @type {() => void} */
      let release;
      try {
        release = await work.limiter.acquire(host, plan.parallel, plan.per_domain, work.signal);
      } catch {
        return;
      }
      /** @type {Parameters<typeof settled>[2] | null} */
      let answer;
      try {
        if (closedHosts.has(host)) {
          results.set(file.url, limitedEntry(file, host));
          return;
        }
        answer = await asked(file, onPage, host);
      } finally {
        release();
      }
      if (work.signal.aborted || answer === null) return;
      const entry = await settled(file, host, answer);
      if (entry) results.set(file.url, entry);
    };

    /** @param {PageFile[]} files */
    const sweep = async (files) => {
      /** @type {Array<{ file: PageFile, onPage: boolean }>} */
      const toRequest = [];
      // The cache costs the site nothing and takes no place in the limits. One
      // file at a time: a file of the cache waits for its upload anyway.
      for (const file of files) {
        if (work.signal.aborted) return;
        const answer = pageSilent ? /** @type {PageFileAnswer} */ ({ kind: "elsewhere" }) : await work.pageRead(file.url, "cache");
        if (answer.kind === "stalled") pageSilent = true;
        if (answer.kind === "file") results.set(file.url, await stored(file, answer));
        else if (answer.kind === "failure") results.set(file.url, { url: file.url, failure: answer.failure });
        else toRequest.push({ file, onPage: answer.kind === "miss" });
      }
      await Promise.all(toRequest.map(({ file, onPage }) => requested(file, onPage)));
    };

    await sweep(plan.files.filter((file) => !file.poster_of));
    await sweep(plan.files.filter((file) => {
      if (!file.poster_of) return false;
      return !results.get(file.poster_of)?.upload_id;
    }));
    return plan.files.flatMap((file) => results.get(file.url) ?? []);
  }

  root.MinePageFiles = { PORT_PREFIX, SAVE_PORT_PREFIX, IDLE_MS, hostOf, withoutFragment, createLimiter, requestFile, collect };
})(globalThis);
