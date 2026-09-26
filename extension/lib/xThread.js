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
    const mediaComplete = Array.isArray(l.extended_entities?.media)
      && media.length === l.extended_entities.media.length;
    return { id: t.rest_id || l.id_str, authorId: user.rest_id,
      handle: user.core?.screen_name || user.legacy?.screen_name || "",
      parentId: id(l.in_reply_to_status_id_str), text: text.trim(), media, quote, incomplete, hasVideo, mediaComplete };
  }
  function page(data) {
    const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions;
    if (!Array.isArray(instructions) || data.errors?.length) throw new Error("X did not return a readable conversation.");
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
      } else if (type === "TimelineTweet" && !content.promotedMetadata) {
        const normalized = post(content.tweet_results?.result);
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
      } else if (type === "TimelineReplaceEntry" && instruction.entry) entry(instruction.entry);
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
  function compose(posts) {
    function body(p) {
      const parts = [p.text, ...p.media.map(m => `![](${m.url})`)].filter(Boolean);
      if (p.quote) parts.push(body(p.quote).split("\n").map(line => `> ${line}`).join("\n"));
      return parts.join("\n\n");
    }
    return posts.map(body).filter(Boolean).join("\n\n***\n\n");
  }
  root.MineXThread = { page, post, select, compose, continuations };
})(globalThis);
