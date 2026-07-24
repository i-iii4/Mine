import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { forceCollide } from "d3-force";
import { Search, SlidersHorizontal, X } from "lucide-react";
import ForceGraph2D, {
  type ForceGraphMethods,
} from "react-force-graph-2d";
import { getBlock, listGraphSnapshot } from "@/lib/commands";
import { fallbackThumbsRoot } from "@/lib/assets";
import { getHoverPreviewOpenDelay } from "@/lib/hoverPreviewTiming";
import { ReadOnlyCardPreview } from "./Card";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "./ui/segmented-control";
import type {
  GraphOptions,
  GraphScope,
  GraphScopeKind,
  GraphSnapshot,
  IndexedBlock,
  LightBlock,
  ProjectionRevision,
} from "@/types";
import {
  CARD_COLLISION_RADIUS,
  CARD_THUMBNAIL_SIZE,
  COLLECTION_COLLISION_RADIUS,
  COLLECTION_LABEL_CLICK_SUPPRESS_MS,
  GRAPH_BACKEND_SEARCH_DELAY_MS,
  GRAPH_CENTER_DURATION_MS,
  GRAPH_CENTER_MARGIN,
  GRAPH_INITIAL_FIT_DURATION_MS,
  GRAPH_INITIAL_FIT_TICKS,
  GRAPH_PREVIEW_FALLBACK_HEIGHT,
  GRAPH_PREVIEW_WIDTH,
  GRAPH_SEARCH_DIMMED_ALPHA,
  type GraphCanvasData,
  type GraphCanvasLink,
  type GraphCanvasNode,
  type GraphCardMenuPoint,
  type GraphCenterForce,
  type GraphChargeForce,
  type GraphForce,
  type GraphLinkDistanceForce,
  type GraphPreviewPosition,
  type GraphPreviewTarget,
  type GraphToggleOption,
} from "./graph/contracts";
import {
  paintCardNode,
  paintCollectionNode,
  paintUnresolvedNode,
  readGraphCanvasTheme,
  readGraphTheme,
  roundedRectPath,
  collectionPillBox,
} from "./graph/canvas";
import {
  canvasColorWithAlpha,
  compareGraphNodePaintOrder,
  computeGraphPreviewPosition,
  directionalGraphNode,
  endpointNode,
  graphClientPointFromEvent,
  graphEndpointId,
  graphNodeMatchesSearch,
  graphThumbnailUrl,
  hasNodePosition,
  isGraphArrowKey,
  normalizeGraphSearch,
} from "./graph/interaction";
import { collectionLabelCollisionForce, graphPhysics } from "./graph/physics";

export interface GraphViewProps {
  currentCollection?: string;
  vaultPath: string;
  thumbsRootPath?: string;
  loadedBlocks: LightBlock[];
  thumbVersions: ReadonlyMap<string, number>;
  hoverPreviewFrozen?: boolean;
  selectedSlug?: string | null;
  detailOpen?: boolean;
  loadSnapshot?: (scope: GraphScope, options: GraphOptions) => Promise<GraphSnapshot>;
  acceptSnapshotRevision?: (revision: ProjectionRevision) => boolean;
  onOpenBlock: (block: LightBlock | IndexedBlock) => void;
  onOpenCardMenu: (block: LightBlock | IndexedBlock, point: GraphCardMenuPoint) => void;
  onNavigateCollection: (collectionRef?: string) => void;
}

export interface GraphViewHandle {
  centerOnNode: (nodeId: string) => void;
}

const GRAPH_SCOPE_OPTIONS: readonly SegmentedControlOption<GraphScopeKind>[] = [
  { value: "current_route", label: "Route" },
  { value: "library", label: "Library" },
  { value: "ego", label: "Ego" },
];

const DEFAULT_GRAPH_OPTIONS: GraphOptions = {
  include_collections: true,
  include_wikilinks: true,
  include_related_notes: true,
  include_unresolved: false,
  materialize_large_library: false,
  query: null,
};

export const GraphView = forwardRef<GraphViewHandle, GraphViewProps>(function GraphView({
  currentCollection,
  vaultPath,
  thumbsRootPath,
  loadedBlocks,
  thumbVersions,
  hoverPreviewFrozen = false,
  selectedSlug = null,
  detailOpen = false,
  loadSnapshot = listGraphSnapshot,
  acceptSnapshotRevision,
  onOpenBlock,
  onOpenCardMenu,
  onNavigateCollection,
}: GraphViewProps, ref) {
  const resolvedThumbsRoot = thumbsRootPath ?? fallbackThumbsRoot(vaultPath);
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [theme, setTheme] = useState<"light" | "dark">(() => readGraphTheme());
  const [scopeKind, setScopeKind] = useState<GraphScopeKind>(() =>
    currentCollection ? "current_route" : "library",
  );
  const [graphOptions, setGraphOptions] = useState<GraphOptions>(DEFAULT_GRAPH_OPTIONS);
  const [searchQuery, setSearchQuery] = useState("");
  const [backendSearchQuery, setBackendSearchQuery] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoverPreviewTarget, setHoverPreviewTarget] = useState<GraphPreviewTarget | null>(null);
  const [hoverPreviewBlock, setHoverPreviewBlock] = useState<LightBlock | IndexedBlock | null>(null);
  const [hoverPreviewPosition, setHoverPreviewPosition] = useState<GraphPreviewPosition | null>(null);
  const [hoveredCollectionId, setHoveredCollectionId] = useState<string | null>(null);
  const [imageVersion, setImageVersion] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<ForceGraphMethods<GraphCanvasNode, GraphCanvasLink> | undefined>(
    undefined,
  );
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const loadSequenceRef = useRef(0);
  const acceptedRevisionRef = useRef<ProjectionRevision | null>(null);
  const previewOpenTimerRef = useRef<number | null>(null);
  const lastPreviewOpenedAtRef = useRef<number | null>(null);
  const lastPointerPointRef = useRef<GraphCardMenuPoint | null>(null);
  const graphScaleRef = useRef(1);
  const collectionDragClickSuppressionRef = useRef<{ nodeId: string; until: number } | null>(null);
  const previousHoverPreviewFrozenRef = useRef(hoverPreviewFrozen);
  const previousDetailOpenRef = useRef(detailOpen);
  const pendingCenterNodeIdRef = useRef<string | null>(null);
  const pendingFitTicksRef = useRef(0);

  const loadedBlocksBySlug = useMemo(() => {
    return new Map(loadedBlocks.map((block) => [block.slug, block]));
  }, [loadedBlocks]);

  const canvasTheme = useMemo(() => readGraphCanvasTheme(theme), [theme]);

  const normalizedSearch = useMemo(() => normalizeGraphSearch(searchQuery), [searchQuery]);
  const searchReady = normalizedSearch.alphanumericCount >= 2;
  const selectedCardSlug = selectedNodeId?.startsWith("card:")
    ? selectedNodeId.slice("card:".length)
    : null;
  const egoCenterSlug = selectedSlug ?? selectedCardSlug;
  const scopeCenterSlug = scopeKind === "ego" ? egoCenterSlug : null;
  const scope = useMemo<GraphScope>(() => ({
    kind: scopeKind,
    collection_ref: currentCollection ?? null,
    center_slug: scopeCenterSlug,
    hops: 1,
  }), [currentCollection, scopeCenterSlug, scopeKind]);
  const requestOptions = useMemo<GraphOptions>(() => ({
    ...graphOptions,
    query: backendSearchQuery,
  }), [backendSearchQuery, graphOptions]);

  const acceptRevision = useCallback((revision: ProjectionRevision) => {
    if (acceptSnapshotRevision) return acceptSnapshotRevision(revision);
    const current = acceptedRevisionRef.current;
    if (current !== null && revision < current) return false;
    acceptedRevisionRef.current = revision;
    return true;
  }, [acceptSnapshotRevision]);

  useEffect(() => {
    if (!snapshot?.truncated || !searchReady) {
      setBackendSearchQuery(null);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setBackendSearchQuery(normalizedSearch.value);
    }, GRAPH_BACKEND_SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [normalizedSearch.value, searchReady, snapshot?.truncated]);

  const reloadSnapshot = useCallback(async () => {
    const sequence = ++loadSequenceRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await loadSnapshot(scope, requestOptions);
      if (loadSequenceRef.current === sequence && acceptRevision(next.generation)) {
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
  }, [acceptRevision, loadSnapshot, requestOptions, scope]);

  useLayoutEffect(() => {
    setScopeKind(currentCollection ? "current_route" : "library");
  }, [currentCollection]);

  useEffect(() => {
    if (scopeKind === "ego" && !egoCenterSlug) {
      setScopeKind(currentCollection ? "current_route" : "library");
    }
  }, [currentCollection, egoCenterSlug, scopeKind]);

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

  const matchingNodeIds = useMemo(() => {
    if (!searchReady) return new Set<string>();
    return new Set(
      graphData.nodes
        .filter((node) => graphNodeMatchesSearch(node, normalizedSearch.value))
        .map((node) => node.id),
    );
  }, [graphData.nodes, normalizedSearch.value, searchReady]);

  const selectedNode = useMemo(
    () => graphData.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [graphData.nodes, selectedNodeId],
  );

  const availableScopeOptions = useMemo(() => GRAPH_SCOPE_OPTIONS.filter((option) => {
    if (option.value === "current_route") return Boolean(currentCollection);
    if (option.value === "ego") return Boolean(egoCenterSlug);
    return true;
  }), [currentCollection, egoCenterSlug]);

  const renderThumbnails = !(
    scopeKind === "library" && graphOptions.materialize_large_library
    && (snapshot?.total_nodes ?? 0) > 1_000
  );
  const graphViewportReady = size.width > 0 && size.height > 0;

  const centerNodeIfNeeded = useCallback((nodeId: string): boolean => {
    const graph = graphRef.current;
    const node = graphData.nodes.find((candidate) => candidate.id === nodeId);
    if (!graph || !node || !hasNodePosition(node) || size.width <= 0 || size.height <= 0) {
      return false;
    }

    const screen = graph.graph2ScreenCoords(node.x, node.y);
    const inside = screen.x >= GRAPH_CENTER_MARGIN
      && screen.x <= size.width - GRAPH_CENTER_MARGIN
      && screen.y >= GRAPH_CENTER_MARGIN
      && screen.y <= size.height - GRAPH_CENTER_MARGIN;
    if (!inside) {
      graph.centerAt(node.x, node.y, GRAPH_CENTER_DURATION_MS);
    }
    return true;
  }, [graphData.nodes, size.height, size.width]);

  useImperativeHandle(ref, () => ({
    centerOnNode(nodeId: string) {
      pendingCenterNodeIdRef.current = nodeId;
      if (!detailOpen && centerNodeIfNeeded(nodeId)) {
        pendingCenterNodeIdRef.current = null;
      }
    },
  }), [centerNodeIfNeeded, detailOpen]);

  useEffect(() => {
    if (!selectedSlug) return;
    const nodeId = `card:${selectedSlug}`;
    if (!graphData.nodes.some((node) => node.id === nodeId)) return;
    setSelectedNodeId(nodeId);
    pendingCenterNodeIdRef.current = nodeId;
  }, [graphData.nodes, selectedSlug]);

  useEffect(() => {
    const wasOpen = previousDetailOpenRef.current;
    previousDetailOpenRef.current = detailOpen;
    if (wasOpen && !detailOpen && selectedNodeId) {
      pendingCenterNodeIdRef.current = selectedNodeId;
    }
  }, [detailOpen, selectedNodeId]);

  useEffect(() => {
    const pendingNodeId = pendingCenterNodeIdRef.current;
    if (!pendingNodeId || detailOpen || !graphViewportReady) return undefined;
    const frame = window.requestAnimationFrame(() => {
      if (centerNodeIfNeeded(pendingNodeId)) {
        pendingCenterNodeIdRef.current = null;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    centerNodeIfNeeded,
    detailOpen,
    graphViewportReady,
    selectedNodeId,
    size.height,
    size.width,
  ]);

  useEffect(() => {
    if (!renderThumbnails) return;
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
  }, [graphData.nodes, renderThumbnails, resolvedThumbsRoot, thumbVersions]);

  const syncGraphScale = useCallback((scale: number) => {
    graphScaleRef.current = Number.isFinite(scale) && scale > 0 ? scale : 1;
  }, []);

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

      syncGraphScale(graph.zoom());
      pendingFitTicksRef.current = GRAPH_INITIAL_FIT_TICKS;
      graph.d3ReheatSimulation();
    };
    frame = requestAnimationFrame(applyForces);
    return () => cancelAnimationFrame(frame);
  }, [graphData, graphViewportReady, syncGraphScale]);

  const handleEngineTick = useCallback(() => {
    if (pendingFitTicksRef.current <= 0) return;
    pendingFitTicksRef.current -= 1;
    if (pendingFitTicksRef.current > 0) return;
    const graph = graphRef.current;
    if (!graph) return;
    graph.zoomToFit(GRAPH_INITIAL_FIT_DURATION_MS, 40);
  }, []);

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

    const loaded = loadedBlocksBySlug.get(hoverPreviewTarget.slug);
    if (loaded) {
      lastPreviewOpenedAtRef.current = Date.now();
      setHoverPreviewBlock(loaded);
      return () => {
        cancelled = true;
      };
    }

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
  }, [graphData.nodes, hoverPreviewTarget, loadedBlocksBySlug]);

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
      setSelectedNodeId(node.id);
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
      if (node.kind === "unresolved") return;
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
      setSelectedNodeId(node.id);

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

  const handleGraphKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (searchQuery) {
        event.preventDefault();
        event.stopPropagation();
        setSearchQuery("");
        return;
      }
      if (selectedNodeId) {
        event.preventDefault();
        event.stopPropagation();
        setSelectedNodeId(null);
      }
      return;
    }

    if (event.key === "Enter" && selectedNode) {
      event.preventDefault();
      event.stopPropagation();
      void handleNodeClick(selectedNode);
      return;
    }

    if (!isGraphArrowKey(event.key)) return;
    const next = directionalGraphNode(
      graphData.nodes,
      selectedNode,
      event.key,
      graphRef.current,
    );
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedNodeId(next.id);
    pendingCenterNodeIdRef.current = next.id;
  }, [graphData.nodes, handleNodeClick, searchQuery, selectedNode, selectedNodeId]);

  const handleSearchKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape" || !searchQuery) return;
    event.preventDefault();
    event.stopPropagation();
    setSearchQuery("");
  }, [searchQuery]);

  const updateGraphOption = useCallback(
    (key: GraphToggleOption, checked: boolean) => {
      setGraphOptions((current) => ({ ...current, [key]: checked }));
    },
    [],
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
      const dimmed = searchReady && !matchingNodeIds.has(node.id);
      const selected = selectedNodeId === node.id;
      const showLabel = selected || (searchReady && matchingNodeIds.has(node.id));
      ctx.save();
      if (dimmed) {
        ctx.globalAlpha *= GRAPH_SEARCH_DIMMED_ALPHA;
      }
      if (node.kind === "collection") {
        paintCollectionNode(ctx, node, {
          globalScale,
          theme: canvasTheme,
          hovered: hoveredCollectionId === node.id,
          selected,
        });
        ctx.restore();
        return;
      }
      if (node.kind === "unresolved") {
        paintUnresolvedNode(ctx, node, {
          globalScale,
          theme: canvasTheme,
          selected,
          showLabel,
        });
        ctx.restore();
        return;
      }
      paintCardNode(ctx, node, {
        globalScale,
        theme,
        canvasTheme,
        imageCache: imageCacheRef.current,
        thumbsRootPath: resolvedThumbsRoot,
        thumbVersion: node.slug ? thumbVersions.get(node.slug) ?? 0 : 0,
        renderThumbnail: renderThumbnails,
        selected,
        showLabel,
      });
      ctx.restore();
    },
    [
      canvasTheme,
      hoveredCollectionId,
      imageVersion,
      matchingNodeIds,
      renderThumbnails,
      resolvedThumbsRoot,
      searchReady,
      selectedNodeId,
      theme,
      thumbVersions,
    ],
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
      if (node.kind === "unresolved") {
        const radius = 5 / globalScale;
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      const size = CARD_THUMBNAIL_SIZE / globalScale;
      ctx.fillRect(node.x - size / 2, node.y - size / 2, size, size);
    },
    [],
  );

  const linkColor = useCallback((link: GraphCanvasLink) => {
    if (!searchReady) return canvasTheme.linkDefault;
    const sourceId = graphEndpointId(link.source);
    const targetId = graphEndpointId(link.target);
    if (
      (sourceId && matchingNodeIds.has(sourceId))
      || (targetId && matchingNodeIds.has(targetId))
    ) {
      return canvasTheme.linkDefault;
    }
    return canvasColorWithAlpha(canvasTheme.linkDefault, GRAPH_SEARCH_DIMMED_ALPHA);
  }, [canvasTheme.linkDefault, matchingNodeIds, searchReady]);

  const selectedStatus = selectedNode
    ? `${selectedNode.label}, ${selectedNode.degree} ${selectedNode.degree === 1 ? "neighbor" : "neighbors"}`
    : searchQuery && !searchReady
      ? "Graph search pending"
      : searchReady
        ? `${matchingNodeIds.size} graph ${matchingNodeIds.size === 1 ? "match" : "matches"}`
        : "";

  const physics = graphPhysics(graphData.nodes.length);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden bg-background"
      onContextMenu={(event) => event.preventDefault()}
      data-graph-view=""
    >
      <div
        className="absolute top-3 right-3 left-3 z-20 flex min-w-0 flex-wrap items-center gap-2"
        data-graph-controls=""
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      >
        <div className="relative w-[min(18rem,calc(100vw-8rem))] min-w-36">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-tertiary-foreground"
          />
          <Input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search graph"
            aria-label="Search graph"
            data-graph-search-state={searchQuery && !searchReady ? "pending" : "ready"}
            className="bg-chrome pr-8 pl-8"
          />
          {searchQuery ? (
            <button
              type="button"
              aria-label="Clear graph search"
              title="Clear graph search"
              className="absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-1 text-muted-foreground hover:text-foreground"
              onClick={() => setSearchQuery("")}
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          ) : null}
          {searchReady && matchingNodeIds.size === 0 && !loading ? (
            <div
              className="absolute top-full left-0 mt-1 border bg-chrome px-2 py-1 text-sm text-muted-foreground"
              data-graph-search-empty=""
            >
              No graph matches
            </div>
          ) : null}
        </div>

        {availableScopeOptions.length > 1 ? (
          <SegmentedControl
            value={scopeKind}
            options={availableScopeOptions}
            onChange={setScopeKind}
            aria-label="Graph scope"
          />
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="default"
              size="icon-xs"
              aria-label="Graph filters"
              title="Graph filters"
            >
              <SlidersHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuCheckboxItem
              checked={graphOptions.include_collections}
              onCheckedChange={(checked) => updateGraphOption("include_collections", checked)}
            >
              Collections
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={graphOptions.include_wikilinks}
              onCheckedChange={(checked) => updateGraphOption("include_wikilinks", checked)}
            >
              Wikilinks
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={graphOptions.include_related_notes}
              onCheckedChange={(checked) => updateGraphOption("include_related_notes", checked)}
            >
              Related notes
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={graphOptions.include_unresolved}
              onCheckedChange={(checked) => updateGraphOption("include_unresolved", checked)}
            >
              Unresolved
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {snapshot?.truncated
          && snapshot.can_materialize_full
          && !graphOptions.materialize_large_library ? (
            <Button
              type="button"
              variant="default"
              size="xs"
              onClick={() => setGraphOptions((current) => ({
                ...current,
                materialize_large_library: true,
              }))}
              data-graph-materialize-all=""
            >
              Show all
            </Button>
          ) : null}
      </div>

      <div className="sr-only" aria-live="polite" data-graph-selection-status="">
        {selectedStatus}
      </div>

      {error ? (
        <div className="absolute inset-0 z-10 grid place-items-center px-8 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {!error && graphData.nodes.length === 0 && !loading ? (
        <div className="absolute inset-0 z-10 grid place-items-center px-8 text-sm text-muted-foreground">
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
      <div
        className="absolute inset-0 outline-none focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring"
        tabIndex={0}
        role="group"
        aria-label="Graph canvas"
        data-graph-keyboard-surface=""
        onKeyDown={handleGraphKeyDown}
      >
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
            onBackgroundClick={() => {
              setSelectedNodeId(null);
              closePreview();
            }}
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
            onEngineTick={handleEngineTick}
            onZoom={(transform) => syncGraphScale(transform.k)}
            onZoomEnd={(transform) => syncGraphScale(transform.k)}
            backgroundColor="transparent"
            linkDirectionalArrowLength={(link) => link.directed ? 3 : 0}
            linkColor={linkColor}
            linkWidth={1}
          />
        ) : null}
      </div>
    </div>
  );
});
