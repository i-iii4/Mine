import React from "react";
import { createRoot } from "react-dom/client";
import { SearchOverlay } from "../../src/components/SearchOverlay";
import { Detail } from "../../src/components/Detail";
import "../../src/styles/global.css";

const noop = () => {};
const block = {
  id: 1, slug: "fixture", title: "Selection fixture", display_title: "Selection fixture",
  card_kind: "article", block_type: "article", body: "Author: @test\n\nAuthor: @test",
  body_hash: "fixture-hash", saved_at: "2026-09-13T00:00:00Z", tags: [],
  url: null, author: null, media_file: null, thumbnail: null, description: null,
  related_notes: [], preview_manifest: null, preview_state: "missing", width: null, height: null,
  fallback_label: "Selection fixture", first_image: null, media_urls: null, media_dimensions: null,
  thumb_mtime: 0, thumb_format: null, feed_playback: null,
};
const tags = Array.from({ length: 24 }, (_, i) => ({ tag: `Channel ${String(i).padStart(2, "0")}`, count: i }));
window.auditActions = [];
window.__TAURI_INTERNALS__ = {
  convertFileSrc: () => "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  invoke: async (command) => {
    if (command === "get_block") return block;
    if (command === "list_grid_blocks" || command === "search_grid_blocks") return {
      generation: 1, blocks: [block], total: 1, has_more: false, next_cursor: null,
    };
    return null;
  },
};
const detail = new URLSearchParams(location.search).has("detail");
createRoot(document.getElementById("root")).render(detail ? (
  <Detail block={block} vaultPath="/tmp/fixture" thumbsRootPath="/tmp/fixture"
    tags={tags} onClose={noop} onNavigate={noop} onToggleTag={noop}
    onCreateAndAssign={noop} onTagsChanged={noop} onRequestRename={noop} onRequestDelete={noop}
    onTextSelectionDrop={async (payload, tag) => { window.auditActions.push({ payload, tag }); }}
    onTextSelectionDelete={async (payload) => { window.auditActions.push({ payload, deleted: true }); }} />
) : (
  <SearchOverlay open query="" vaultPath="/tmp/fixture" tags={tags}
    onQueryChange={noop} onClose={noop} onOpenBlock={noop} onToggleTag={noop}
    onCreateAndAssign={noop} loadBlockTags={async () => new Map([[block.slug, []]])} />
));
