// The backend of the audits that act as a person does on the app's built
// pages (scripts/built-app-pages.mjs). Each page gets `installBackend` as an
// init script with one `config`: the cards and collections of a small space,
// and what the audit wants the backend to do differently. The stand-in
// answers every command the page boots on, keeps the collections it is told
// to make, records every command in `window.__auditCommands`, and delivers
// the backend's events through `window.__auditFire(event, payload)`.
//
// Commands the audit's Node side must answer (the menu panel between two
// pages, which only the real backend joins) go to `window.__auditRelay`, a
// binding the audit exposes on the page (`page.exposeBinding`).

/** The cards of the space: notes, links and pictures in turn. `inCloud`
 *  names the cards whose picture's contents wait in iCloud and that have no
 *  preview yet; `thumbless` names the pictures whose preview is not made. */
export function spaceCards({ count = 60, inCloud = [], thumbless = [] } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const i = index + 1;
    const kind = i % 3 === 1 ? "note" : i % 3 === 2 ? "link" : "image";
    const slug = `card-${i}`;
    const cloud = inCloud.includes(slug);
    const noThumb = cloud || thumbless.includes(slug);
    return {
      id: i, slug, block_type: kind === "note" ? "article" : kind,
      card_kind: kind === "note" ? "article" : kind === "image" ? "media" : "link",
      title: `Card ${i}`, display_title: `Card ${i}`, fallback_label: `Card ${i}`,
      content_heading: null, description: null,
      url: kind === "link" ? `https://example.com/${i}` : null,
      media_file: kind === "image" ? `Media/picture-${i}.png` : null,
      thumbnail: kind === "image" && !noThumb ? `/thumbs/${slug}.png` : null,
      saved_at: "2026-11-16T10:00:00Z", source: null,
      width: kind === "image" ? 800 : null, height: kind === "image" ? 600 : null,
      author: kind === "link" ? "Author" : null, preview_text: `Some text of card ${i}`,
      first_image: null, media_urls: null, media_dimensions: null,
      // A picture's preview in the app's cache: `<slug>.jpg` under the thumbs root.
      preview_manifest: kind === "image" && !noThumb
        ? JSON.stringify({ kind: "media", primary_preview_path: `${slug}.jpg`, width: 800, height: 600, preview_width: 400, preview_height: 300, tiles: [], overflow_count: 0 })
        : null,
      feed_playback: null, thumb_format: kind === "image" && !noThumb ? "png" : null, thumb_mtime: 0,
      related_notes: [], origin: null, index_warning: null,
      content_in_cloud: cloud,
      tags: ["Inbox"], collections: ["Inbox"],
      body: kind === "note" ? `# Card ${i}\n\nText of the note.` : "", body_hash: `h${i}`,
    };
  });
}

/**
 * The stand-in, run in the page before its scripts. `config`:
 * - `cards`: the space's cards (`spaceCards`);
 * - `collections`: names of the collections besides Inbox;
 * - `label`: the page's window label (`main`, `menu-panel`, `tabbar`);
 * - `assetOrigin`: where the asset protocol is served (`/__asset?path=`);
 * - `icloud`: what `icloud_download_progress` answers for a file;
 * - `relayed`: the commands that go to `window.__auditRelay`;
 * - `answers`: fixed answers of more commands.
 */
export function installBackend(config) {
  const cards = config.cards ?? [];
  const channels = [];
  const channel = (tag, position) => ({
    tag, description: null, color: null, icon: null, position,
    created_at: "2026-11-16T10:00:00Z", block_count: 0,
  });
  for (const tag of ["Inbox", ...(config.collections ?? [])]) channels.push(channel(tag, channels.length));
  const memberships = () => {
    const rows = [];
    for (const card of cards) for (const tag of card.collections) rows.push({ block_id: card.id, tag });
    return rows;
  };
  const taxonomy = () => {
    const counts = new Map();
    for (const row of memberships()) counts.set(row.tag, (counts.get(row.tag) ?? 0) + 1);
    return {
      generation: generation,
      tags: channels.map((item) => ({ tag: item.tag, count: counts.get(item.tag) ?? 0 })),
      channels: channels.map((item) => ({ ...item, block_count: counts.get(item.tag) ?? 0 })),
      total_blocks: cards.length,
      memberships: memberships(),
    };
  };
  let generation = 1;
  const changed = (value, ids = null) => {
    generation += 1;
    return { value, cards: ids };
  };
  const find = (slug) => cards.find((card) => card.slug === slug) ?? null;
  const freeName = (base) => {
    const taken = (name) => channels.some((item) => item.tag.toLowerCase() === name.toLowerCase());
    if (!taken(base)) return base;
    for (let n = 2; ; n += 1) if (!taken(`${base} (${n})`)) return `${base} (${n})`;
  };
  const feed = (blocks) => ({ generation, blocks, total_blocks: blocks.length, has_more: false });
  const answers = {
    get_vault_path: "/vault",
    open_vault: { indexed: cards.length, derived_store_ready: true, thumbs_root: "/thumbs" },
    selection_generation: 1,
    list_known_vaults: ["/vault"],
    list_spaces: [],
    cloud_recommendation_state: { due: false },
    list_vault_conflict_paths: [],
    list_channel_previews: () => ({ generation, previews: {} }),
    space_onboarding_pending: false,
    list_grid_blocks: (args) => {
      const tag = args?.tag ?? args?.route?.tag ?? null;
      return feed(tag ? cards.filter((card) => card.collections.includes(tag)) : cards);
    },
    list_taxonomy_snapshot: taxonomy,
    list_pending_thumb_upgrades: [],
    search_grid_blocks: () => ({ generation, search_generation: 1, blocks: cards, has_more: false, next_cursor: null, cursor_reset: false }),
    begin_note_edit: (args) => find(args?.slug) ?? cards[0],
    get_block: (args) => find(args?.slug) ?? cards[0],
    end_note_edit: null,
    list_card_associations: (args) => ({ generation, slug: args?.slug, groups: [] }),
    icloud_download_progress: (args) => config.icloud?.[args?.mediaRef] ?? { status: "current", percent: null },
    check_collection_name: null,
    create_channel: (args) => {
      const made = channel(args.tag, channels.length);
      channels.push(made);
      return changed(made);
    },
    create_untitled_channel: () => {
      const made = channel(freeName("Untitled Collection"), channels.length);
      channels.push(made);
      return changed(made);
    },
    set_blocks_membership: (args) => {
      const ids = [];
      for (const slug of args.slugs) {
        const card = find(slug);
        if (!card) continue;
        ids.push(card.id);
        card.collections = args.connected
          ? [...new Set([...card.collections, args.tag])]
          : card.collections.filter((tag) => tag !== args.tag);
        card.tags = card.collections;
      }
      return changed(null, ids);
    },
    add_tag: (args) => {
      const card = find(args.slug);
      if (card && !card.collections.includes(args.tag)) card.collections = [...card.collections, args.tag];
      if (card) card.tags = card.collections;
      return changed(null, card ? [card.id] : []);
    },
    ...(config.answers ?? {}),
  };
  const callbacks = new Map();
  const listeners = [];
  let next = 1;
  window.__auditCommands = [];
  window.__auditState = { channels, cards };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: config.label ?? "main" }, currentWebview: { label: config.label ?? "main" } },
    convertFileSrc: (filePath) => {
      const path = filePath.startsWith("//") ? filePath.slice(1) : filePath;
      return `${config.assetOrigin ?? location.origin}/__asset?path=${encodeURIComponent(path)}`;
    },
    transformCallback(callback) {
      const id = next++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id) { callbacks.delete(id); },
    async invoke(command, args) {
      if (command === "plugin:event|listen") {
        listeners.push({ event: args.event, handler: args.handler });
        return listeners.length;
      }
      if (command.startsWith("plugin:event|")) return null;
      window.__auditCommands.push({ command, args, at: performance.now() });
      if ((config.relayed ?? []).includes(command)) return window.__auditRelay(command, args ?? null);
      const answer = answers[command];
      if (answer === undefined) return null;
      return typeof answer === "function" ? answer(args ?? {}) : answer;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__auditFire = (event, payload) => {
    for (const listener of listeners) {
      if (listener.event === event) callbacks.get(listener.handler)?.({ event, id: 0, payload });
    }
  };
  for (const [key, value] of Object.entries(config.storage ?? {})) {
    try { localStorage.setItem(key, value); } catch { /* a page without storage keeps its defaults */ }
  }
}

/** Frames of the page drawn: what is on the screen after the next paint. */
export function painted(page, frames = 2) {
  return page.evaluate((count) => new Promise((resolve) => {
    let left = count;
    const step = () => (left-- <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  }), frames);
}
