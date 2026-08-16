import { useEffect, useMemo, useState } from "react";
import { Grid } from "@/components/Grid";
import { getStoredScrollEdgeFade } from "@/lib/scrollEdgeFade";
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
const AUDIT_SOURCE_ASSETS = Array.from(
  { length: AUDIT_MEDIA_ASSETS.length },
  (_, index) => `/__mine_forbidden_source__/original-${index}.png`,
);

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
    const assetIndex = (index + tileIndex) % AUDIT_MEDIA_ASSETS.length;
    return {
      source_path: AUDIT_SOURCE_ASSETS[assetIndex]!,
      preview_path: AUDIT_MEDIA_ASSETS[assetIndex]!,
      width: 960,
      height: 960,
      // Collage tiles are cropped into fixed slots, so the artifact is square
      // regardless of the source shape.
      preview_width: 320,
      preview_height: 320,
      is_video: false,
      is_video_poster: false,
    };
  });

  return JSON.stringify({
    kind: "composite",
    primary_preview_path: tiles[0]?.preview_path ?? null,
    width: 960,
    height: 960,
    preview_width: 640,
    preview_height: 640,
    tiles,
    overflow_count: 0,
  });
}

/// A single-media card whose source geometry contradicts its artifact
/// geometry. Layout must follow the artifact; a surface that derives its width
/// from a height reserved by some other ratio collapses away from the card
/// edge, which the audit measures.
function makeRatioMismatchBlock(index: number): LightBlock {
  const id = 100_000 + index;
  return {
    id,
    slug: `feed-scroll-audit-ratio-${id}`,
    card_kind: "media",
    block_type: "image",
    title: null,
    content_heading: null,
    display_title: null,
    fallback_label: `Ratio mismatch ${index + 1}`,
    url: null,
    media_file: AUDIT_MEDIA_ASSETS[index % AUDIT_MEDIA_ASSETS.length]!,
    thumbnail: null,
    saved_at: AUDIT_SAVED_AT,
    width: 800,
    height: 1200,
    author: null,
    body: "",
    preview_text: null,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: JSON.stringify({
      kind: "media",
      primary_preview_path: AUDIT_MEDIA_ASSETS[index % AUDIT_MEDIA_ASSETS.length]!,
      // Source claims one shape...
      width: 1200,
      height: 800,
      // ...the artifact on disk is another. The card follows the artifact.
      preview_width: 400,
      preview_height: 600,
      tiles: [],
      overflow_count: 0,
    }),
    feed_playback: null,
    search_match: null,
  };
}

/// An article card carrying a single image whose source geometry contradicts
/// its artifact geometry.
///
/// The media card above covers the same disagreement for `card_kind: media`.
/// This one covers the path that used to read the source instead: an article
/// laid out from a 1200×800 original while painting a 400×600 preview is
/// cropped by its own card, and the crop looks deliberate.
function makeArticleRatioMismatchBlock(index: number): LightBlock {
  const id = 300_000 + index;
  const asset = AUDIT_MEDIA_ASSETS[index % AUDIT_MEDIA_ASSETS.length]!;
  const source = AUDIT_SOURCE_ASSETS[index % AUDIT_SOURCE_ASSETS.length]!;
  return {
    id,
    slug: `feed-scroll-audit-article-ratio-${id}`,
    card_kind: "article",
    block_type: "article",
    title: `Article ratio mismatch ${index + 1}`,
    content_heading: null,
    display_title: null,
    fallback_label: `Article ratio mismatch ${index + 1}`,
    url: `https://example.test/feed-scroll-audit/article-ratio/${id}`,
    media_file: null,
    thumbnail: null,
    saved_at: AUDIT_SAVED_AT,
    width: null,
    height: null,
    author: null,
    body: "An article whose preview is a different shape than its original.",
    preview_text: "An article whose preview is a different shape than its original.",
    first_image: source,
    media_urls: JSON.stringify([source]),
    media_dimensions: JSON.stringify({ [source]: [1200, 800] }),
    preview_manifest: JSON.stringify({
      kind: "image",
      primary_preview_path: asset,
      // Source claims one shape...
      width: 1200,
      height: 800,
      // ...the artifact on disk is another. The card follows the artifact.
      preview_width: 400,
      preview_height: 600,
      tiles: [
        {
          source_path: source,
          preview_path: asset,
          width: 1200,
          height: 800,
          preview_width: 400,
          preview_height: 600,
          is_video: false,
          is_video_poster: false,
        },
      ],
      overflow_count: 0,
    }),
    feed_playback: null,
    search_match: null,
  };
}

function makeAuditBlock(index: number): LightBlock {
  if (index % 37 === 5) return makeRatioMismatchBlock(index);
  if (index % 37 === 11) return makeArticleRatioMismatchBlock(index);
  const id = 100_000 + index;
  const metadataOnlyLink = index % 23 === 0;
  const body = metadataOnlyLink ? "" : auditBodies[index % auditBodies.length];
  const previewManifest = metadataOnlyLink
    ? JSON.stringify({
        kind: "text",
        primary_preview_path: null,
        width: null,
        height: null,
        tiles: [],
        overflow_count: 0,
      })
    : makeAuditPreviewManifest(index);
  const repeatedBody = Array.from(
    { length: 1 + (index % 4) },
    (_, partIndex) => `${body} Segment ${partIndex + 1}.`,
  ).join(" ").trim();

  return {
    id,
    slug: metadataOnlyLink
      ? `feed-scroll-audit-link-${id}`
      : `feed-scroll-audit-${id}`,
    card_kind: metadataOnlyLink ? "link" : "article",
    block_type: metadataOnlyLink ? "link" : "article",
    title: metadataOnlyLink ? `AI 2027 link ${index + 1}` : `Feed scroll audit ${index + 1}`,
    content_heading: null,
    display_title: null,
    fallback_label: metadataOnlyLink ? `AI 2027 link ${index + 1}` : `Feed scroll audit ${index + 1}`,
    url: `https://example.test/feed-scroll-audit/${id}`,
    media_file: null,
    thumbnail: null,
    saved_at: AUDIT_SAVED_AT,
    width: null,
    height: null,
    author: index % 3 === 0 ? "Mine audit" : null,
    body: repeatedBody,
    preview_text: metadataOnlyLink ? null : repeatedBody,
    first_image: !metadataOnlyLink && previewManifest ? AUDIT_SOURCE_ASSETS[index % AUDIT_SOURCE_ASSETS.length]! : null,
    media_urls: !metadataOnlyLink && previewManifest ? JSON.stringify(AUDIT_SOURCE_ASSETS.slice(0, 2)) : null,
    media_dimensions: !metadataOnlyLink && previewManifest
      ? JSON.stringify(Object.fromEntries(AUDIT_SOURCE_ASSETS.map((asset) => [asset, [960, 960]])))
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

  const [scrollEdgeFade] = useState(getStoredScrollEdgeFade);

  return (
    <main
      className="h-screen w-screen overflow-hidden bg-background text-foreground"
      data-feed-scroll-audit-route=""
      data-feed-scroll-audit-edge-fade={scrollEdgeFade ? "true" : "false"}
    >
      <Grid
        blocks={blocks}
        vaultPath={AUDIT_VAULT_PATH}
        thumbsRootPath=""
        tags={[]}
        currentTag={undefined}
        scrollToTop={0}
        keyboardNavigationDisabled
        heightDriftAuditMode
        // Read the real preference so the scroll performance gate can measure
        // the feed with the top fade mask active, not only with it off.
        scrollEdgeFade={scrollEdgeFade}
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
