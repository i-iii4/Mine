// Observe only X conversation and feed responses. Request credentials never leave this world.
(() => {
  "use strict";
  if (globalThis.MineXThreadPage || !globalThis.MineXThread) return;
  const originalFetch = window.fetch.bind(window);
  const records = new Map();
  const MAX_RECORDS = 8, MAX_PAGES = 20, MAX_POSTS = 1000, DEADLINE_MS = 15000;
  // Posts the feeds of this page showed, by post ID, for the Mine button of
  // each post (SPEC_CLIPPER.md, «Кнопка Mine в ленте X», rule 6).
  const MAX_KNOWN_POSTS = 500, KNOWN_POST_WAIT_MS = 500;
  const FEED_OPERATIONS = new Set(["ListLatestTweetsTimeline", "HomeTimeline", "HomeLatestTimeline",
    "UserTweets", "UserOriginalsTimeline", "SearchTimeline"]);
  const knownPosts = new Map();
  const pending = new Set();
  function requestInfo(input, method) {
    try {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
      const operation = url.origin === location.origin && url.pathname.match(/^\/i\/api\/graphql\/[^/]+\/([A-Za-z]+)$/)?.[1];
      if (!operation) return null;
      // A feed is only read: GET or POST, its request is never replayed.
      if (FEED_OPERATIONS.has(operation)) return { feed: true };
      if (method !== "GET" || (operation !== "TweetDetail" && operation !== "ConversationTimeline")) return null;
      const variables = JSON.parse(url.searchParams.get("variables") || "{}");
      const target = variables.focalTweetId || variables.focal_tweet_id;
      if (!/^\d+$/.test(target)) return null;
      return { url: url.href, target, variables };
    } catch { return null; }
  }
  function remember(posts) {
    for (const post of posts) {
      knownPosts.delete(post.id);
      knownPosts.set(post.id, post);
    }
    while (knownPosts.size > MAX_KNOWN_POSTS) knownPosts.delete(knownPosts.keys().next().value);
  }
  function acceptFeed(data) {
    try { remember(globalThis.MineXThread.feed(data)); } catch { /* An unreadable feed leaves the cache as it was. */ }
  }
  function accept(info, headers, data) {
    if (info.feed) { acceptFeed(data); return; }
    try {
      const page = globalThis.MineXThread.page(data);
      remember(page.posts);
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
    const method = (init?.method || input?.method || "GET").toUpperCase();
    const info = requestInfo(input, method);
    if (info) {
      // A feed request is never replayed: its headers are not kept.
      const headers = new Headers(!info.feed && typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
      if (!info.feed) new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
      track(response.then(r => r.ok ? r.clone().json().then(d => accept(info, headers, d)) : undefined).catch(() => undefined));
    }
    return response;
  };
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const setHeader = XMLHttpRequest.prototype.setRequestHeader;
  const xhrInfo = new WeakMap();
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    const info = requestInfo(String(url), String(method).toUpperCase());
    xhrInfo.set(this, info ? { info, headers: new Headers() } : null);
    return open.call(this, method, url, ...args);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    const captured = xhrInfo.get(this);
    if (captured && !captured.info.feed) captured.headers.set(name, value);
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
  /// The post `id` as a feed or conversation of this page delivered it, or
  /// `null`. A response still on its way is waited for a moment.
  async function post(id) {
    const key = String(id);
    if (!/^\d+$/.test(key)) return null;
    if (!knownPosts.has(key) && pending.size) {
      await Promise.race([Promise.all([...pending]), new Promise(resolve => setTimeout(resolve, KNOWN_POST_WAIT_MS))]);
    }
    return knownPosts.get(key) ?? null;
  }
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
  globalThis.MineXThreadPage = { collect, post };
})();
