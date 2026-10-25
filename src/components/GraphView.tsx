import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { forceCollide } from "d3-force";
import ForceGraph2D, {
  type ForceGraphMethods,
} from "react-force-graph-2d";
import { getBlock, listGraphSnapshot } from "@/lib/commands";
import { fallbackThumbsRoot } from "@/lib/assets";
import { useHoverIntent } from "@/hooks/useHoverIntent";
import { useHoverPreviewOpener } from "@/hooks/useHoverPreviewOpener";
import type { GraphPreferences } from "@/lib/graphPreferences";
import { GRAPH_CONTEXT_OPACITY } from "@/lib/colorLaw";
import { HOVER_INTENT } from "@/lib/hoverIntent";
import { ReadOnlyCardPreview } from "./Card";
import { Button } from "./ui/button";
import type {
  GraphOptions,
  GraphScope,
  GraphSnapshot,
  IndexedBlock,
  LightBlock,
  ProjectionRevision,
} from "@/types";
import {
  CARD_COLLISION_RADIUS,
  COLLECTION_COLLISION_RADIUS,
  COLLECTION_LABEL_CLICK_SUPPRESS_MS,
  GRAPH_CENTER_DURATION_MS,
  GRAPH_CENTER_MARGIN,
  GRAPH_INITIAL_FIT_DURATION_MS,
  GRAPH_ENTRY_ANGLE,
  GRAPH_ENTRY_SPREAD,
  GRAPH_INITIAL_FIT_TICKS,
  GRAPH_ZOOM_LEVEL_MARGIN_PX,
  type GraphCameraPlan,
  GRAPH_PREVIEW_FALLBACK_HEIGHT,
  GRAPH_PREVIEW_WIDTH,
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
} from "./graph/contracts";
import {
  cardCornerRadius,
  cardNodeImage,
  isTextPreview,
  paintCardNode,
  paintCollectionNode,
  readGraphCanvasTheme,
  readGraphTheme,
  roundedRectPath,
  collectionPillBox,
} from "./graph/canvas";
import {
  compareGraphNodePaintOrder,
  computeGraphPreviewPosition,
  endpointNode,
  graphClientPointFromEvent,
  graphThumbLevelFor,
  graphThumbnailUrl,
  graphZoomForExtent,
  hasNodePosition,
} from "./graph/interaction";
import { graphNodeScreenSize, graphZoomBounds } from "./graph/nodeSize";
import { animateCamera, type CameraTarget } from "./graph/cameraAnimation";
import { motionDuration } from "@/lib/motion";
import { coverPeekRect, registerPeekGraphSource, usePeekHiddenSlug } from "@/lib/cardPeek";
import { graphLinkCurvature, graphLinkLineDash } from "./graph/linkStyle";
import {
  beginDimTransition,
  colorAtOpacity,
  dimProgressAt,
  graphElementOpacity,
  graphHoverHighlight,
  restingDimTransition,
} from "./graph/hoverDim";
import {
  cardChargeFor,
  collectionLabelCollisionForce,
  graphPhysics,
  DRAG_VELOCITY_DECAY,
} from "./graph/physics";

export interface GraphViewProps {
  currentCollection?: string;
  vaultPath: string;
  thumbsRootPath?: string;
  loadedBlocks: LightBlock[];
  thumbVersions: ReadonlyMap<string, number>;
  graphPreferences: GraphPreferences;
  hoverPreviewFrozen?: boolean;
  selectedSlug?: string | null;
  detailOpen?: boolean;
  loadSnapshot?: (scope: GraphScope, options: GraphOptions) => Promise<GraphSnapshot>;
  acceptSnapshotRevision?: (revision: ProjectionRevision) => boolean;
  onOpenBlock: (block: LightBlock | IndexedBlock) => void;
  onOpenCardMenu: (block: LightBlock | IndexedBlock, point: GraphCardMenuPoint) => void;
  onNavigateCollection: (collectionRef?: string) => void;
  /// How to open the selected node, or null when nothing is selected, so the
  /// bottom bar can offer Focus only when there is something to open.
}

export interface GraphViewHandle {
  centerOnNode: (nodeId: string) => void;
}

const GRAPH_FIT_PADDING_PX = 40;

/// The camera that shows the whole graph with `padding` pixels around it,
/// as the library's own fit does, within the zoom bounds.
function fitCameraTarget(
  bbox: { x: [number, number]; y: [number, number] } | undefined,
  size: { width: number; height: number },
  padding: number,
  bounds: { min: number; max: number },
): CameraTarget | null {
  if (!bbox || size.width <= 0 || size.height <= 0) return null;
  const width = Math.max(1, bbox.x[1] - bbox.x[0]);
  const height = Math.max(1, bbox.y[1] - bbox.y[0]);
  const k = Math.min(
    Math.max(1, size.width - padding * 2) / width,
    Math.max(1, size.height - padding * 2) / height,
  );
  return {
    x: (bbox.x[0] + bbox.x[1]) / 2,
    y: (bbox.y[0] + bbox.y[1]) / 2,
    k: Math.min(bounds.max, Math.max(bounds.min, k)),
  };
}

export const GraphView = forwardRef<GraphViewHandle, GraphViewProps>(function GraphView({
  currentCollection,
  vaultPath,
  thumbsRootPath,
  loadedBlocks,
  thumbVersions,
  graphPreferences,
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
  const [materializedRouteKey, setMaterializedRouteKey] = useState<string | null>(null);
  // Recomputed when the layout stops moving: where approaching stops meaning
  // anything depends on how densely this particular graph sits.

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoverPreviewTarget, setHoverPreviewTarget] = useState<GraphPreviewTarget | null>(null);
  const [hoverPreviewBlock, setHoverPreviewBlock] = useState<LightBlock | IndexedBlock | null>(null);
  const [hoverPreviewPosition, setHoverPreviewPosition] = useState<GraphPreviewPosition | null>(null);
  const [hoveredCollectionId, setHoveredCollectionId] = useState<string | null>(null);
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  // Whether the pointer is over the graph's surface. The graph answers hover
  // only then, and only while no open card covers it (SPEC_GRAPH_VIEW.md,
  // «Hover»; SPEC_CARD_STATES.md, С7.10). force-graph keeps the last point
  // its container heard and reads the node under it every frame; it never
  // forgets that point on leave, so a node drifting under it afterwards (the
  // layout cooling after a click, a new snapshot after Connect) opened a
  // preview over the open card (16.10.2026). True until the pointer first
  // leaves: before a move over its own surface the library knows no point
  // and hears nothing.
  const [pointerOverGraph, setPointerOverGraph] = useState(true);
  // The same, for the hover callback between a leave and the render it
  // causes, so a frame in that gap cannot hover a node.
  const pointerOverGraphRef = useRef(true);
  const graphAnswersPointer = pointerOverGraph && !detailOpen;
  // True only while a hover dimming fades: the canvas then redraws every
  // frame, and pauses again once it has drawn the last one.
  const [dimAnimating, setDimAnimating] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [imageVersion, setImageVersion] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  /// Stops the camera glide in progress, if any.
  const stopGlideRef = useRef<(() => void) | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<ForceGraphMethods<GraphCanvasNode, GraphCanvasLink> | undefined>(
    undefined,
  );
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const imageVersionFrameRef = useRef<number | null>(null);
  const loadSequenceRef = useRef(0);
  const acceptedRevisionRef = useRef<ProjectionRevision | null>(null);
  // The collection the pointer attends to, by the shared hover intent rule of
  // the feed and the sidebar (SPEC_CARD_STATES.md, С7): its dimming waits for
  // the pointer to rest on it, a sweep across the graph dims nothing, and
  // once one has answered a neighbouring collection takes over at once
  // (SPEC_GRAPH_VIEW.md, «Hover»). The same engine gives a card's preview the
  // pointer's speed, by the shared card preview rule (С7.10).
  const [attendedCollectionId, setAttendedCollectionId] = useState<string | null>(null);
  const nodePointer = useHoverIntent((state) => setAttendedCollectionId(state.chosen));
  const previewOpener = useHoverPreviewOpener(nodePointer.isSlow);
  // The engine's target, the collection force-graph last reported under the
  // pointer (a card or empty canvas is no target), and the pointer's last
  // point on the graph, where a hover change is reported: the same point is
  // no movement to the engine.
  const collectionUnderPointerRef = useRef<string | null>(null);
  const intentPointRef = useRef<GraphCardMenuPoint | null>(null);
  const lastPointerPointRef = useRef<GraphCardMenuPoint | null>(null);
  const graphScaleRef = useRef(1);
  // Read by the painters on every frame, so it lives outside React state: a
  // fade advances it once per frame without rendering the view.
  const dimTransitionRef = useRef(restingDimTransition());

  // Dragging a node reheats the simulation, and the engine stops between mouse
  // moves; recomputing on each stop made the whole screen pulse under the hand.
  const draggingRef = useRef(false);
  // Whether the simulation has come to rest. A drag only needs reviving when it
  // has: while the layout is still settling the library's own alpha target is
  // already carrying the neighbours.
  const engineStoppedRef = useRef(false);
  const collectionDragClickSuppressionRef = useRef<{ nodeId: string; until: number } | null>(null);
  const previousHoverPreviewFrozenRef = useRef(hoverPreviewFrozen);
  const previousDetailOpenRef = useRef(detailOpen);
  const pendingCenterNodeIdRef = useRef<string | null>(null);
  const pendingFitTicksRef = useRef(0);
  // d3 keeps a node's position on the node object itself, and every snapshot
  // hands us fresh objects. Without carrying the coordinates across, opening a
  // collection restarts the whole layout from nothing — which is why the graph
  // used to be replaced rather than rearranged.
  const nodePositionsRef = useRef(new Map<string, { x: number; y: number }>());
  const focusPositionRef = useRef<{ x: number; y: number } | null>(null);
  const cameraPlanRef = useRef<GraphCameraPlan>(null);
  // Whether the person has moved the camera on this route. A later snapshot
  // of the same route (the async load, a refresh after a clipper save) must
  // not arm a plan again and fly the view away from where they put it; only
  // a new route is a new screen with its own camera (Ф12; SPEC_AUDIT_FIXES.md,
  // Г5.1).
  const cameraHeldByGestureRef = useRef(false);

  const loadedBlocksBySlug = useMemo(() => {
    return new Map(loadedBlocks.map((block) => [block.slug, block]));
  }, [loadedBlocks]);

  const canvasTheme = useMemo(() => readGraphCanvasTheme(theme), [theme]);

  const routeKey = currentCollection ?? "__library__";
  const materializeLargeLibrary = materializedRouteKey === routeKey;
  const scope = useMemo<GraphScope>(() => ({
    kind: currentCollection ? "current_route" : "library",
    collection_ref: currentCollection ?? null,
  }), [currentCollection]);
  // Named field by field: the request carries the two link switches and
  // nothing else a preference object might hold. Collections are always
  // drawn, whatever was stored (SPEC_GRAPH_VIEW.md, «Панель графа»).
  const { include_wikilinks: includeWikilinks, include_related_notes: includeRelatedNotes } =
    graphPreferences;
  const requestOptions = useMemo<GraphOptions>(() => ({
    include_wikilinks: includeWikilinks,
    include_related_notes: includeRelatedNotes,
    materialize_large_library: materializeLargeLibrary,
  }), [includeWikilinks, includeRelatedNotes, materializeLargeLibrary]);

  const acceptRevision = useCallback((revision: ProjectionRevision) => {
    if (acceptSnapshotRevision) return acceptSnapshotRevision(revision);
    const current = acceptedRevisionRef.current;
    if (current !== null && revision < current) return false;
    acceptedRevisionRef.current = revision;
    return true;
  }, [acceptSnapshotRevision]);

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

  const focusNodeId = useMemo(() => {
    if (!currentCollection || !snapshot) return null;
    const node = snapshot.nodes.find(
      (candidate) => candidate.kind === "collection"
        && candidate.collection_ref === currentCollection,
    );
    return node?.id ?? null;
  }, [currentCollection, snapshot]);

  /// What the layout actually depends on. Regaining window focus refreshes the
  /// vault, which hands the graph an equal snapshot as a fresh object; keying
  /// the physics on the object alone made every focus change reheat the
  /// simulation, and the graph visibly breathed out and back in.
  const nodeIdentity = useMemo(() => {
    if (!snapshot) return "empty";
    return [
      snapshot.current_collection ?? "__library__",
      snapshot.nodes.map((node) => `${node.id}:${node.label}`).join("\u0000"),
    ].join("|");
  }, [snapshot]);
  /// The lines apart from the nodes: a link switch in the graph's panel, or a
  /// note whose link now points elsewhere, changes these and not the nodes
  /// (SPEC_GRAPH_VIEW.md, «Панель графа», ГП4). Ids, not a count: the same
  /// number of different lines is a different graph.
  const linkIdentity = useMemo(
    () => (snapshot ? snapshot.links.map((link) => link.id).join("\u0000") : ""),
    [snapshot],
  );

  // Lines that change over the same nodes leave the layout where it stands:
  // the canvas takes the new lines and stops before its first tick, instead
  // of restarting the simulation and moving every node (ГП4). Only when the
  // layout is at rest; one still settling keeps running. Released when the
  // engine stops, so the next drag runs the simulation as always. Kept as
  // state from the previous render, so the canvas gets the hold in the same
  // update as the lines.
  const [shownLayout, setShownLayout] = useState({ nodeIdentity, linkIdentity });
  const [heldLinkIdentity, setHeldLinkIdentity] = useState<string | null>(null);
  if (shownLayout.nodeIdentity !== nodeIdentity || shownLayout.linkIdentity !== linkIdentity) {
    const linksOnly = shownLayout.nodeIdentity === nodeIdentity && engineStoppedRef.current;
    setShownLayout({ nodeIdentity, linkIdentity });
    setHeldLinkIdentity(linksOnly ? linkIdentity : null);
  }
  const holdLayout = heldLinkIdentity !== null && heldLinkIdentity === linkIdentity;

  // Read inside the memo below without being one of its dependencies: the
  // canvas restarts its simulation whenever it is handed a new node array, so
  // rebuilding that array for an identical snapshot is what made the graph
  // twitch on every return to the window.
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  // A new layout invalidates the density measured for the previous one: sizing
  // a fresh collection by the old graph's density is what showed small cards
  // first and enlarged them afterwards.
  const graphData = useMemo<GraphCanvasData>(() => {
    const snapshot = snapshotRef.current;
    if (!snapshot) return { nodes: [], links: [] };
    const carried = nodePositionsRef.current;
    // Pinning happens only where the node already stands. Inventing a position
    // for it — the origin, the viewport centre — teleports the pill on click.
    const focus = focusNodeId ? carried.get(focusNodeId) ?? null : null;
    focusPositionRef.current = focus;
    let entering = 0;
    const nodes = snapshot.nodes.map((node) => {
      const previous = carried.get(node.id);
      if (focus && node.id === focusNodeId) {
        return { ...node, x: focus.x, y: focus.y, fx: focus.x, fy: focus.y };
      }
      if (previous) return { ...node, x: previous.x, y: previous.y };
      // A node the previous snapshot never had enters beside the focus, so the
      // rearrangement reads as growth out of the opened collection.
      if (focus) {
        // Placed on a phyllotaxis spiral rather than at random: entrants must
        // not share a point, or the repulsion between them explodes, and the
        // same click must lay the graph out the same way twice.
        const angle = entering * GRAPH_ENTRY_ANGLE;
        const radius = Math.sqrt(entering + 1) * GRAPH_ENTRY_SPREAD;
        entering += 1;
        return {
          ...node,
          x: focus.x + Math.cos(angle) * radius,
          y: focus.y + Math.sin(angle) * radius,
        };
      }
      return { ...node };
    }).sort(compareGraphNodePaintOrder);
    return { nodes, links: snapshot.links.map((link) => ({ ...link })) };
  }, [focusNodeId, linkIdentity, nodeIdentity]);

  const selectedNode = useMemo(
    () => graphData.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [graphData.nodes, selectedNodeId],
  );

  // What the attended collection keeps lit, worked out when the answer or
  // the snapshot changes and never per frame (SPEC_GRAPH_VIEW.md,
  // «Приглушение при наведении на коллекцию»). A card dims nothing.
  const hoverHighlight = useMemo(() => {
    if (!attendedCollectionId) return null;
    const hovered = graphData.nodes.find((node) => node.id === attendedCollectionId) ?? null;
    return graphHoverHighlight(hovered, graphData.links);
  }, [attendedCollectionId, graphData]);

  // A layout effect, so the frame after the hover already starts the fade.
  // Dimming arrives at the hover's fade-in speed and leaves at its fade-out
  // speed (SPEC_CARD_STATES.md, С7.6); reduced motion swaps at once.
  useLayoutEffect(() => {
    const current = dimTransitionRef.current;
    if (current.to === hoverHighlight) return;
    const durationMs = motionDuration(
      hoverHighlight ? HOVER_INTENT.fadeInMs : HOVER_INTENT.fadeOutMs,
    );
    dimTransitionRef.current = beginDimTransition(
      current,
      hoverHighlight,
      performance.now(),
      durationMs,
    );
    setDimAnimating(durationMs > 0);
  }, [hoverHighlight]);

  const advanceDimming = useCallback(() => {
    const transition = dimTransitionRef.current;
    if (transition.progress >= 1) return;
    transition.progress = dimProgressAt(transition, performance.now());
    if (transition.progress >= 1) setDimAnimating(false);
  }, []);

  const renderThumbnails = !(
    scope.kind === "library" && materializeLargeLibrary
    && (snapshot?.total_nodes ?? 0) > 1_000
  );
  const graphViewportReady = size.width > 0 && size.height > 0;

  /// A programmatic camera movement: ours, frame by frame, so a gesture can
  /// stop it where it is; instant when motion is reduced (Ф12, А5.2).
  const glideCamera = useCallback((target: CameraTarget, durationMs: number) => {
    const graph = graphRef.current;
    if (!graph) return;
    stopGlideRef.current?.();
    stopGlideRef.current = animateCamera(graph, target, motionDuration(durationMs));
  }, []);

  /// The person takes the camera: the glide stops, and the planned one for
  /// this screen and a queued centring are dropped, so nothing moves the view
  /// out from under them (Ф12; SPEC_AUDIT_FIXES.md, В5.5).
  const yieldCameraToGesture = useCallback(() => {
    stopGlideRef.current?.();
    stopGlideRef.current = null;
    cameraHeldByGestureRef.current = true;
    cameraPlanRef.current = null;
    pendingFitTicksRef.current = 0;
    pendingCenterNodeIdRef.current = null;
  }, []);

  useEffect(() => () => stopGlideRef.current?.(), []);

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
      glideCamera({ x: node.x, y: node.y, k: null }, GRAPH_CENTER_DURATION_MS);
    }
    return true;
  }, [glideCamera, graphData.nodes, size.height, size.width]);

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

  // A queued centring waits for its node and a frame, and only until the next
  // gesture: the frame reads the queue again, so a wheel or a press between
  // scheduling and the frame keeps the camera where the person put it.
  useEffect(() => {
    if (!pendingCenterNodeIdRef.current || detailOpen || !graphViewportReady) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const pendingNodeId = pendingCenterNodeIdRef.current;
      if (pendingNodeId && centerNodeIfNeeded(pendingNodeId)) {
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
      // Every node gets the micro level; the heavy zoom level is fetched only
      // for what the frame actually holds, in `ensureZoomLevelInFrame`.
      const url = graphThumbnailUrl(
        resolvedThumbsRoot,
        node.slug,
        thumbVersions.get(node.slug) ?? 0,
        "micro",
      );
      if (cache.has(url)) continue;

      const image = new Image();
      image.onload = () => {
        cache.set(url, image);
        noteImageArrived();
      };
      image.onerror = () => {};
      image.src = url;
    }
  }, [graphData.nodes, renderThumbnails, resolvedThumbsRoot, thumbVersions]);

  // Panning the view is a drag like any other, and macOS shows a closed hand for
  // it — Preview and Maps both do. The library marks the canvas only while a
  // node is being dragged, so the background case is marked here.
  //
  // Set on movement rather than on press: a plain click would otherwise flash
  // the cursor for the length of the click.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    let pressed = false;
    const onDown = () => { pressed = true; };
    const onMove = () => {
      if (!pressed) return;
      container.setAttribute("data-graph-panning", "");
    };
    const onUp = () => {
      pressed = false;
      container.removeAttribute("data-graph-panning");
    };

    container.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      container.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  const aimCenterForce = useCallback((
    graph: ForceGraphMethods<GraphCanvasNode, GraphCanvasLink>,
    target: { x: number; y: number } | null,
  ) => {
    const centerForce = graph.d3Force("center") as unknown as GraphCenterForce | undefined;
    centerForce?.x(target?.x ?? 0).y(target?.y ?? 0);
  }, []);

  /// The one place a node's on-screen size is decided. Painting, the pointer
  /// hit area, the card menu and the hover preview all read it.
  ///
  /// A card has a size in graph coordinates and the camera scales it: nothing
  /// is measured, nothing is smoothed, and the gesture maps onto the size
  /// exactly. Three earlier models computed this from the graph and each needed
  /// machinery to stay stable — that machinery is what every defect lived in.
  const nodeScreenSizeAt = useCallback((zoom: number) => graphNodeScreenSize(zoom), []);

  // Fixed for the lifetime of the view: they follow from the card's size in
  // graph coordinates and the bounds on what it may become on screen.
  const zoomBounds = useMemo(() => graphZoomBounds(), []);

  const currentNodeScreenSize = useCallback(
    () => nodeScreenSizeAt(graphScaleRef.current),
    [nodeScreenSizeAt],
  );

  /// Fetch the zoom level for nodes the frame actually holds.
  ///
  /// Never for the whole snapshot: the zoom level is sixteen times the decoded
  /// weight of the micro level, and a thousand of them would undo the levels
  /// entirely. When the view is close enough for it, only a few dozen nodes are
  /// on screen.
  const ensureZoomLevelInFrame = useCallback(() => {
    if (!renderThumbnails) return;
    const graph = graphRef.current;
    if (!graph || size.width <= 0 || size.height <= 0) return;
    const zoom = graphScaleRef.current;
    if (graphThumbLevelFor(nodeScreenSizeAt(zoom)) !== "zoom") return;

    const cache = imageCacheRef.current;
    for (const node of graphData.nodes) {
      if (node.kind !== "card" || !node.slug || !hasNodePosition(node)) continue;
      const point = graph.graph2ScreenCoords(node.x, node.y);
      const margin = GRAPH_ZOOM_LEVEL_MARGIN_PX;
      if (
        point.x < -margin || point.x > size.width + margin
        || point.y < -margin || point.y > size.height + margin
      ) continue;

      const url = graphThumbnailUrl(
        resolvedThumbsRoot,
        node.slug,
        thumbVersions.get(node.slug) ?? 0,
        "zoom",
      );
      if (cache.has(url)) continue;
      const image = new Image();
      image.onload = () => {
        cache.set(url, image);
        noteImageArrived();
      };
      image.onerror = () => {};
      image.src = url;
    }
  }, [graphData.nodes, nodeScreenSizeAt, renderThumbnails, resolvedThumbsRoot, size, thumbVersions]);

  /// One repaint per frame however many images arrive in it. Bumping the
  /// version per image made a burst of loads a burst of renders, which is the
  /// visible churn when a closer view swaps in the heavier level.
  const noteImageArrived = useCallback(() => {
    if (imageVersionFrameRef.current !== null) return;
    imageVersionFrameRef.current = window.requestAnimationFrame(() => {
      imageVersionFrameRef.current = null;
      setImageVersion((value) => value + 1);
    });
  }, []);

  const syncGraphScale = useCallback((scale: number) => {
    graphScaleRef.current = Number.isFinite(scale) && scale > 0 ? scale : 1;
  }, []);

  // A new route hands the camera back to its plan. Declared before the effect
  // that arms the plan, so on a route change the release lands first.
  useEffect(() => {
    cameraHeldByGestureRef.current = false;
  }, [routeKey]);

  // Keyed on the nodes, not the lines: new lines over the same nodes are not a
  // new layout, and neither the forces nor the camera start again (ГП4).
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
          cardChargeFor(node, physics),
        )
        ?.distanceMax(physics.chargeDistanceMax);

      const centerForce = graph.d3Force("center") as unknown as GraphCenterForce | undefined;
      centerForce?.strength(physics.centerStrength);
      // The centring force pulls the graph's centre of mass to a point. With
      // the opened collection pinned somewhere else, that pull can never be
      // satisfied: every tick shifts all the free nodes toward the point, the
      // pinned one snaps back, and the mismatch repeats — a steady drift that
      // drags a collection's cards off screen and stretches its links. Aiming
      // the force at the pinned node removes the contradiction: the anchor and
      // the target are the same place, so the layout spreads around it evenly.
      aimCenterForce(graph, focusPositionRef.current);

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
      // One camera per snapshot. With a focus the view glides to the pill and
      // holds it; without one it fits the whole graph. Running both is what
      // made the graph appear to fly apart on every click.
      // Decided by the route, not by whether the snapshot for it has arrived
      // yet. Keying this on the node meant that during the load the plan was
      // briefly a fit — which then consumed the tick budget, and the glide to
      // the collection never ran. A collection route always glides, unless
      // the person has already moved the camera on it.
      if (!cameraHeldByGestureRef.current) {
        cameraPlanRef.current = currentCollection ? { kind: "focus" } : { kind: "fit" };
        pendingFitTicksRef.current = GRAPH_INITIAL_FIT_TICKS;
      }
      graph.d3ReheatSimulation();
    };
    frame = requestAnimationFrame(applyForces);
    return () => cancelAnimationFrame(frame);
  }, [currentCollection, graphViewportReady, nodeIdentity, syncGraphScale]);

  const handleEngineTick = useCallback(() => {
    const positions = nodePositionsRef.current;
    for (const node of graphData.nodes) {
      if (!hasNodePosition(node)) continue;
      positions.set(node.id, { x: node.x, y: node.y });
      // Pinning the focus here as well as in the data covers the collection the
      // previous screen never held: the simulation places it on this tick, and
      // it stops moving from the next one.
      if (node.id === focusNodeId && node.fx === undefined) {
        node.fx = node.x;
        node.fy = node.y;
        // Aimed the moment the anchor exists, not only when the snapshot
        // carried a position for it: a collection opened from the sidebar is
        // pinned here, and until the force follows it the drift is back.
        focusPositionRef.current = { x: node.x, y: node.y };
        if (graphRef.current) aimCenterForce(graphRef.current, focusPositionRef.current);
      }
    }
    const graph = graphRef.current;
    if (!graph) return;
    const plan = cameraPlanRef.current;
    if (!plan || pendingFitTicksRef.current <= 0) return;
    // Waiting, not spending: until the collection has a position there is
    // nothing to glide to, and burning the budget here would leave the camera
    // wherever the previous screen left it.
    if (plan.kind === "focus" && (!focusNodeId || !positions.has(focusNodeId))) return;
    // The extent is read once the layout has taken shape rather than on the
    // first tick, where every entrant still sits on top of the focus and the
    // measured extent would be a fraction of the real one.
    pendingFitTicksRef.current -= 1;
    if (pendingFitTicksRef.current > 0) return;
    cameraPlanRef.current = null;

    if (plan.kind === "focus") {
      const focus = focusNodeId ? positions.get(focusNodeId) : null;
      if (!focus) return;
      // Centre and scale move together, over the same duration. Zoom is
      // recomputed here on every navigation: inheriting it from the previous
      // screen is what left one collection cramped and the next one tiny.
      const zoom = graphZoomForExtent(graphData.nodes, size);
      glideCamera({ x: focus.x, y: focus.y, k: zoom }, GRAPH_CENTER_DURATION_MS);
      return;
    }
    const fit = fitCameraTarget(graph.getGraphBbox(), size, GRAPH_FIT_PADDING_PX, zoomBounds);
    if (fit) glideCamera(fit, GRAPH_INITIAL_FIT_DURATION_MS);
  }, [aimCenterForce, focusNodeId, glideCamera, graphData.nodes, size, zoomBounds]);

  const closePreview = useCallback(() => {
    previewOpener.hide();
    setHoverPreviewTarget(null);
    setHoverPreviewBlock(null);
    setHoverPreviewPosition(null);
  }, [previewOpener]);

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

    setHoverPreviewTarget(null);
    setHoverPreviewBlock(null);
    setHoverPreviewPosition(null);
    previewOpener.request(() => openPreview(node));
  }, [closePreview, hoverPreviewFrozen, openPreview, previewOpener]);

  useEffect(() => {
    if (hoverPreviewFrozen) {
      previewOpener.cancel();
    }
  }, [hoverPreviewFrozen, previewOpener]);

  const markPointerOverGraph = useCallback((over: boolean) => {
    if (pointerOverGraphRef.current === over) return;
    pointerOverGraphRef.current = over;
    setPointerOverGraph(over);
  }, []);

  /// Tells the hover intent engine which collection is under the pointer now,
  /// at the pointer's last point: a node arriving under the pointer is not a
  /// pointer step.
  const reportCollectionUnderPointer = useCallback((collectionId: string | null) => {
    if (collectionUnderPointerRef.current === collectionId) return;
    collectionUnderPointerRef.current = collectionId;
    const point = intentPointRef.current;
    if (point) nodePointer.move(collectionId, point.x, point.y);
  }, [nodePointer]);

  // A node being dragged answers nothing, and the answer in place clears at
  // once (SPEC_CARD_STATES.md, С7.8).
  useEffect(() => {
    nodePointer.suspend("drag", dragging);
  }, [dragging, nodePointer]);

  // The pointer left the graph or an open card covers it: nothing on the
  // graph is hovered any more, the card preview closes, and to the hover
  // intent engine the pointer has left, so a collection's dimming clears
  // after its leave grace (С7.4). An open card menu keeps the hover until it
  // closes (`Hover`, freeze); its release lands here again.
  useEffect(() => {
    if (graphAnswersPointer || hoverPreviewFrozen) return;
    collectionUnderPointerRef.current = null;
    nodePointer.leave();
    setHoveredCollectionId(null);
    setHoveredCardId(null);
    closePreview();
  }, [closePreview, graphAnswersPointer, hoverPreviewFrozen, nodePointer]);

  const pointerIsInsidePreviewNode = useCallback((target: GraphPreviewTarget) => {
    const point = lastPointerPointRef.current;
    const graph = graphRef.current;
    const container = containerRef.current;
    const node = graphData.nodes.find((candidate) => candidate.id === target.nodeId);
    if (!point || !graph || !container || !node || !hasNodePosition(node)) return false;

    const containerRect = container.getBoundingClientRect();
    const screenPoint = graph.graph2ScreenCoords(node.x, node.y);
    const nodeSize = currentNodeScreenSize();
    const left = containerRect.left + screenPoint.x - nodeSize / 2;
    const top = containerRect.top + screenPoint.y - nodeSize / 2;
    return point.x >= left
      && point.x <= left + nodeSize
      && point.y >= top
      && point.y <= top + nodeSize;
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
      currentNodeScreenSize(),
    ));

    const loaded = loadedBlocksBySlug.get(hoverPreviewTarget.slug);
    if (loaded) {
      setHoverPreviewBlock(loaded);
      return () => {
        cancelled = true;
      };
    }

    void getBlock(hoverPreviewTarget.slug)
      .then((block) => {
        if (cancelled) return;
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
        currentNodeScreenSize(),
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

  const suppressCollectionClickAfterDrag = useCallback((node: GraphCanvasNode) => {
    if (node.kind !== "collection") return;
    collectionDragClickSuppressionRef.current = {
      nodeId: node.id,
      until: Date.now() + COLLECTION_LABEL_CLICK_SUPPRESS_MS,
    };
    closePreview();
  }, [closePreview]);

  // TRIAL (SPEC_CARD_PEEK.md, О14): the card the open card's window grew
  // out of leaves its place empty while the window stands for it.
  const peekHiddenSlug = usePeekHiddenSlug();
  // Where a card's node stands and what it draws, for the open card's window
  // to grow out of it and shrink back into it (О10, О11). Read through a ref:
  // the reader is registered once.
  const peekSourceStateRef = useRef({ nodes: graphData.nodes, canvasTheme, resolvedThumbsRoot, thumbVersions, renderThumbnails });
  peekSourceStateRef.current = { nodes: graphData.nodes, canvasTheme, resolvedThumbsRoot, thumbVersions, renderThumbnails };
  useEffect(() => registerPeekGraphSource((slug) => {
    const graph = graphRef.current;
    const container = containerRef.current;
    const state = peekSourceStateRef.current;
    const node = state.nodes.find((candidate) => candidate.id === `card:${slug}`);
    if (!graph || !container || !node || !hasNodePosition(node)) return null;
    const box = container.getBoundingClientRect();
    const point = graph.graph2ScreenCoords(node.x, node.y);
    const size = graphNodeScreenSize(graph.zoom());
    const rect = { x: box.left + point.x - size / 2, y: box.top + point.y - size / 2, width: size, height: size };
    const image = cardNodeImage(node, {
      imageCache: imageCacheRef.current,
      thumbsRootPath: state.resolvedThumbsRoot,
      thumbVersion: state.thumbVersions.get(slug) ?? 0,
      renderThumbnail: state.renderThumbnails,
      targetScreenSize: size,
    });
    const picture = image && !isTextPreview(node) ? image : null;
    return {
      rect,
      radius: cardCornerRadius(size),
      // A card without a picture stands on the chrome's plane (canvas.ts).
      fill: picture ? "var(--card)" : state.canvasTheme.chromeFill,
      media: picture
        ? {
          drawable: picture,
          naturalWidth: picture.naturalWidth,
          naturalHeight: picture.naturalHeight,
          clip: rect,
          image: coverPeekRect(rect, picture.naturalWidth, picture.naturalHeight),
          composite: false,
        }
        : null,
    };
  }), []);

  const nodeCanvasObject = useCallback(
    (node: GraphCanvasNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      if (!hasNodePosition(node)) return;
      if (node.slug && node.slug === peekHiddenSlug) return;
      const selected = selectedNodeId === node.id;
      // Hover alone decides it: a selected card or the opened collection
      // outside the hovered collection's part dims like any other node, and
      // keeps its outline.
      // Collections never dim (user's decision of 16.10.2026): only the
      // cards outside the hovered collection's part fade.
      const opacity = node.kind === "collection"
        ? 1
        : graphElementOpacity(
          dimTransitionRef.current,
          "node",
          node.id,
          GRAPH_CONTEXT_OPACITY,
        );
      ctx.save();
      if (node.kind === "collection") {
        paintCollectionNode(ctx, node, {
          globalScale,
          theme: canvasTheme,
          // The opened collection reads as hovered: it is the one the view is
          // held on, and that is the same message hover carries.
          highlighted: hoveredCollectionId === node.id
            || selected
            || node.id === focusNodeId,
          opacity,
        });
        ctx.restore();
        return;
      }
      paintCardNode(ctx, node, {
        globalScale,
        screenSize: nodeScreenSizeAt(globalScale),
        // Size no longer animates, so the level follows it directly.
        targetScreenSize: nodeScreenSizeAt(globalScale),
        hovered: hoveredCardId === node.id,
        canvasTheme,
        imageCache: imageCacheRef.current,
        thumbsRootPath: resolvedThumbsRoot,
        thumbVersion: node.slug ? thumbVersions.get(node.slug) ?? 0 : 0,
        renderThumbnail: renderThumbnails,
        selected,
        opacity,
      });
      ctx.restore();
    },
    [
      canvasTheme,
      peekHiddenSlug,
      focusNodeId,
      hoverHighlight,
      hoveredCardId,
      hoveredCollectionId,
      imageVersion,
      renderThumbnails,
      resolvedThumbsRoot,
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

      // The clickable square must be the drawn square: a node that grows while
      // its hit area stays put is a node the cursor misses.
      const size = nodeScreenSizeAt(globalScale) / globalScale;
      ctx.fillRect(node.x - size / 2, node.y - size / 2, size, size);
    },
    [nodeScreenSizeAt],
  );

  // The arrows take this colour too: the graph sets no arrow colour of its own.
  const linkColorAt = useMemo(() => colorAtOpacity(canvasTheme.linkDefault), [canvasTheme.linkDefault]);
  const linkColor = useCallback(
    (link: GraphCanvasLink) => linkColorAt(graphElementOpacity(
      dimTransitionRef.current,
      "link",
      link.id,
      GRAPH_CONTEXT_OPACITY,
    )),
    // The highlight is read from the ref; naming it here hands the canvas a
    // new accessor, and with it a redraw, when the hover changes.
    [hoverHighlight, linkColorAt],
  );
  const linkDash = useCallback(
    (link: GraphCanvasLink) => graphLinkLineDash(link, graphScaleRef.current),
    [],
  );

  const selectedStatus = selectedNode
    ? `${selectedNode.label}, ${selectedNode.degree} ${selectedNode.degree === 1 ? "neighbor" : "neighbors"}`
    : "";

  const physics = graphPhysics(graphData.nodes.length);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden bg-background"
      onWheelCapture={yieldCameraToGesture}
      onPointerDownCapture={yieldCameraToGesture}
      onPointerEnter={() => markPointerOverGraph(true)}
      onPointerMove={(event) => {
        markPointerOverGraph(true);
        intentPointRef.current = { x: event.clientX, y: event.clientY };
        nodePointer.move(collectionUnderPointerRef.current, event.clientX, event.clientY);
      }}
      onPointerLeave={() => {
        nodePointer.leave();
        markPointerOverGraph(false);
      }}
      onContextMenu={(event) => event.preventDefault()}
      data-graph-view=""
      data-graph-snapshot-route={snapshot?.current_collection ?? "__library__"}
    >
      {snapshot?.truncated
        && snapshot.can_materialize_full
        && !materializeLargeLibrary ? (
          <div
            className="absolute top-3 right-3 z-20"
            data-graph-controls=""
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
          >
            <Button
              type="button"
              variant="default"
              size="xs"
              onClick={() => setMaterializedRouteKey(routeKey)}
              data-graph-materialize-all=""
            >
              Show all
            </Button>
          </div>
        ) : null}

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
            thumbVersion={thumbVersions.get(hoverPreviewBlock.slug)}
          />
        </div>
      ) : null}
      {/* The graph is a pointer surface: selection, opening and panning are
          cursor gestures, and no keyboard handler lives here. */}
      <div
        className="absolute inset-0 outline-none"
        role="group"
        aria-label="Graph canvas"
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
            // Off while the graph does not answer the pointer: the library
            // then stops reading the node under its stale point, and turning
            // it back on forgets the node it last reported, so returning onto
            // that same node hovers it again.
            enablePointerInteraction={graphAnswersPointer}
            onNodeHover={(node) => {
              if (hoverPreviewFrozen) return;
              if (!pointerOverGraphRef.current || detailOpen) return;
              // The pill outlines at once; the dimming waits for the engine.
              reportCollectionUnderPointer(node?.kind === "collection" ? node.id : null);
              if (!node) {
                setHoveredCollectionId(null);
                setHoveredCardId(null);
                closePreview();
                return;
              }
              if (node.kind === "collection") {
                setHoveredCollectionId(node.id);
                setHoveredCardId(null);
                closePreview();
                return;
              }
              setHoveredCollectionId(null);
              setHoveredCardId(node.id);
              schedulePreviewOpen(node);
            }}
            onNodeDrag={(node) => {
              suppressCollectionClickAfterDrag(node);
              if (draggingRef.current) return;
              draggingRef.current = true;
              setDragging(true);
              // Reviving costs a full alpha of 1 — the same jolt as a first
              // layout — so it happens only when the engine has actually
              // stopped. While it is still running the library's own
              // alphaTarget(0.3) is already carrying the neighbours, and a
              // reheat on top of that is what made the graph thrash.
              if (engineStoppedRef.current) {
                engineStoppedRef.current = false;
                graphRef.current?.d3ReheatSimulation();
              }
            }}
            onNodeDragEnd={(node) => {
              draggingRef.current = false;
              setDragging(false);
              suppressCollectionClickAfterDrag(node);
            }}
            minZoom={zoomBounds.min}
            maxZoom={zoomBounds.max}
            d3AlphaDecay={physics.alphaDecay}
            d3VelocityDecay={dragging ? DRAG_VELOCITY_DECAY : physics.velocityDecay}
            warmupTicks={nodePositionsRef.current.size > 0 ? 0 : physics.warmupTicks}
            cooldownTime={physics.cooldownTime}
            // Zero only while new lines over the same nodes are being handed
            // over: the canvas reheats on every new data, and this stops it
            // before the first tick moves anything (ГП4).
            cooldownTicks={holdLayout ? 0 : Infinity}
            onEngineTick={() => {
              engineStoppedRef.current = false;
              handleEngineTick();
            }}
            onEngineStop={() => {
              engineStoppedRef.current = true;
              setHeldLinkIdentity(null);
            }}
            onZoom={(transform) => {
              // Scale only. Density does not depend on the zoom, and touching
              // it here would start an animation in the middle of a gesture —
              // the very lag this model removes.
              syncGraphScale(transform.k);
            }}
            onZoomEnd={(transform) => {
              syncGraphScale(transform.k);
              // Settling on a close view is the moment the heavier level is
              // worth fetching — and the only one, since a settled simulation
              // stops ticking.
              ensureZoomLevelInFrame();
            }}
            backgroundColor="transparent"
            autoPauseRedraw={!dimAnimating}
            onRenderFramePre={advanceDimming}
            linkDirectionalArrowLength={(link) => link.directed ? 3 : 0}
            linkColor={linkColor}
            linkCurvature={graphLinkCurvature}
            linkLineDash={linkDash}
            linkWidth={1}
          />
        ) : null}
      </div>
    </div>
  );
});
