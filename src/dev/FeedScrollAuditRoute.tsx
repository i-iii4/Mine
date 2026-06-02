import { useEffect, useMemo } from "react";
import { Grid } from "@/components/Grid";
import type { LightBlock } from "@/types";

declare global {
  interface Window {
    __MINE_FEED_SCROLL_AUDIT_ROUTE__?: {
      blockCount: number;
      mountedAtMs: number;
    };
  }
}

const AUDIT_BLOCK_COUNT = 720;
const AUDIT_VAULT_PATH = "/tmp/mine-feed-scroll-audit";
const AUDIT_SAVED_AT = "2026-05-24T00:00:00.000Z";
const AUDIT_MEDIA_ASSETS = [
  "/feed-scroll-audit/audit-0.svg",
  "/feed-scroll-audit/audit-1.svg",
  "/feed-scroll-audit/audit-2.svg",
  "/feed-scroll-audit/audit-3.svg",
  "/feed-scroll-audit/audit-4.svg",
  "/feed-scroll-audit/audit-5.svg",
];

const auditBodies = [
  "A compact article card with enough text to exercise normal feed wrapping and line-height measurement.",
  "A taller research note. It uses repeated prose, different word lengths and predictable text so the audit route produces real masonry height variation without loading source media.",
  "A dense clipping preview that should stay readable while the scrollport jumps across the generated feed. The card is intentionally text-only: the audit target is layout and paint readiness, not asset fidelity.",
  "Short reference.",
  "A long-form card. The paragraph is deliberately expanded to create a deeper masonry slot and to ensure the viewport has a mix of small, medium and tall cards during aggressive scroll jumps. This mirrors real collection feeds where article previews and media cards interleave with different heights.",
];

function makeAuditPreviewManifest(index: number): string | null {
  if (index % 3 === 1) return null;
  const tileCount = index % 4 === 0 ? 4 : 2;
  const tiles = Array.from({ length: tileCount }, (_, tileIndex) => {
    const asset = AUDIT_MEDIA_ASSETS[(index + tileIndex) % AUDIT_MEDIA_ASSETS.length]!;
    return {
      source_path: asset,
      preview_path: asset,
      width: 960,
      height: 960,
      is_video: false,
      is_video_poster: false,
    };
  });

  return JSON.stringify({
    kind: "composite",
    primary_preview_path: tiles[0]?.preview_path ?? null,
    width: 960,
    height: 960,
    tiles,
    overflow_count: 0,
  });
}

function makeAuditBlock(index: number): LightBlock {
  const id = 100_000 + index;
  const body = auditBodies[index % auditBodies.length];
  const previewManifest = makeAuditPreviewManifest(index);
  const repeatedBody = Array.from(
    { length: 1 + (index % 4) },
    (_, partIndex) => `${body} Segment ${partIndex + 1}.`,
  ).join(" ");

  return {
    id,
    slug: `feed-scroll-audit-${id}`,
    card_kind: "article",
    block_type: "article",
    title: `Feed scroll audit ${index + 1}`,
    content_heading: null,
    display_title: null,
    fallback_label: null,
    url: `https://example.test/feed-scroll-audit/${id}`,
    media_file: null,
    thumbnail: null,
    saved_at: AUDIT_SAVED_AT,
    width: null,
    height: null,
    author: index % 3 === 0 ? "Mine audit" : null,
    body: repeatedBody,
    preview_text: repeatedBody,
    first_image: previewManifest ? AUDIT_MEDIA_ASSETS[index % AUDIT_MEDIA_ASSETS.length]! : null,
    media_urls: previewManifest ? JSON.stringify(AUDIT_MEDIA_ASSETS.slice(0, 2)) : null,
    media_dimensions: previewManifest
      ? JSON.stringify(Object.fromEntries(AUDIT_MEDIA_ASSETS.map((asset) => [asset, [960, 960]])))
      : null,
    preview_manifest: previewManifest,
    feed_playback: null,
    search_match: null,
  };
}

function noop() {
  return undefined;
}

export function FeedScrollAuditRoute() {
  const blocks = useMemo(
    () => Array.from({ length: AUDIT_BLOCK_COUNT }, (_, index) => makeAuditBlock(index)),
    [],
  );

  useEffect(() => {
    window.__MINE_FEED_SCROLL_AUDIT_ROUTE__ = {
      blockCount: blocks.length,
      mountedAtMs: performance.now(),
    };
    return () => {
      delete window.__MINE_FEED_SCROLL_AUDIT_ROUTE__;
    };
  }, [blocks.length]);

  return (
    <main
      className="h-screen w-screen overflow-hidden bg-background text-foreground"
      data-feed-scroll-audit-route=""
    >
      <Grid
        blocks={blocks}
        vaultPath={AUDIT_VAULT_PATH}
        thumbsRootPath=""
        tags={[]}
        currentTag={undefined}
        scrollToTop={0}
        sidebarCollapsed={false}
        keyboardNavigationDisabled
        heightDriftAuditMode
        searchQuery=""
        onBlockClick={noop}
        onToggleTag={noop}
        onCreateAndAssign={noop}
        onLoadBlockTags={async () => new Map()}
        onBatchSetTag={noop}
        onCreateAndAssignBatch={noop}
        onDeleteSelectedBlocks={noop}
        onMergeSelectedBlocks={noop}
        onRequestRename={noop}
        onRequestDelete={noop}
      />
    </main>
  );
}
