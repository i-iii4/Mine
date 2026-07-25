import { useCallback, useEffect, useMemo, useState } from "react";
import { GraphView } from "@/components/GraphView";
import type {
  GraphLink,
  GraphNode,
  GraphOptions,
  GraphScope,
  GraphSnapshot,
  LightBlock,
} from "@/types";

declare global {
  interface Window {
    __MINE_GRAPH_AUDIT__?: {
      loadCount: number;
      mountedAtMs: number;
      lastScope: GraphScope | null;
      lastOptions: GraphOptions | null;
      activatedSlug: string | null;
    };
  }
}

const AUDIT_CARD_COUNT = 48;
const AUDIT_COLLECTIONS = [
  "Design",
  "Typography",
  "Research",
  "Interfaces",
  "Archives",
  "Systems",
] as const;
const AUDIT_VAULT_PATH = "/tmp/mine-graph-audit";
const AUDIT_THUMBS_PATH = "/graph-audit/thumbs";
const AUDIT_GRAPH_PREFERENCES = {
  include_collections: true,
  include_wikilinks: true,
  include_related_notes: true,
} as const;

function auditBlock(index: number): LightBlock {
  const slug = `graph-card-${index}`;
  return {
    id: 200_000 + index,
    slug,
    card_kind: index % 4 === 0 ? "media" : "article",
    block_type: index % 4 === 0 ? "image" : "article",
    title: `Graph audit card ${index + 1}`,
    content_heading: null,
    display_title: null,
    fallback_label: `Graph audit card ${index + 1}`,
    url: `https://example.test/graph/${index}`,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-07-10T00:00:00Z",
    width: 960,
    height: 960,
    author: index % 3 === 0 ? "Mine audit" : null,
    body: `Deterministic graph audit content ${index + 1}.`,
    preview_text: `Deterministic graph audit content ${index + 1}.`,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: JSON.stringify({
      kind: "image",
      primary_preview_path: `${slug}.preview-0.jpg`,
      width: 960,
      height: 960,
      tiles: [],
      overflow_count: 0,
    }),
    feed_playback: null,
    search_match: null,
  };
}

function auditCardNode(block: LightBlock): GraphNode {
  return {
    id: `card:${block.slug}`,
    kind: "card",
    label: block.title ?? block.slug,
    slug: block.slug,
    collection_ref: null,
    card_kind: block.card_kind,
    block_type: block.block_type,
    thumbnail: null,
    preview_manifest: block.preview_manifest,
    degree: 0,
  };
}

function auditCollectionNode(collection: string): GraphNode {
  return {
    id: `collection:${collection}`,
    kind: "collection",
    label: collection,
    slug: null,
    collection_ref: collection,
    card_kind: null,
    block_type: null,
    thumbnail: null,
    preview_manifest: null,
    degree: 0,
  };
}

function auditLinks(blocks: LightBlock[]): GraphLink[] {
  const links: GraphLink[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    const collection = AUDIT_COLLECTIONS[index % AUDIT_COLLECTIONS.length]!;
    links.push({
      id: `membership:${collection}:${block.slug}`,
      kind: "collection_membership",
      source: `collection:${collection}`,
      target: `card:${block.slug}`,
      directed: false,
      count: 1,
      target_ref: null,
    });
    const next = blocks[(index + 1) % blocks.length]!;
    links.push({
      id: `wikilink:${block.slug}:${next.slug}`,
      kind: "wikilink",
      source: `card:${block.slug}`,
      target: `card:${next.slug}`,
      directed: true,
      count: 1,
      target_ref: next.slug,
    });
    if (index % 3 === 0) {
      const related = blocks[(index + 7) % blocks.length]!;
      links.push({
        id: `related:${block.slug}:${related.slug}`,
        kind: "related_note",
        source: `card:${block.slug}`,
        target: `card:${related.slug}`,
        directed: true,
        count: 1,
        target_ref: `${related.slug}#audit`,
      });
    }
  }
  return links;
}

function graphAuditSnapshot(
  blocks: LightBlock[],
  scope: GraphScope,
  options: GraphOptions,
): GraphSnapshot {
  const allNodes = [
    ...blocks.map(auditCardNode),
    ...AUDIT_COLLECTIONS.map(auditCollectionNode),
  ];
  const allLinks = auditLinks(blocks).filter((link) => {
    if (link.kind === "collection_membership") return options.include_collections;
    if (link.kind === "wikilink") return options.include_wikilinks;
    return options.include_related_notes;
  });

  let selected = new Set(allNodes.map((node) => node.id));
  if (scope.kind === "current_route" && scope.collection_ref) {
    const collectionId = `collection:${scope.collection_ref}`;
    selected = new Set([collectionId]);
    for (const link of allLinks) {
      if (link.source === collectionId) selected.add(link.target);
    }
  }

  if (!options.include_collections) {
    for (const node of allNodes) {
      if (node.kind === "collection") selected.delete(node.id);
    }
  }

  const links = allLinks.filter((link) => selected.has(link.source) && selected.has(link.target));
  const degrees = new Map<string, number>();
  for (const link of links) {
    degrees.set(link.source, (degrees.get(link.source) ?? 0) + 1);
    degrees.set(link.target, (degrees.get(link.target) ?? 0) + 1);
  }
  const nodes = allNodes
    .filter((node) => selected.has(node.id))
    .map((node) => ({ ...node, degree: degrees.get(node.id) ?? 0 }));
  const libraryScope = scope.kind === "library";

  return {
    generation: 1,
    nodes,
    links,
    total_cards: nodes.filter((node) => node.kind === "card").length,
    total_collections: nodes.filter((node) => node.kind === "collection").length,
    current_collection: scope.collection_ref,
    truncated: libraryScope,
    truncation_reason: libraryScope ? "large_library" : null,
    can_materialize_full: false,
    visible_nodes: nodes.length,
    visible_links: links.length,
    total_nodes: 8_000,
    total_links: 12_000,
  };
}

export function GraphAuditRoute() {
  const blocks = useMemo(
    () => Array.from({ length: AUDIT_CARD_COUNT }, (_, index) => auditBlock(index)),
    [],
  );
  const thumbVersions = useMemo(() => new Map<string, number>(), []);
  const [currentCollection, setCurrentCollection] = useState<string | undefined>(undefined);
  const [activatedSlug, setActivatedSlug] = useState<string | null>(null);

  const loadSnapshot = useCallback(async (scope: GraphScope, options: GraphOptions) => {
    const audit = window.__MINE_GRAPH_AUDIT__;
    if (audit) {
      audit.loadCount += 1;
      audit.lastScope = scope;
      audit.lastOptions = options;
    }
    return graphAuditSnapshot(blocks, scope, options);
  }, [blocks]);

  useEffect(() => {
    const requestedTheme = new URLSearchParams(window.location.search).get("theme");
    if (requestedTheme === "dark" || requestedTheme === "light") {
      document.documentElement.setAttribute("data-theme", requestedTheme);
    }
    window.__MINE_GRAPH_AUDIT__ = {
      loadCount: 0,
      mountedAtMs: performance.now(),
      lastScope: null,
      lastOptions: null,
      activatedSlug: null,
    };
    return () => {
      delete window.__MINE_GRAPH_AUDIT__;
    };
  }, []);

  useEffect(() => {
    if (window.__MINE_GRAPH_AUDIT__) {
      window.__MINE_GRAPH_AUDIT__.activatedSlug = activatedSlug;
    }
  }, [activatedSlug]);

  return (
    <main
      className="relative h-screen w-screen overflow-hidden bg-background text-foreground"
      data-graph-audit-route=""
    >
      <GraphView
        currentCollection={currentCollection}
        vaultPath={AUDIT_VAULT_PATH}
        thumbsRootPath={AUDIT_THUMBS_PATH}
        loadedBlocks={blocks}
        thumbVersions={thumbVersions}
        graphPreferences={AUDIT_GRAPH_PREFERENCES}
        loadSnapshot={loadSnapshot}
        onOpenBlock={(block) => setActivatedSlug(block.slug)}
        onOpenCardMenu={() => undefined}
        onNavigateCollection={(collectionRef) => setCurrentCollection(collectionRef)}
      />
      <button
        type="button"
        className="absolute right-3 bottom-3 z-30 h-7 border bg-chrome px-2 text-sm text-foreground"
        data-graph-audit-route-switch=""
        onClick={() => setCurrentCollection((current) => current ? undefined : "Design")}
      >
        {currentCollection ? "Library audit" : "Collection audit"}
      </button>
    </main>
  );
}
