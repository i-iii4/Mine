// Pure X response normalization and author-chain selection. Shared by both worlds.
(function (root) {
  "use strict";
  const id = value => typeof value === "string" && /^\d+$/.test(value) ? value : null;
  const https = value => {
    try { const u = new URL(value); return u.protocol === "https:" ? u.href : null; }
    catch { return null; }
  };
  function post(result, quoteDepth = 0) {
    const t = result?.tweet || result;
    const l = t?.legacy;
    const user = t?.core?.user_results?.result;
    if (!l || !id(t.rest_id || l.id_str) || !id(user?.rest_id)) return null;
    const note = t.note_tweet?.note_tweet_results?.result;
    let text = note?.text || l.full_text || "";
    const entities = note?.entity_set || l.entities || {};
    for (const link of entities.urls || []) {
      if (link.url && link.expanded_url) text = text.split(link.url).join(link.expanded_url);
    }
    const media = [];
    let incomplete = !!l.truncated && !note?.text;
    let hasVideo = false;
    for (const m of l.extended_entities?.media || l.entities?.media || []) {
      const isVideo = m.type === "video" || m.type === "animated_gif";
      hasVideo ||= isVideo;
      const variants = (m.video_info?.variants || []).filter(v => v.content_type === "video/mp4" && https(v.url));
      variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const url = https(isVideo ? variants[0]?.url : m.media_url_https);
      if (!url) incomplete = true;
      else if (!media.some(existing => existing.url === url)) media.push({ url, kind: isVideo ? "video" : "image", poster: https(m.media_url_https) });
      if (m.url) text = text.split(m.url).join("");
    }
    const quoted = t.quoted_status_result?.result;
    const quote = quoteDepth === 0 && quoted ? post(quoted, 1) : null;
    if (quoted && !quote || quote?.incomplete) incomplete = true;
    // The quote block names and links the quoted post; a trailing permalink
    // to it in the parent text would only repeat that link.
    if (quote) text = text.replace(new RegExp(`\\s*https?://(?:www\\.|mobile\\.)?(?:x|twitter)\\.com/[^/\\s]+/status/${quote.id}(?:[/?#]\\S*)?\\s*$`, "i"), "");
    const mediaComplete = Array.isArray(l.extended_entities?.media)
      && media.length === l.extended_entities.media.length;
    return { id: t.rest_id || l.id_str, authorId: user.rest_id,
      handle: user.core?.screen_name || user.legacy?.screen_name || "",
      name: user.core?.name || user.legacy?.name || "",
      parentId: id(l.in_reply_to_status_id_str), text: text.trim(), media, quote, incomplete, hasVideo, mediaComplete };
  }
  // A feed shows a repost as the post it reposts: that post, under its own ID,
  // is what the feed card and its timestamp link stand for.
  function feedPost(result) {
    const t = result?.tweet || result;
    const original = t?.legacy?.retweeted_status_result?.result || t?.retweeted_status_result?.result;
    return post(original || result);
  }
  function page(data) {
    const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions;
    if (!Array.isArray(instructions) || data.errors?.length) throw new Error("X did not return a readable conversation.");
    return walk(instructions, { normalize: post, promoted: false });
  }
  // Every `instructions` list of a feed response: its place above them differs
  // per operation (list, home, profile, search, X Pro column).
  function instructionLists(value, depth, out) {
    if (!value || typeof value !== "object" || Array.isArray(value) || depth > 8) return out;
    if (Array.isArray(value.instructions)) out.push(value.instructions);
    for (const key of Object.keys(value)) if (key !== "instructions") instructionLists(value[key], depth + 1, out);
    return out;
  }
  // The posts of a feed response (SPEC_CLIPPER.md, «Кнопка Mine в ленте X»,
  // rule 6). A shape it does not know gives no posts, never an error.
  function feed(data) {
    return instructionLists(data?.data, 0, []).flatMap(list => walk(list, { normalize: feedPost, promoted: true }).posts);
  }
  function walk(instructions, { normalize, promoted }) {
    const posts = [], cursors = [], modules = [];
    let unavailable = false;
    function item(content, scope = null) {
      if (!content) return;
      const type = content.__typename || content.itemType || content.entryType;
      if (type === "TimelineTimelineCursor" || type === "TimelineCursor") {
        const direction = content.cursorType;
        if (["Bottom", "ShowMore", "Top", "ShowMoreThreads"].includes(direction) && typeof content.value === "string") {
          cursors.push({ value: content.value, direction, moduleId: scope?.id || null });
        }
      } else if (type === "TimelineTweet" && (promoted || !content.promotedMetadata)) {
        const normalized = normalize(content.tweet_results?.result);
        if (normalized) { posts.push(normalized); scope?.postIds.push(normalized.id); }
        else if (scope) scope.unavailable = true;
        else unavailable = true;
      } else if (content.itemContent) item(content.itemContent, scope);
      else if (content.item) item(content.item, scope);
      else if (Array.isArray(content.items)) content.items.forEach(value => item(value, scope));
    }
    function entry(e) {
      const content = e.content;
      if (Array.isArray(content?.items)) {
        const scope = { id: e.entryId || e.entry_id || `anonymous-${modules.length}`, postIds: [], unavailable: false };
        modules.push(scope);
        item(content, scope);
      } else item(content);
    }
    for (const instruction of instructions) {
      const type = instruction.type || instruction.__typename;
      if (type === "TimelineAddEntries") for (const e of instruction.entries || []) entry(e);
      else if (type === "TimelineAddToModule") {
        const scope = { id: instruction.moduleEntryId || instruction.module_entry_id || `anonymous-${modules.length}`, postIds: [], unavailable: false };
        modules.push(scope);
        for (const e of instruction.moduleItems || []) item(e, scope);
      } else if ((type === "TimelineReplaceEntry" || type === "TimelinePinEntry") && instruction.entry) entry(instruction.entry);
    }
    return { posts, cursors, modules, unavailable };
  }
  // Global Bottom/ShowMore paginate the discussion, not the author chain.
  // Module continuations keep their ownership through normalization and appends.
  function continuations(pages, targetId) {
    const allPosts = pages.flatMap(p => p.posts);
    const selected = select(allPosts, targetId);
    const selectedIds = new Set(selected.posts.map(p => p.id));
    const selectedModules = new Set(pages.flatMap(p => p.modules || [])
      .filter(m => m.postIds.some(value => selectedIds.has(value))).map(m => m.id));
    const missingAncestor = selected.posts.some(p => p.parentId && !allPosts.some(a => a.id === p.parentId));
    const cursors = pages.flatMap(p => p.cursors).filter(c => c.moduleId
      ? selectedModules.has(c.moduleId)
      : c.direction === "Top" && missingAncestor);
    const unavailable = pages.some(p => p.unavailable || (p.modules || []).some(m => selectedModules.has(m.id) && m.unavailable));
    return { cursors: [...new Map(cursors.map(c => [c.value, c])).values()], unavailable };
  }
  function select(posts, targetId) {
    const byId = new Map(), issues = [];
    for (const p of posts) {
      const previous = byId.get(p.id);
      if (previous && (previous.parentId !== p.parentId || previous.authorId !== p.authorId)) issues.push("Conflicting post relationships.");
      byId.set(p.id, p);
    }
    const target = byId.get(targetId);
    if (!target) return { posts: [], issues: ["The requested post was not found."] };
    let first = target;
    const visited = new Set();
    while (first.parentId) {
      if (visited.has(first.id)) { issues.push("Invalid reply cycle."); break; }
      visited.add(first.id);
      const parent = byId.get(first.parentId);
      if (!parent) { issues.push("An earlier post could not be loaded."); break; }
      if (parent.authorId !== target.authorId) break;
      first = parent;
    }
    const selected = [], queue = [first], included = new Set();
    const compare = (a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id);
    while (queue.length) {
      const p = queue.shift();
      if (included.has(p.id)) continue;
      included.add(p.id); selected.push(p);
      const children = [...byId.values()].filter(c => c.parentId === p.id && c.authorId === target.authorId);
      queue.push(...children); queue.sort(compare);
    }
    if (selected.some(p => p.incomplete)) issues.push("Some text or media could not be loaded.");
    return { posts: selected, issues: [...new Set(issues)] };
  }
  // Name, @handle and a link to the quoted post: the first line of its block
  // (SPEC_CLIPPER.md, «Пост с цитатой как в оригинале», rule 2).
  function quoteAuthor(q) {
    const handle = /^\w{1,15}$/.test(q.handle || "") ? q.handle : "";
    const name = String(q.name || "").replace(/\s+/g, " ").trim().replace(/[\\`*_[\]<>~]/g, "\\$&");
    // Only an underscore at the edge of a handle can open emphasis.
    const at = handle && `@${handle.replace(/^_+|_+$/g, edge => edge.replace(/_/g, "\\_"))}`;
    const url = id(q.id) && `https://x.com/${handle || "i"}/status/${q.id}`;
    const link = url ? `[${at || url.slice("https://".length)}](${url})` : at;
    return [name && `**${name}**`, link].filter(Boolean).join(" ");
  }
  // Each post: its text, then its own media in post order, then the quote as
  // one blockquote with its author, text and media. Parts are joined by `***`,
  // not `---`: three dashes at the top of a body read as front matter.
  function compose(posts) {
    function body(p, quoted = false) {
      const parts = [quoted ? quoteAuthor(p) : "", p.text, ...p.media.map(m => `![](${m.url})`)].filter(Boolean);
      if (p.quote) parts.push(body(p.quote, true).split("\n").map(line => `> ${line}`).join("\n"));
      return parts.join("\n\n");
    }
    return posts.map(p => body(p)).filter(Boolean).join("\n\n***\n\n");
  }
  root.MineXThread = { page, feed, post, select, compose, continuations };
})(globalThis);
