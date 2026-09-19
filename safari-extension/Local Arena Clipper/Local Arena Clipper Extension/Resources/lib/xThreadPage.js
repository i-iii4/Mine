// Observe only X conversation responses. Request credentials never leave this world.
(() => {
  "use strict";
  if (globalThis.MineXThreadPage || !globalThis.MineXThread) return;
  const originalFetch = window.fetch.bind(window);
  const records = new Map();
  const MAX_RECORDS = 8, MAX_PAGES = 20, MAX_POSTS = 1000, DEADLINE_MS = 15000;
  const pending = new Set();
  function requestInfo(input) {
    try {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
      if (url.origin !== location.origin || !/^\/i\/api\/graphql\/[^/]+\/(TweetDetail|ConversationTimeline)$/.test(url.pathname)) return null;
      const variables = JSON.parse(url.searchParams.get("variables") || "{}");
      const target = variables.focalTweetId || variables.focal_tweet_id;
      if (!/^\d+$/.test(target)) return null;
      return { url: url.href, target, variables };
    } catch { return null; }
  }
  function accept(info, headers, data) {
    try {
      const page = globalThis.MineXThread.page(data);
      const prior = records.get(info.target);
      // The initial response owns the request template. Cursor pages only add records.
      if (!info.variables.cursor || !prior) {
        records.delete(info.target);
        records.set(info.target, { info, headers, pages: [page] });
      } else if (prior.pages.length < MAX_PAGES) prior.pages.push(page);
      while (records.size > MAX_RECORDS) records.delete(records.keys().next().value);
    } catch {
      records.delete(info.target);
    }
  }
  function track(promise) {
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
  }
  window.fetch = function(input, init) {
    const response = originalFetch(input, init);
    const method = init?.method || input?.method || "GET";
    const info = method.toUpperCase() === "GET" ? requestInfo(input) : null;
    if (info) {
      const headers = new Headers(typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
      track(response.then(r => r.ok ? r.clone().json().then(d => accept(info, headers, d)) : undefined).catch(() => undefined));
    }
    return response;
  };
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const setHeader = XMLHttpRequest.prototype.setRequestHeader;
  const xhrInfo = new WeakMap();
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    const info = method.toUpperCase() === "GET" ? requestInfo(String(url)) : null;
    xhrInfo.set(this, info ? { info, headers: new Headers() } : null);
    return open.call(this, method, url, ...args);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    xhrInfo.get(this)?.headers.set(name, value);
    return setHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    const captured = xhrInfo.get(this);
    if (captured) {
      track(new Promise(resolve => this.addEventListener("loadend", () => {
        try {
          if (this.status >= 200 && this.status < 300) accept(captured.info, captured.headers,
            this.responseType === "json" ? this.response : JSON.parse(this.responseText));
        } catch { /* Preserve X's response and leave extraction unavailable. */ }
        resolve();
      }, { once: true })));
    }
    return send.apply(this, args);
  };
  async function collect(target) {
    const startedUrl = location.href;
    if (!new RegExp(`/status/${target}(?:[/?#]|$)`).test(new URL(startedUrl).pathname)) return { posts: [], issues: ["The page changed. Open the clipper again."] };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    window.addEventListener("pagehide", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    let pages = [];
    try {
      await Promise.race([Promise.all([...pending]), new Promise(resolve => setTimeout(resolve, 1500))]);
      const record = records.get(target);
      if (!record) return { posts: [], issues: ["Reload this X page once, then open Mine again to collect the thread."] };
      pages = [...record.pages];
      const seen = new Set(), issues = [];
      let cursors = globalThis.MineXThread.continuations(pages, target).cursors.map(c => c.value);
      let count = 0;
      while (cursors.length) {
        if (location.href !== startedUrl) throw new Error("The page changed. Open the clipper again.");
        if (++count > MAX_PAGES || pages.reduce((n,p) => n + p.posts.length, 0) > MAX_POSTS) { issues.push("The thread exceeded the loading limit."); break; }
        const cursor = cursors.shift();
        if (seen.has(cursor)) { issues.push("X repeated a continuation page."); break; }
        seen.add(cursor);
        const url = new URL(record.info.url);
        url.searchParams.set("variables", JSON.stringify({ ...record.info.variables, cursor }));
        const response = await originalFetch(url.href, { headers: record.headers, credentials: "include", signal: controller.signal });
        if (!response.ok) throw new Error("X could not load the rest of this thread.");
        const page = globalThis.MineXThread.page(await response.json());
        pages.push(page);
        const relevant = globalThis.MineXThread.continuations(pages, target);
        if (page.cursors.some(c => seen.has(c.value) && relevant.cursors.some(r => r.value === c.value))) {
          issues.push("X repeated a continuation page."); break;
        }
        cursors = relevant.cursors.map(c => c.value).filter(c => !seen.has(c));
      }
      if (location.href !== startedUrl) return { posts: [], issues: ["The page changed. Open the clipper again."] };
      const result = globalThis.MineXThread.select(pages.flatMap(p => p.posts), target);
      if (globalThis.MineXThread.continuations(pages, target).unavailable) issues.push("X withheld part of this conversation.");
      return { posts: result.posts, issues: [...new Set([...issues, ...result.issues])] };
    } catch (error) {
      if (location.href !== startedUrl) return { posts: [], issues: ["The page changed. Open the clipper again."] };
      const result = globalThis.MineXThread.select(pages.flatMap(p => p.posts), target);
      return { posts: result.posts, issues: [...result.issues, error.name === "AbortError" ? "Thread loading timed out." : error.message] };
    } finally { clearTimeout(timer); window.removeEventListener("pagehide", cancel); }
  }
  globalThis.MineXThreadPage = { collect };
})();
