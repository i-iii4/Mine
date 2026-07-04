import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { forceCollide } from "d3-force";
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from "react-force-graph-2d";
import { getBlock, listGraphSnapshot } from "@/lib/commands";
import { collectionRefLabel } from "@/lib/collections";
import { legacyThumbsRoot, thumbnailUrl } from "@/lib/assets";
import { parsePreviewManifest } from "@/lib/cardLayout";
import { getHoverPreviewOpenDelay } from "@/lib/hoverPreviewTiming";
import { ReadOnlyCardPreview } from "./Card";
import type { GraphLink, GraphNode, GraphSnapshot, IndexedBlock, LightBlock } from "@/types";

type GraphCanvasNode = GraphNode & NodeObject<GraphNode>;
type PositionedGraphCanvasNode = GraphCanvasNode & { x: number; y: number };
type GraphCanvasLink = Omit<GraphLink, "source" | "target"> &
  LinkObject<GraphCanvasNode, GraphLink> & {
    source: string | GraphCanvasNode;
    target: string | GraphCanvasNode;
  };

type GraphCanvasData = {
  nodes: GraphCanvasNode[];
  links: GraphCanvasLink[];
};

type GraphPreviewTarget = {
  nodeId: string;
  slug: string;
};

type GraphPreviewPosition = {
  top: number;
  left: number;
};

type GraphCardMenuPoint = {
  x: number;
  y: number;
};

type GraphPalette = {
  cardFill: string;
  linkDefault: string;
};

type GraphCanvasTheme = GraphPalette & {
  chromeFill: string;
  border: string;
  mutedText: string;
  foregroundText: string;
  hoverOutline: string;
};

interface GraphChargeForce {
  strength(accessor: (node: GraphCanvasNode) => number): GraphChargeForce;
  distanceMax(distance: number): GraphChargeForce;
}

interface GraphCenterForce {
  strength(strength: number): GraphCenterForce;
}

interface GraphLinkDistanceForce {
  distance(accessor: (link: GraphCanvasLink) => number): GraphLinkDistanceForce;
}

interface GraphForce {
  (alpha: number): void;
  initialize?: (nodes: GraphCanvasNode[], ...args: unknown[]) => void;
}

interface GraphViewProps {
  currentCollection?: string;
  vaultPath: string;
  thumbsRootPath?: string;
  loadedBlocks: LightBlock[];
  thumbVersions: ReadonlyMap<string, number>;
  hoverPreviewFrozen?: boolean;
  onOpenBlock: (block: LightBlock | IndexedBlock) => void;
  onOpenCardMenu: (block: LightBlock | IndexedBlock, point: GraphCardMenuPoint) => void;
  onNavigateCollection: (collectionRef?: string) => void;
}

const CARD_THUMBNAIL_SIZE = 32;
const CARD_COLLISION_RADIUS = 22;
const COLLECTION_FONT_SIZE = 14;
const COLLECTION_PAD_X = 12;
const COLLECTION_HEIGHT = 28;
const COLLECTION_LABEL_GAP = 2;
const COLLECTION_LABEL_CLICK_SUPPRESS_MS = 400;
const COLLECTION_LABEL_COLLISION_ITERATIONS = 6;
const COLLECTION_COLLISION_RADIUS = 48;
const GRAPH_PREVIEW_WIDTH = 240;
const GRAPH_PREVIEW_FALLBACK_HEIGHT = 320;
const GRAPH_PREVIEW_GAP = 8;
const GRAPH_PREVIEW_VIEWPORT_MARGIN = 16;

const GRAPH_PALETTE: Record<"light" | "dark", GraphPalette> = {
  dark: {
    cardFill: "#181818",
    linkDefault: "#282828",
  },
  light: {
    cardFill: "#f4f4f4",
    linkDefault: "#d8d8d8",
  },
};

function graphPhysics(nodeCount: number) {
  const scale = Math.max(1, Math.sqrt(nodeCount / 90));
  return {
    alphaDecay: 0.02,
    velocityDecay: 0.36,
    warmupTicks: 80,
    cooldownTime: 3500,
    chargeDistanceMax: 220 * scale,
    centerStrength: 0.035 / scale,
    cardCharge: -72 * scale,
    collectionCharge: -115 * scale,
    cardLinkDistance: 56 * scale,
    collectionLinkDistance: 76 * scale,
  };
}

export function GraphView({
  currentCollection,
  vaultPath,
  thumbsRootPath,
  loadedBlocks,
  thumbVersions,
  hoverPreviewFrozen = false,
  onOpenBlock,
  onOpenCardMenu,
  onNavigateCollection,
}: GraphViewProps) {
  const resolvedThumbsRoot = thumbsRootPath ?? legacyThumbsRoot(vaultPath);
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [theme, setTheme] = useState<"light" | "dark">(() => readGraphTheme());
  const [hoverPreviewTarget, setHoverPreviewTarget] = useState<GraphPreviewTarget | null>(null);
  const [hoverPreviewBlock, setHoverPreviewBlock] = useState<IndexedBlock | null>(null);
  const [hoverPreviewPosition, setHoverPreviewPosition] = useState<GraphPreviewPosition | null>(null);
  const [hoveredCollectionId, setHoveredCollectionId] = useState<string | null>(null);
  const [, setImageVersion] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<ForceGraphMethods<GraphCanvasNode, GraphCanvasLink> | undefined>(
    undefined,
  );
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const loadSequenceRef = useRef(0);
  const previewOpenTimerRef = useRef<number | null>(null);
  const lastPreviewOpenedAtRef = useRef<number | null>(null);
  const lastPointerPointRef = useRef<GraphCardMenuPoint | null>(null);
  const graphScaleRef = useRef(1);
  const collectionDragClickSuppressionRef = useRef<{ nodeId: string; until: number } | null>(null);
  const previousHoverPreviewFrozenRef = useRef(hoverPreviewFrozen);

  const loadedBlocksBySlug = useMemo(() => {
    return new Map(loadedBlocks.map((block) => [block.slug, block]));
  }, [loadedBlocks]);

  const canvasTheme = useMemo(() => readGraphCanvasTheme(theme), [theme]);

  const reloadSnapshot = useCallback(async () => {
    const sequence = ++loadSequenceRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await listGraphSnapshot(currentCollection);
      if (loadSequenceRef.current === sequence) {
        setSnapshot(next);
      }
    } catch (err) {
      if (loadSequenceRef.current === sequence) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (loadSequenceRef.current === sequence) {
        setLoading(false);
      }
    }
  }, [currentCollection]);

  useEffect(() => {
    void reloadSnapshot();
  }, [reloadSnapshot]);

  useEffect(() => {
    const handleVaultRefresh = () => {
      void reloadSnapshot();
    };
    window.addEventListener("vault-refreshed", handleVaultRefresh);
    return () => window.removeEventListener("vault-refreshed", handleVaultRefresh);
  }, [reloadSnapshot]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setTheme(readGraphTheme());
    media.addEventListener("change", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    update();
    return () => {
      media.removeEventListener("change", update);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const recordPointerPoint = (event: Event) => {
      const point = graphClientPointFromEvent(event);
      if (point) {
        lastPointerPointRef.current = point;
      }
    };
    window.addEventListener("pointermove", recordPointerPoint, true);
    window.addEventListener("pointerdown", recordPointerPoint, true);
    window.addEventListener("contextmenu", recordPointerPoint, true);
    return () => {
      window.removeEventListener("pointermove", recordPointerPoint, true);
      window.removeEventListener("pointerdown", recordPointerPoint, true);
      window.removeEventListener("contextmenu", recordPointerPoint, true);
    };
  }, []);

  const graphData = useMemo<GraphCanvasData>(() => {
    if (!snapshot) return { nodes: [], links: [] };
    return {
      nodes: snapshot.nodes
        .map((node) => ({ ...node }))
        .sort(compareGraphNodePaintOrder),
      links: snapshot.links.map((link) => ({ ...link })),
    };
  }, [snapshot]);

  useEffect(() => {
    const cache = imageCacheRef.current;
    for (const node of graphData.nodes) {
      if (node.kind !== "card" || !node.slug) continue;
      const url = graphThumbnailUrl(resolvedThumbsRoot, node.slug, thumbVersions.get(node.slug) ?? 0);
      if (cache.has(url)) continue;

      const image = new Image();
      image.onload = () => {
        cache.set(url, image);
        setImageVersion((value) => value + 1);
      };
      image.onerror = () => {};
      image.src = url;
    }
  }, [graphData.nodes, resolvedThumbsRoot, thumbVersions]);

  const syncGraphScale = useCallback((scale: number) => {
    graphScaleRef.current = Number.isFinite(scale) && scale > 0 ? scale : 1;
  }, []);

  const graphViewportReady = size.width > 0 && size.height > 0;

  useEffect(() => {
    if (!graphViewportReady || graphData.nodes.length === 0) return;
    let frame = 0;
    const applyForces = () => {
      const graph = graphRef.current;
      if (!graph) {
        frame = requestAnimationFrame(applyForces);
        return;
      }

      const physics = graphPhysics(graphData.nodes.length);
      const chargeForce = graph.d3Force("charge") as unknown as GraphChargeForce | undefined;
      chargeForce
        ?.strength((node) =>
          node.kind === "collection" ? physics.collectionCharge : physics.cardCharge,
        )
        ?.distanceMax(physics.chargeDistanceMax);

      const centerForce = graph.d3Force("center") as unknown as GraphCenterForce | undefined;
      centerForce?.strength(physics.centerStrength);

      const linkForce = graph.d3Force("link") as unknown as GraphLinkDistanceForce | undefined;
      linkForce?.distance((link) => {
        const source = endpointNode(link.source);
        const target = endpointNode(link.target);
        return source?.kind === "collection" || target?.kind === "collection"
          ? physics.collectionLinkDistance
          : physics.cardLinkDistance;
      });

      graph.d3Force(
        "collision",
        forceCollide<GraphCanvasNode>()
          .radius((node) =>
            node.kind === "collection" ? COLLECTION_COLLISION_RADIUS : CARD_COLLISION_RADIUS,
          )
          .strength(0.75)
          .iterations(2) as unknown as GraphForce,
      );

      graph.d3Force(
        "collection-label-collision",
        collectionLabelCollisionForce(() => graphScaleRef.current),
      );

      graph.zoomToFit(0, 40);
      syncGraphScale(graph.zoom());
      graph.d3ReheatSimulation();
    };
    frame = requestAnimationFrame(applyForces);
    return () => cancelAnimationFrame(frame);
  }, [graphData, graphViewportReady, size.width, size.height, syncGraphScale]);

  const clearPreviewOpenTimer = useCallback(() => {
    if (previewOpenTimerRef.current === null) return;
    window.clearTimeout(previewOpenTimerRef.current);
    previewOpenTimerRef.current = null;
  }, []);

  const closePreview = useCallback(() => {
    clearPreviewOpenTimer();
    setHoverPreviewTarget(null);
    setHoverPreviewBlock(null);
    setHoverPreviewPosition(null);
  }, [clearPreviewOpenTimer]);

  const openPreview = useCallback((node: GraphCanvasNode) => {
    if (node.kind !== "card" || !node.slug) return;
    setHoverPreviewTarget({
      nodeId: node.id,
      slug: node.slug,
    });
  }, []);

  const schedulePreviewOpen = useCallback((node: GraphCanvasNode) => {
    if (hoverPreviewFrozen) return;
    if (node.kind !== "card" || !node.slug) {
      closePreview();
      return;
    }

    clearPreviewOpenTimer();
    setHoverPreviewTarget(null);
    setHoverPreviewBlock(null);
    setHoverPreviewPosition(null);

    const delay = getHoverPreviewOpenDelay(lastPreviewOpenedAtRef.current);
    if (delay <= 0) {
      openPreview(node);
      return;
    }

    previewOpenTimerRef.current = window.setTimeout(() => {
      previewOpenTimerRef.current = null;
      openPreview(node);
    }, delay);
  }, [clearPreviewOpenTimer, closePreview, hoverPreviewFrozen, openPreview]);

  useEffect(() => () => {
    clearPreviewOpenTimer();
  }, [clearPreviewOpenTimer]);

  useEffect(() => {
    if (hoverPreviewFrozen) {
      clearPreviewOpenTimer();
    }
  }, [clearPreviewOpenTimer, hoverPreviewFrozen]);

  const pointerIsInsidePreviewNode = useCallback((target: GraphPreviewTarget) => {
    const point = lastPointerPointRef.current;
    const graph = graphRef.current;
    const container = containerRef.current;
    const node = graphData.nodes.find((candidate) => candidate.id === target.nodeId);
    if (!point || !graph || !container || !node || !hasNodePosition(node)) return false;

    const containerRect = container.getBoundingClientRect();
    const screenPoint = graph.graph2ScreenCoords(node.x, node.y);
    const left = containerRect.left + screenPoint.x - CARD_THUMBNAIL_SIZE / 2;
    const top = containerRect.top + screenPoint.y - CARD_THUMBNAIL_SIZE / 2;
    return point.x >= left
      && point.x <= left + CARD_THUMBNAIL_SIZE
      && point.y >= top
      && point.y <= top + CARD_THUMBNAIL_SIZE;
  }, [graphData.nodes]);

  useEffect(() => {
    const wasFrozen = previousHoverPreviewFrozenRef.current;
    previousHoverPreviewFrozenRef.current = hoverPreviewFrozen;
    if (!wasFrozen || hoverPreviewFrozen) return undefined;

    const frame = window.requestAnimationFrame(() => {
      graphRef.current?.d3ReheatSimulation();
    });
    if (hoverPreviewTarget && !pointerIsInsidePreviewNode(hoverPreviewTarget)) {
      closePreview();
    }
    return () => window.cancelAnimationFrame(frame);
  }, [closePreview, hoverPreviewFrozen, hoverPreviewTarget, pointerIsInsidePreviewNode]);

  useEffect(() => {
    if (!hoverPreviewTarget) {
      setHoverPreviewBlock(null);
      setHoverPreviewPosition(null);
      return;
    }

    let cancelled = false;
    setHoverPreviewBlock(null);
    setHoverPreviewPosition(computeGraphPreviewPosition(
      graphRef.current,
      containerRef.current,
      graphData.nodes.find((node) => node.id === hoverPreviewTarget.nodeId),
      previewRef.current?.getBoundingClientRect().height ?? GRAPH_PREVIEW_FALLBACK_HEIGHT,
    ));

    void getBlock(hoverPreviewTarget.slug)
      .then((block) => {
        if (cancelled) return;
        if (block) {
          lastPreviewOpenedAtRef.current = Date.now();
        }
        setHoverPreviewBlock(block);
      })
      .catch(() => {
        if (cancelled) return;
        setHoverPreviewBlock(null);
      });

    return () => {
      cancelled = true;
    };
  }, [graphData.nodes, hoverPreviewTarget]);

  useEffect(() => {
    if (!hoverPreviewTarget || !hoverPreviewBlock) return undefined;
    let frame = 0;
    let stopped = false;

    const updatePosition = () => {
      if (stopped) return;
      const nextPosition = computeGraphPreviewPosition(
        graphRef.current,
        containerRef.current,
        graphData.nodes.find((node) => node.id === hoverPreviewTarget.nodeId),
        previewRef.current?.getBoundingClientRect().height ?? GRAPH_PREVIEW_FALLBACK_HEIGHT,
      );
      setHoverPreviewPosition((current) => {
        if (!nextPosition) return null;
        if (
          current &&
          Math.abs(nextPosition.top - current.top) <= 1 &&
          Math.abs(nextPosition.left - current.left) <= 1
        ) {
          return current;
        }
        return nextPosition;
      });
      frame = window.requestAnimationFrame(updatePosition);
    };

    frame = window.requestAnimationFrame(updatePosition);
    return () => {
      stopped = true;
      window.cancelAnimationFrame(frame);
    };
  }, [graphData.nodes, hoverPreviewBlock, hoverPreviewTarget]);

  const handleNodeClick = useCallback(
    async (node: GraphCanvasNode) => {
      closePreview();
      if (node.kind === "collection") {
        const suppression = collectionDragClickSuppressionRef.current;
        if (
          suppression &&
          suppression.nodeId === node.id &&
          suppression.until >= Date.now()
        ) {
          return;
        }
        onNavigateCollection(node.collection_ref ?? undefined);
        return;
      }
      if (!node.slug) return;

      const loaded = loadedBlocksBySlug.get(node.slug);
      if (loaded) {
        onOpenBlock(loaded);
        return;
      }

      const full = await getBlock(node.slug);
      if (full) {
        onOpenBlock(full);
      }
    },
    [closePreview, loadedBlocksBySlug, onNavigateCollection, onOpenBlock],
  );

  const handleNodeRightClick = useCallback(
    async (node: GraphCanvasNode, event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (node.kind !== "card" || !node.slug) return;

      const point = { x: event.clientX, y: event.clientY };
      const loaded = loadedBlocksBySlug.get(node.slug);
      if (loaded) {
        onOpenCardMenu(loaded, point);
        return;
      }

      const full = await getBlock(node.slug);
      if (full) {
        onOpenCardMenu(full, point);
      }
    },
    [loadedBlocksBySlug, onOpenCardMenu],
  );

  const suppressCollectionClickAfterDrag = useCallback((node: GraphCanvasNode) => {
    if (node.kind !== "collection") return;
    collectionDragClickSuppressionRef.current = {
      nodeId: node.id,
      until: Date.now() + COLLECTION_LABEL_CLICK_SUPPRESS_MS,
    };
    closePreview();
  }, [closePreview]);

  const nodeCanvasObject = useCallback(
    (node: GraphCanvasNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      if (!hasNodePosition(node)) return;
      if (node.kind === "collection") {
        paintCollectionNode(ctx, node, {
          globalScale,
          theme: canvasTheme,
          hovered: hoveredCollectionId === node.id,
        });
        return;
      }
      paintCardNode(ctx, node, {
        globalScale,
        theme,
        imageCache: imageCacheRef.current,
        thumbsRootPath: resolvedThumbsRoot,
        thumbVersion: node.slug ? thumbVersions.get(node.slug) ?? 0 : 0,
      });
    },
    [canvasTheme, hoveredCollectionId, resolvedThumbsRoot, theme, thumbVersions],
  );

  const nodePointerAreaPaint = useCallback(
    (node: GraphCanvasNode, color: string, ctx: CanvasRenderingContext2D, globalScale: number) => {
      if (!hasNodePosition(node)) return;
      ctx.fillStyle = color;
      if (node.kind === "collection") {
        const box = collectionPillBox(node, globalScale);
        roundedRectPath(ctx, box.x, box.y, box.width, box.height, box.radius);
        ctx.fill();
        return;
      }
      const size = CARD_THUMBNAIL_SIZE / globalScale;
      ctx.fillRect(node.x - size / 2, node.y - size / 2, size, size);
    },
    [],
  );

  const physics = graphPhysics(graphData.nodes.length);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden bg-background"
      onContextMenu={(event) => event.preventDefault()}
      data-graph-view=""
    >
      {error ? (
        <div className="absolute inset-0 grid place-items-center px-8 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {!error && graphData.nodes.length === 0 && !loading ? (
        <div className="absolute inset-0 grid place-items-center px-8 text-sm text-muted-foreground">
          No graph nodes
        </div>
      ) : null}
      {vaultPath && hoverPreviewPosition && hoverPreviewBlock ? (
        <div
          ref={previewRef}
          className="pointer-events-none fixed z-50"
          style={{
            top: hoverPreviewPosition.top,
            left: hoverPreviewPosition.left,
            width: GRAPH_PREVIEW_WIDTH,
          }}
          data-graph-card-hover-preview
        >
          <ReadOnlyCardPreview
            block={hoverPreviewBlock}
            vaultPath={vaultPath}
            thumbsRootPath={thumbsRootPath}
            width={GRAPH_PREVIEW_WIDTH}
            previewMode="micro"
          />
        </div>
      ) : null}
      {graphViewportReady ? (
        <ForceGraph2D<GraphCanvasNode, GraphCanvasLink>
          ref={graphRef}
          graphData={graphData}
          width={size.width}
          height={size.height}
          nodeId="id"
          linkSource="source"
          linkTarget="target"
          nodeCanvasObject={nodeCanvasObject}
          nodePointerAreaPaint={nodePointerAreaPaint}
          nodeLabel={() => ""}
          onNodeClick={handleNodeClick}
          onNodeRightClick={handleNodeRightClick}
          onNodeHover={(node) => {
            if (hoverPreviewFrozen) return;
            if (!node) {
              setHoveredCollectionId(null);
              closePreview();
              return;
            }
            if (node.kind === "collection") {
              setHoveredCollectionId(node.id);
              closePreview();
              return;
            }
            setHoveredCollectionId(null);
            schedulePreviewOpen(node);
          }}
          onNodeDrag={suppressCollectionClickAfterDrag}
          onNodeDragEnd={suppressCollectionClickAfterDrag}
          d3AlphaDecay={physics.alphaDecay}
          d3VelocityDecay={physics.velocityDecay}
          warmupTicks={physics.warmupTicks}
          cooldownTime={physics.cooldownTime}
          onZoom={(transform) => syncGraphScale(transform.k)}
          onZoomEnd={(transform) => syncGraphScale(transform.k)}
          backgroundColor="transparent"
          linkDirectionalArrowLength={0}
          linkColor={() => canvasTheme.linkDefault}
          linkWidth={1}
        />
      ) : null}
    </div>
  );
}

function endpointNode(endpoint: unknown): GraphCanvasNode | null {
  if (endpoint && typeof endpoint === "object" && "kind" in endpoint) {
    return endpoint as GraphCanvasNode;
  }
  return null;
}

function hasNodePosition(node: GraphCanvasNode): node is PositionedGraphCanvasNode {
  return Number.isFinite(node.x) && Number.isFinite(node.y);
}

function compareGraphNodePaintOrder(a: GraphCanvasNode, b: GraphCanvasNode): number {
  return graphNodePaintOrder(a) - graphNodePaintOrder(b);
}

function graphNodePaintOrder(node: GraphCanvasNode): number {
  return node.kind === "collection" ? 1 : 0;
}

function collectionLabelCollisionForce(getScale: () => number): GraphForce {
  let nodes: GraphCanvasNode[] = [];

  const force: GraphForce = () => {
    const scale = Math.max(0.1, getScale());
    const labels = nodes.filter((node): node is PositionedGraphCanvasNode => (
      node.kind === "collection" && hasNodePosition(node)
    ));
    if (labels.length < 2) return;

    const dimensions = new Map(
      labels.map((node) => {
        const box = collectionPillBox(node, scale);
        return [node.id, { width: box.width, height: box.height }];
      }),
    );
    const gap = COLLECTION_LABEL_GAP / scale;

    for (let iteration = 0; iteration < COLLECTION_LABEL_COLLISION_ITERATIONS; iteration += 1) {
      for (let index = 0; index < labels.length; index += 1) {
        for (let otherIndex = index + 1; otherIndex < labels.length; otherIndex += 1) {
          const a = labels[index];
          const b = labels[otherIndex];
          if (!a || !b) continue;

          const aDimensions = dimensions.get(a.id);
          const bDimensions = dimensions.get(b.id);
          if (!aDimensions || !bDimensions) continue;

          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const overlapX = (aDimensions.width + bDimensions.width) / 2 + gap - Math.abs(dx);
          const overlapY = (aDimensions.height + bDimensions.height) / 2 + gap - Math.abs(dy);
          if (overlapX <= 0 || overlapY <= 0) continue;

          if (overlapX <= overlapY) {
            separateLabelPair(a, b, "x", overlapX, separationSign(dx, a.id, b.id));
          } else {
            separateLabelPair(a, b, "y", overlapY, separationSign(dy, a.id, b.id));
          }
        }
      }
    }
  };

  force.initialize = (nextNodes) => {
    nodes = nextNodes;
  };

  return force;
}

function separateLabelPair(
  a: PositionedGraphCanvasNode,
  b: PositionedGraphCanvasNode,
  axis: "x" | "y",
  overlap: number,
  sign: -1 | 1,
) {
  const aPinned = isNodePinnedOnAxis(a, axis);
  const bPinned = isNodePinnedOnAxis(b, axis);
  if (aPinned && bPinned) return;

  if (aPinned) {
    moveCollisionNode(b, axis, sign * overlap);
    return;
  }
  if (bPinned) {
    moveCollisionNode(a, axis, -sign * overlap);
    return;
  }

  moveCollisionNode(a, axis, -sign * overlap / 2);
  moveCollisionNode(b, axis, sign * overlap / 2);
}

function moveCollisionNode(node: PositionedGraphCanvasNode, axis: "x" | "y", delta: number) {
  node[axis] += delta;
  const velocityAxis = axis === "x" ? "vx" : "vy";
  const currentVelocity = node[velocityAxis];
  if (typeof currentVelocity === "number" && Number.isFinite(currentVelocity)) {
    node[velocityAxis] = currentVelocity * 0.35;
  }
}

function isNodePinnedOnAxis(node: GraphCanvasNode, axis: "x" | "y"): boolean {
  const pinnedValue = axis === "x" ? node.fx : node.fy;
  return Number.isFinite(pinnedValue);
}

function separationSign(delta: number, idA: string, idB: string): -1 | 1 {
  if (delta < 0) return -1;
  if (delta > 0) return 1;
  return idA < idB ? 1 : -1;
}

function computeGraphPreviewPosition(
  graph: ForceGraphMethods<GraphCanvasNode, GraphCanvasLink> | undefined,
  container: HTMLElement | null,
  node: GraphCanvasNode | undefined,
  previewHeight: number,
): GraphPreviewPosition | null {
  if (!graph || !container || !node || !hasNodePosition(node)) return null;

  const containerRect = container.getBoundingClientRect();
  const screenPoint = graph.graph2ScreenCoords(node.x, node.y);
  const triggerLeft = containerRect.left + screenPoint.x - CARD_THUMBNAIL_SIZE / 2;
  const triggerTop = containerRect.top + screenPoint.y - CARD_THUMBNAIL_SIZE / 2;
  const triggerBottom = triggerTop + CARD_THUMBNAIL_SIZE;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const left = Math.max(
    GRAPH_PREVIEW_VIEWPORT_MARGIN,
    Math.min(
      triggerLeft,
      viewportWidth - GRAPH_PREVIEW_VIEWPORT_MARGIN - GRAPH_PREVIEW_WIDTH,
    ),
  );
  const canOpenDown =
    triggerBottom + GRAPH_PREVIEW_GAP + previewHeight <=
    viewportHeight - GRAPH_PREVIEW_VIEWPORT_MARGIN;
  const top = canOpenDown
    ? triggerBottom + GRAPH_PREVIEW_GAP
    : Math.max(
        GRAPH_PREVIEW_VIEWPORT_MARGIN,
        triggerTop - GRAPH_PREVIEW_GAP - previewHeight,
      );

  return { top, left };
}

function graphClientPointFromEvent(event: Event): GraphCardMenuPoint | null {
  if (!(event instanceof MouseEvent)) return null;
  return { x: event.clientX, y: event.clientY };
}

function graphThumbnailUrl(thumbsRootPath: string, slug: string, thumbVersion: number): string {
  const cacheBuster = thumbVersion > 0 ? `?v=${thumbVersion}` : "";
  return `${thumbnailUrl(thumbsRootPath, slug)}${cacheBuster}`;
}

function paintCardNode(
  ctx: CanvasRenderingContext2D,
  node: PositionedGraphCanvasNode,
  options: {
    globalScale: number;
    theme: "light" | "dark";
    imageCache: Map<string, HTMLImageElement>;
    thumbsRootPath: string;
    thumbVersion: number;
  },
) {
  const palette = GRAPH_PALETTE[options.theme];
  const size = CARD_THUMBNAIL_SIZE / options.globalScale;
  const x = node.x - size / 2;
  const y = node.y - size / 2;

  const imageUrl = node.slug
    ? graphThumbnailUrl(options.thumbsRootPath, node.slug, options.thumbVersion)
    : null;
  const image = imageUrl ? options.imageCache.get(imageUrl) : null;

  ctx.beginPath();
  ctx.rect(x, y, size, size);
  if (image) {
    ctx.save();
    ctx.clip();
    if (isTextPreview(node) && options.theme === "dark") {
      ctx.filter = "invert(1)";
    }
    drawImageCover(ctx, image, x, y, size, size);
    ctx.restore();
    ctx.filter = "none";
  } else {
    ctx.fillStyle = palette.cardFill;
    ctx.fillRect(x, y, size, size);
  }
}

function paintCollectionNode(
  ctx: CanvasRenderingContext2D,
  node: PositionedGraphCanvasNode,
  options: {
    globalScale: number;
    theme: GraphCanvasTheme;
    hovered: boolean;
  },
) {
  const label = collectionLabel(node);
  const width = measureCollectionLabelWidth(label);
  const x = -width / 2;
  const y = -COLLECTION_HEIGHT / 2;

  ctx.save();
  ctx.translate(node.x, node.y);
  ctx.scale(1 / options.globalScale, 1 / options.globalScale);
  roundedRectPath(ctx, x, y, width, COLLECTION_HEIGHT, COLLECTION_HEIGHT / 2);
  ctx.fillStyle = options.theme.chromeFill;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = options.hovered ? options.theme.hoverOutline : options.theme.border;
  ctx.stroke();

  ctx.font = `400 ${COLLECTION_FONT_SIZE}px system-ui, -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = options.hovered ? options.theme.foregroundText : options.theme.mutedText;
  ctx.fillText(label, 0, 0, width - COLLECTION_PAD_X * 2);
  ctx.restore();
}

function collectionPillBox(
  node: PositionedGraphCanvasNode,
  globalScale: number,
) {
  const height = COLLECTION_HEIGHT / globalScale;
  const width = measureCollectionLabelWidth(collectionLabel(node)) / globalScale;
  return {
    x: node.x - width / 2,
    y: node.y - height / 2,
    width,
    height,
    radius: height / 2,
  };
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function measureCollectionLabelWidth(label: string): number {
  if (typeof document === "undefined") {
    return Math.ceil(label.length * 7.5 + COLLECTION_PAD_X * 2 + 2);
  }

  const canvas = measureCollectionLabelWidth.canvas ?? document.createElement("canvas");
  measureCollectionLabelWidth.canvas = canvas;
  const context = canvas.getContext("2d");
  if (!context) {
    return Math.ceil(label.length * 7.5 + COLLECTION_PAD_X * 2 + 2);
  }

  context.font = `400 ${COLLECTION_FONT_SIZE}px system-ui, -apple-system, BlinkMacSystemFont, sans-serif`;
  return Math.ceil(context.measureText(label).width + COLLECTION_PAD_X * 2 + 2);
}

measureCollectionLabelWidth.canvas = null as HTMLCanvasElement | null;

function collectionLabel(node: GraphCanvasNode): string {
  return collectionRefLabel(node.collection_ref ?? node.label);
}

function isTextPreview(node: GraphCanvasNode): boolean {
  const manifest = parsePreviewManifest({ preview_manifest: node.preview_manifest });
  return manifest ? manifest.kind === "text" : false;
}

function drawImageCover(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const imageWidth = image.naturalWidth || image.width;
  const imageHeight = image.naturalHeight || image.height;
  if (imageWidth <= 0 || imageHeight <= 0) return;

  const scale = Math.max(width / imageWidth, height / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  ctx.drawImage(
    image,
    x + (width - drawWidth) / 2,
    y + (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

function readGraphTheme(): "light" | "dark" {
  if (typeof document === "undefined" || typeof window === "undefined") return "dark";
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "dark" || explicit === "light") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readGraphCanvasTheme(mode: "light" | "dark"): GraphCanvasTheme {
  const fallback = graphCanvasThemeFallback(mode);
  if (typeof document === "undefined" || !document.body) return fallback;

  const probe = document.createElement("span");
  probe.className = "bg-chrome";
  probe.style.position = "absolute";
  probe.style.pointerEvents = "none";
  probe.style.width = "0";
  probe.style.height = "0";
  probe.style.overflow = "hidden";
  probe.style.borderColor = "var(--border)";
  probe.style.borderStyle = "solid";
  probe.style.borderWidth = "1px";
  probe.style.outlineColor = "var(--component-fill-hover)";
  probe.style.outlineStyle = "solid";
  probe.style.outlineWidth = "1px";
  probe.style.color = "var(--muted-foreground)";
  document.body.appendChild(probe);

  const mutedStyle = getComputedStyle(probe);
  const chromeFill = resolvedCanvasColor(mutedStyle.backgroundColor, fallback.chromeFill);
  const border = resolvedCanvasColor(mutedStyle.borderTopColor, fallback.border);
  const mutedText = resolvedCanvasColor(mutedStyle.color, fallback.mutedText);
  const hoverOutline = resolvedCanvasColor(mutedStyle.outlineColor, fallback.hoverOutline);

  probe.style.color = "var(--foreground)";
  const foregroundText = resolvedCanvasColor(
    getComputedStyle(probe).color,
    fallback.foregroundText,
  );
  probe.remove();

  return {
    ...GRAPH_PALETTE[mode],
    chromeFill,
    border,
    mutedText,
    foregroundText,
    hoverOutline,
  };
}

function graphCanvasThemeFallback(mode: "light" | "dark"): GraphCanvasTheme {
  return mode === "dark"
    ? {
        ...GRAPH_PALETTE.dark,
        chromeFill: "#1a1a1a",
        border: "#2a2a2a",
        mutedText: "#9a9a9a",
        foregroundText: "#fafafa",
        hoverOutline: "#343434",
      }
    : {
        ...GRAPH_PALETTE.light,
        chromeFill: "#fcfcfc",
        border: "#eeeeee",
        mutedText: "#777777",
        foregroundText: "#0a0a0a",
        hoverOutline: "#e7e7e7",
      };
}

function resolvedCanvasColor(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "rgba(0, 0, 0, 0)" || trimmed === "transparent") {
    return fallback;
  }
  return trimmed;
}
