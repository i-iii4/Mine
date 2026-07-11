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
  type LinkObject,
  type NodeObject,
} from "react-force-graph-2d";
import { getBlock, listGraphSnapshot } from "@/lib/commands";
import { collectionRefLabel } from "@/lib/collections";
import { fallbackThumbsRoot, thumbnailUrl } from "@/lib/assets";
import { parsePreviewManifest } from "@/lib/cardLayout";
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
  GraphLink,
  GraphNode,
  GraphOptions,
  GraphScope,
  GraphScopeKind,
  GraphSnapshot,
  IndexedBlock,
  LightBlock,
} from "@/types";

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

type GraphToggleOption =
  | "include_collections"
  | "include_wikilinks"
  | "include_related_notes"
  | "include_unresolved";

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
  onOpenBlock: (block: LightBlock | IndexedBlock) => void;
  onOpenCardMenu: (block: LightBlock | IndexedBlock, point: GraphCardMenuPoint) => void;
  onNavigateCollection: (collectionRef?: string) => void;
}

export interface GraphViewHandle {
  centerOnNode: (nodeId: string) => void;
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
const GRAPH_SEARCH_DIMMED_ALPHA = 0.15;
const GRAPH_BACKEND_SEARCH_DELAY_MS = 120;
const GRAPH_CENTER_MARGIN = 48;
const GRAPH_CENTER_DURATION_MS = 400;
const GRAPH_INITIAL_FIT_TICKS = 18;
const GRAPH_INITIAL_FIT_DURATION_MS = 250;

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
  }, [loadSnapshot, requestOptions, scope]);

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

function endpointNode(endpoint: unknown): GraphCanvasNode | null {
  if (endpoint && typeof endpoint === "object" && "kind" in endpoint) {
    return endpoint as GraphCanvasNode;
  }
  return null;
}

type GraphArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

function isGraphArrowKey(key: string): key is GraphArrowKey {
  return key === "ArrowUp"
    || key === "ArrowDown"
    || key === "ArrowLeft"
    || key === "ArrowRight";
}

function directionalGraphNode(
  nodes: GraphCanvasNode[],
  current: GraphCanvasNode | null,
  direction: GraphArrowKey,
  graph: ForceGraphMethods<GraphCanvasNode, GraphCanvasLink> | undefined,
): GraphCanvasNode | null {
  if (!graph) return null;
  const positioned = nodes.filter(hasNodePosition);
  if (positioned.length === 0) return null;
  if (!current || !hasNodePosition(current)) {
    return positioned
      .map((node) => ({ node, point: graph.graph2ScreenCoords(node.x, node.y) }))
      .sort((left, right) => left.point.y - right.point.y || left.point.x - right.point.x)[0]
      ?.node ?? null;
  }

  const origin = graph.graph2ScreenCoords(current.x, current.y);
  const vector = graphDirectionVector(direction);
  let best: { node: GraphCanvasNode; score: number } | null = null;
  for (const candidate of positioned) {
    if (candidate.id === current.id) continue;
    const point = graph.graph2ScreenCoords(candidate.x, candidate.y);
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    const projection = dx * vector.x + dy * vector.y;
    if (projection <= 0) continue;
    const perpendicular = Math.abs(dx * vector.y - dy * vector.x);
    const score = projection + perpendicular * 2;
    if (!best || score < best.score) {
      best = { node: candidate, score };
    }
  }
  return best?.node ?? null;
}

function graphDirectionVector(direction: GraphArrowKey): { x: number; y: number } {
  switch (direction) {
    case "ArrowUp":
      return { x: 0, y: -1 };
    case "ArrowDown":
      return { x: 0, y: 1 };
    case "ArrowLeft":
      return { x: -1, y: 0 };
    case "ArrowRight":
      return { x: 1, y: 0 };
  }
}

function normalizeGraphSearch(query: string): { value: string; alphanumericCount: number } {
  const value = query.trim().toLocaleLowerCase();
  return {
    value,
    alphanumericCount: Array.from(value).filter((character) => /[\p{L}\p{N}]/u.test(character))
      .length,
  };
}

function graphNodeMatchesSearch(node: GraphCanvasNode, query: string): boolean {
  return [node.label, node.slug, node.collection_ref, node.unresolved_ref]
    .some((value) => value?.toLocaleLowerCase().includes(query));
}

function graphEndpointId(endpoint: string | GraphCanvasNode): string | null {
  if (typeof endpoint === "string") return endpoint;
  return endpoint.id ?? null;
}

function canvasColorWithAlpha(color: string, alpha: number): string {
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const expanded = hex.length === 3
      ? hex.split("").map((digit) => `${digit}${digit}`).join("")
      : hex;
    const red = Number.parseInt(expanded.slice(0, 2), 16);
    const green = Number.parseInt(expanded.slice(2, 4), 16);
    const blue = Number.parseInt(expanded.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  const rgb = color.match(
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*[\d.]+)?\s*\)$/i,
  );
  if (!rgb) return color;
  return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
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
    canvasTheme: GraphCanvasTheme;
    imageCache: Map<string, HTMLImageElement>;
    thumbsRootPath: string;
    thumbVersion: number;
    renderThumbnail: boolean;
    selected: boolean;
    showLabel: boolean;
  },
) {
  const palette = GRAPH_PALETTE[options.theme];
  const size = CARD_THUMBNAIL_SIZE / options.globalScale;
  const x = node.x - size / 2;
  const y = node.y - size / 2;

  const imageUrl = node.slug
    ? graphThumbnailUrl(options.thumbsRootPath, node.slug, options.thumbVersion)
    : null;
  const image = options.renderThumbnail && imageUrl ? options.imageCache.get(imageUrl) : null;

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

  if (options.selected) {
    ctx.lineWidth = 2 / options.globalScale;
    ctx.strokeStyle = options.canvasTheme.hoverOutline;
    ctx.strokeRect(x, y, size, size);
  }
  if (options.showLabel) {
    paintScreenFixedLabel(ctx, node, options.globalScale, options.canvasTheme.foregroundText, size);
  }
}

function paintCollectionNode(
  ctx: CanvasRenderingContext2D,
  node: PositionedGraphCanvasNode,
  options: {
    globalScale: number;
    theme: GraphCanvasTheme;
    hovered: boolean;
    selected: boolean;
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
  ctx.lineWidth = options.selected ? 2 : 1;
  ctx.strokeStyle = options.hovered || options.selected
    ? options.theme.hoverOutline
    : options.theme.border;
  ctx.stroke();

  ctx.font = `400 ${COLLECTION_FONT_SIZE}px system-ui, -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = options.hovered ? options.theme.foregroundText : options.theme.mutedText;
  ctx.fillText(label, 0, 0, width - COLLECTION_PAD_X * 2);
  ctx.restore();
}

function paintUnresolvedNode(
  ctx: CanvasRenderingContext2D,
  node: PositionedGraphCanvasNode,
  options: {
    globalScale: number;
    theme: GraphCanvasTheme;
    selected: boolean;
    showLabel: boolean;
  },
) {
  const radius = 4 / options.globalScale;
  ctx.beginPath();
  ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = options.theme.mutedText;
  ctx.fill();
  if (options.selected) {
    ctx.lineWidth = 2 / options.globalScale;
    ctx.strokeStyle = options.theme.hoverOutline;
    ctx.stroke();
  }
  if (options.showLabel) {
    paintScreenFixedLabel(
      ctx,
      node,
      options.globalScale,
      options.theme.mutedText,
      radius * 2,
    );
  }
}

function paintScreenFixedLabel(
  ctx: CanvasRenderingContext2D,
  node: PositionedGraphCanvasNode,
  globalScale: number,
  color: string,
  nodeSize: number,
) {
  ctx.save();
  ctx.translate(node.x, node.y + nodeSize / 2);
  ctx.scale(1 / globalScale, 1 / globalScale);
  ctx.font = `400 ${COLLECTION_FONT_SIZE}px system-ui, -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = color;
  ctx.fillText(node.label, 0, 4, 180);
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
