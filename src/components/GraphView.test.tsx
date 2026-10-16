import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GraphLink,
  GraphNode,
  GraphOptions,
  GraphScope,
  GraphSnapshot,
  IndexedBlock,
  LightBlock,
} from "@/types";
import userEvent from "@testing-library/user-event";
import { GraphView, type GraphViewHandle } from "./GraphView";
import { GraphDisplayMenu } from "./GraphDisplayMenu";
import { reloadGraphPreferences, useGraphPreferences } from "@/lib/graphPreferences";
import { DEEMPHASIZED_OPACITY } from "@/lib/colorLaw";
import { HOVER_INTENT } from "@/lib/hoverIntent";
import { HOVER_PREVIEW_COLD_OPEN_DELAY_MS, HOVER_PREVIEW_WARM_WINDOW_MS } from "@/lib/hoverPreviewTiming";
import { indexedBlock, lightBlock } from "@/test/blocks";

type MockGraphNode = GraphNode & {
  x?: number;
  y?: number;
};

type MockGraphProps = {
  graphData?: {
    nodes: MockGraphNode[];
    links: GraphLink[];
  };
  width?: number;
  height?: number;
  onNodeClick?: (node: MockGraphNode, event: MouseEvent) => void;
  onNodeRightClick?: (node: MockGraphNode, event: MouseEvent) => void;
  onNodeHover?: (node: MockGraphNode | null) => void;
  enablePointerInteraction?: boolean;
  onBackgroundClick?: () => void;
  onEngineTick?: () => void;
  onEngineStop?: () => void;
  d3VelocityDecay?: number;
  cooldownTicks?: number;
  onNodeDrag?: (node: MockGraphNode) => void;
  onNodeDragEnd?: (node: MockGraphNode) => void;
  onRenderFramePost?: (context: CanvasRenderingContext2D, globalScale: number) => void;
  nodeCanvasObject?: (
    node: MockGraphNode,
    context: CanvasRenderingContext2D,
    globalScale: number,
  ) => void;
  linkCurvature?: (link: GraphLink) => number;
  linkLineDash?: (link: GraphLink) => number[] | null;
  linkColor?: (link: GraphLink) => string;
};

type MockGraphHandle = {
  d3Force: (_name: string, _force?: unknown) => MockForceAccessor;
  zoomToFit: () => void;
  zoom: () => number;
  d3ReheatSimulation: () => void;
  graph2ScreenCoords: (x: number, y: number) => { x: number; y: number };
  centerAt: (x: number, y: number, duration?: number) => void;
};

type MockForceAccessor = {
  strength: (_accessor: unknown) => MockForceAccessor;
  distanceMax: (_distance: number) => MockForceAccessor;
  distance: (_accessor: unknown) => MockForceAccessor;
  x: (_value: number) => MockForceAccessor;
  y: (_value: number) => MockForceAccessor;
};

const commandMocks = vi.hoisted(() => ({
  listGraphSnapshot: vi.fn<(
    scope: GraphScope,
    options: GraphOptions,
  ) => Promise<GraphSnapshot>>(),
  getBlock: vi.fn<(slug: string) => Promise<IndexedBlock | null>>(),
}));

const graphMethodMocks = vi.hoisted(() => ({
  zoomToFit: vi.fn(),
  d3ReheatSimulation: vi.fn(),
  centerAt: vi.fn(),
  zoom: vi.fn(),
}));

// Camera glides are instant here unless a test asks for real motion: the
// assertions read where the camera ended, not every frame on the way.
const motionMocks = vi.hoisted(() => ({ glide: false }));
vi.mock("@/lib/motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/motion")>();
  return { ...actual, motionDuration: (ms: number) => (motionMocks.glide ? ms : 0) };
});

// The nodes the canvas was last handed. Positions live on these objects, so a
// test asserting where a node is pinned has to read the very objects d3 would.
const graphDataSpy = vi.hoisted(() => ({ current: null as { nodes: Array<Record<string, unknown>> } | null }));

// The painter itself, so a test can ask what a pill is actually drawn with
// rather than trusting a flag that claims it was highlighted.
const paintSpy = vi.hoisted(() => {
  const spy: { current: MockGraphProps["nodeCanvasObject"] } = { current: undefined };
  return spy;
});

const centerAimSpy = vi.hoisted(() => ({ current: { x: 0, y: 0 } }));

// The line colour the canvas was last handed, to ask what a link is drawn in.
const linkColorSpy = vi.hoisted(() => {
  const spy: { current: MockGraphProps["linkColor"] } = { current: undefined };
  return spy;
});

vi.mock("@/lib/commands", () => ({
  listGraphSnapshot: commandMocks.listGraphSnapshot,
  getBlock: commandMocks.getBlock,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
  revealItemInDir: vi.fn(async () => undefined),
}));

// A card's preview opens at once, except in the test of its timing, which runs
// the shared rule itself.
const previewTimingMocks = vi.hoisted(() => ({ real: false }));
vi.mock("@/lib/hoverPreviewTiming", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hoverPreviewTiming")>();
  class TestHoverPreviewOpener extends actual.HoverPreviewOpener {
    override request(show: () => void) {
      if (previewTimingMocks.real) super.request(show);
      else show();
    }
  }
  return { ...actual, HoverPreviewOpener: TestHoverPreviewOpener };
});

vi.mock("react-force-graph-2d", async () => {
  const React = await import("react");

  const forceAccessor: MockForceAccessor = {
    strength: () => forceAccessor,
    distanceMax: () => forceAccessor,
    distance: () => forceAccessor,
    // Records where the centring force is aimed. Aiming it anywhere but the
    // pinned collection is what dragged that collection's cards off screen.
    x: (value: number) => { centerAimSpy.current.x = value; return forceAccessor; },
    y: (value: number) => { centerAimSpy.current.y = value; return forceAccessor; },
  };

  const MockForceGraph2D = React.forwardRef<MockGraphHandle, MockGraphProps>(
    function MockForceGraph2D({
      graphData,
      width,
      height,
      onNodeClick,
      onNodeRightClick,
      onNodeHover,
      enablePointerInteraction,
      onBackgroundClick,
      onEngineTick,
      onEngineStop,
      d3VelocityDecay,
      cooldownTicks,
      onNodeDrag,
      onNodeDragEnd,
      onRenderFramePost,
      nodeCanvasObject,
      linkCurvature,
      linkLineDash,
      linkColor,
    }, ref) {
      React.useImperativeHandle(ref, () => ({
        d3Force: () => forceAccessor,
        zoomToFit: graphMethodMocks.zoomToFit,
        zoom: (k?: number, ms?: number) => {
          if (k === undefined) return 1;
          graphMethodMocks.zoom(k, ms);
          return undefined as never;
        },
        d3ReheatSimulation: graphMethodMocks.d3ReheatSimulation,
        graph2ScreenCoords: (x: number, y: number) => ({ x, y }),
        getGraphBbox: () => ({ x: [0, 200] as [number, number], y: [0, 100] as [number, number] }),
        centerAt: (x?: number, y?: number, ms?: number) => {
          // Called without arguments this reads the camera centre; only a call
          // that moves it counts as a camera move.
          if (x === undefined) return { x: 0, y: 0 };
          graphMethodMocks.centerAt(x, y, ms);
          return undefined as never;
        },
      }));
      // The canvas the pointer moves over. Like force-graph, this stand-in
      // reports a hover change only while the pointer is over the graph: a
      // pointer leaving a node for the empty canvas unhovers it, a pointer
      // leaving the graph altogether reports nothing (force-graph.mjs keeps
      // its last point and never resets it on leave).
      const surfaceRef = React.useRef<HTMLDivElement>(null);
      const leaveNode = (event: React.MouseEvent) => {
        const to = event.relatedTarget;
        if (to instanceof Node && surfaceRef.current?.contains(to)) onNodeHover?.(null);
      };

      (graphData?.nodes ?? []).forEach((node, index) => {
        node.x ??= 100 + index * 40;
        node.y ??= 120;
      });
      graphDataSpy.current = graphData as never;
      paintSpy.current = nodeCanvasObject;
      linkColorSpy.current = linkColor;
      const membershipLink = graphData?.links.find(
        (link) => link.kind === "collection_membership",
      );
      const referenceLink = graphData?.links.find(
        (link) => link.kind === "wikilink",
      );

      return React.createElement(
        "div",
        {
          ref: surfaceRef,
          "data-testid": "force-graph",
          "data-pointer-interaction": String(enablePointerInteraction ?? true),
          "data-velocity-decay": String(d3VelocityDecay ?? ""),
          "data-cooldown-ticks": String(cooldownTicks ?? ""),
          "data-width": String(width),
          "data-height": String(height),
          "data-membership-curvature": membershipLink && linkCurvature
            ? String(linkCurvature(membershipLink))
            : "",
          "data-membership-dash": membershipLink && linkLineDash
            ? String(linkLineDash(membershipLink))
            : "",
          "data-reference-curvature": referenceLink && linkCurvature
            ? String(linkCurvature(referenceLink))
            : "",
          "data-reference-dash": referenceLink && linkLineDash
            ? String(linkLineDash(referenceLink))
            : "",
          onClick: (event: React.MouseEvent) => {
            if (event.target === event.currentTarget) onBackgroundClick?.();
          },
        },
        React.createElement(
          "button",
          {
            type: "button",
            "data-testid": "graph-engine-tick",
            onClick: () => onEngineTick?.(),
          },
          "tick engine",
        ),
        React.createElement(
          "button",
          {
            type: "button",
            "data-testid": "graph-engine-stop",
            onClick: () => onEngineStop?.(),
          },
          "stop engine",
        ),
        React.createElement(
          "button",
          {
            type: "button",
            "data-testid": "graph-node-drag",
            onClick: () => onNodeDrag?.((graphData?.nodes ?? [])[0] as never),
          },
          "drag node",
        ),
        React.createElement(
          "button",
          {
            type: "button",
            "data-testid": "graph-node-drag-end",
            onClick: () => onNodeDragEnd?.((graphData?.nodes ?? [])[0] as never),
          },
          "drop node",
        ),
        React.createElement(
          "button",
          {
            type: "button",
            "data-testid": "graph-render-frame",
            onClick: () => onRenderFramePost?.(null as never, 1),
          },
          "render frame",
        ),
        (graphData?.nodes ?? []).map((node) => {
          const paintAlpha = paintNodeAlpha(node, nodeCanvasObject);
          return React.createElement(
            "button",
            {
              key: node.id,
              type: "button",
              onClick: () => {
                onNodeClick?.(
                  node,
                  new MouseEvent("click", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 144,
                    clientY: 188,
                  }),
                );
              },
              onContextMenu: () => {
                onNodeRightClick?.(
                  node,
                  new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 144,
                    clientY: 188,
                  }),
                );
              },
              onMouseEnter: () => onNodeHover?.(node),
              onMouseLeave: leaveNode,
              "data-paint-alpha": String(paintAlpha),
            },
            node.label,
          );
        }),
      );
    },
  );

  return { default: MockForceGraph2D };
});

// Records the stroke a pill is drawn with. The outline is the whole question:
// hover and the opened collection must produce the same one.
function paintPill(node: MockGraphNode): { stroke: string; lineWidth: number; text: string } {
  const strokes: Array<{ stroke: string; lineWidth: number }> = [];
  const fills: string[] = [];
  const context = {
    globalAlpha: 1,
    filter: "none",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    save() {}, restore() {}, beginPath() {}, rect() {}, moveTo() {}, lineTo() {},
    arcTo() {}, arc() {}, closePath() {}, clip() {}, translate() {}, scale() {},
    drawImage() {}, fillRect() {}, strokeRect() {}, setLineDash() {},
    measureText: () => ({ width: 40 }),
    fill() { fills.push(String(this.fillStyle)); },
    stroke() { strokes.push({ stroke: String(this.strokeStyle), lineWidth: this.lineWidth }); },
    fillText() { fills.push(String(this.fillStyle)); },
  };
  paintSpy.current?.(node as never, context as never, 1);
  return {
    stroke: strokes.at(-1)?.stroke ?? "",
    lineWidth: strokes.at(-1)?.lineWidth ?? 0,
    text: fills.at(-1) ?? "",
  };
}

function paintNodeAlpha(
  node: MockGraphNode,
  paint: MockGraphProps["nodeCanvasObject"],
): number {
  if (!paint) return 1;
  let paintedAlpha = 1;
  const alphaStack: number[] = [];
  const fake = {
    globalAlpha: 1,
    filter: "none",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    save() {
      alphaStack.push(this.globalAlpha);
    },
    restore() {
      this.globalAlpha = alphaStack.pop() ?? 1;
    },
    beginPath() {},
    rect() {},
    moveTo() {},
    lineTo() {},
    arcTo() {},
    arc() {},
    closePath() {},
    clip() {},
    fill() {
      paintedAlpha = this.globalAlpha;
    },
    stroke() {},
    fillRect() {
      paintedAlpha = this.globalAlpha;
    },
    strokeRect() {},
    translate() {},
    scale() {},
    fillText() {},
  };
  // The painter calls only the members the fake implements; a canvas would
  // also need the hundred others it never touches.
  const context = fake as unknown as CanvasRenderingContext2D;
  paint(node, context, 1);
  return paintedAlpha;
}

function makeBlock(overrides: Partial<LightBlock> = {}): LightBlock {
  return lightBlock({
    id: 1,
    slug: "alpha-card",
    card_kind: "article",
    block_type: "article",
    title: "Alpha card",
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    width: null,
    height: null,
    author: null,
    body: "Alpha body",
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    collections: [],
    feed_playback: null,
    ...overrides,
  });
}

function makeIndexedBlock(block: LightBlock): IndexedBlock {
  return indexedBlock({
    ...block,
    description: null,
    source: null,
    thumb_format: null,
    thumb_mtime: 0,
    related_notes: [],
    body_hash: null,
    tags: [],
  });
}

function makeSnapshot(node: GraphNode): GraphSnapshot {
  return makeSnapshotFromNodes([node]);
}

function makeSnapshotFromNodes(
  nodes: GraphNode[],
  overrides: Partial<GraphSnapshot> = {},
): GraphSnapshot {
  return {
    generation: 1,
    nodes,
    links: [],
    total_cards: nodes.filter((node) => node.kind === "card").length,
    total_collections: nodes.filter((node) => node.kind === "collection").length,
    current_collection: null,
    truncated: false,
    truncation_reason: null,
    can_materialize_full: false,
    visible_nodes: nodes.length,
    visible_links: 0,
    total_nodes: nodes.length,
    total_links: 0,
    ...overrides,
  };
}

function graphCardNode(
  slug: string,
  label: string,
  position: { x?: number; y?: number } = {},
): MockGraphNode {
  return {
    id: `card:${slug}`,
    kind: "card",
    label,
    slug,
    collection_ref: null,
    card_kind: "article",
    block_type: "article",
    thumbnail: null,
    preview_manifest: null,
    degree: 1,
    ...position,
  };
}

function renderGraph(props: Partial<Parameters<typeof GraphView>[0]> = {}) {
  const onNavigateCollection = vi.fn();
  const onOpenBlock = vi.fn();
  const onOpenCardMenu = vi.fn();

  const utils = render(
    <GraphView
      vaultPath="/vault"
      loadedBlocks={[]}
      thumbVersions={new Map()}
      graphPreferences={{
        include_wikilinks: true,
        include_related_notes: true,
      }}
      hoverPreviewFrozen={false}
      onOpenBlock={onOpenBlock}
      onOpenCardMenu={onOpenCardMenu}
      onNavigateCollection={onNavigateCollection}
      {...props}
    />,
  );

  return {
    ...utils,
    rerenderGraph: (nextProps: Partial<Parameters<typeof GraphView>[0]> = {}) => {
      utils.rerender(
        <GraphView
          vaultPath="/vault"
          loadedBlocks={[]}
          thumbVersions={new Map()}
          graphPreferences={{
            include_wikilinks: true,
            include_related_notes: true,
          }}
          hoverPreviewFrozen={false}
          onOpenBlock={onOpenBlock}
          onOpenCardMenu={onOpenCardMenu}
          onNavigateCollection={onNavigateCollection}
          {...props}
          {...nextProps}
        />,
      );
    },
    onNavigateCollection,
    onOpenBlock,
    onOpenCardMenu,
  };
}

describe("GraphView", () => {
  beforeEach(() => {
    class ImmediateResizeObserver {
      private readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      observe(target: Element) {
        this.callback(
          [
            {
              target,
              contentRect: {
                width: 1234,
                height: 777,
              },
            } as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }

      unobserve() {}
      disconnect() {}
    }

    Object.defineProperty(globalThis, "ResizeObserver", {
      writable: true,
      value: ImmediateResizeObserver,
    });
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    commandMocks.listGraphSnapshot.mockReset();
    commandMocks.getBlock.mockReset();
    graphMethodMocks.zoomToFit.mockReset();
    graphMethodMocks.d3ReheatSimulation.mockReset();
    graphMethodMocks.centerAt.mockReset();
    graphMethodMocks.zoom.mockReset();
  });

  it("does not publish a graph snapshot rejected by the projection owner", async () => {
    const acceptSnapshotRevision = vi.fn(() => false);
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshot(
      graphCardNode("stale-card", "Stale card"),
    ));

    renderGraph({ acceptSnapshotRevision });

    await waitFor(() => expect(acceptSnapshotRevision).toHaveBeenCalledWith(1));
    expect(screen.queryByRole("button", { name: "Stale card" })).not.toBeInTheDocument();
  });

  it("renders membership solid and semantic references curved and dashed", async () => {
    const card = graphCardNode("alpha-card", "Alpha card");
    const collection: GraphNode = {
      id: "collection:Design",
      kind: "collection",
      label: "Design",
      slug: null,
      collection_ref: "Design",
      card_kind: null,
      block_type: null,
      thumbnail: null,
      preview_manifest: null,
      degree: 1,
    };
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes(
      [card, collection],
      {
        links: [
          {
            id: "membership:Design:alpha-card",
            kind: "collection_membership",
            source: collection.id,
            target: card.id,
            directed: false,
            count: 1,
            target_ref: null,
          },
          {
            id: "wikilink:alpha-card:beta-card",
            kind: "wikilink",
            source: card.id,
            target: "card:beta-card",
            directed: true,
            count: 1,
            target_ref: "beta-card",
          },
        ],
        visible_links: 2,
        total_links: 2,
      },
    ));

    renderGraph();

    const graph = await screen.findByTestId("force-graph");
    expect(graph).toHaveAttribute("data-membership-curvature", "0");
    expect(graph).toHaveAttribute("data-membership-dash", "null");
    expect(Math.abs(Number(graph.getAttribute("data-reference-curvature")))).toBe(0.14);
    expect(graph).toHaveAttribute("data-reference-dash", "4,4");
  });

  it("opens the block on card node left click", async () => {
    const block = makeBlock();
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshot({
      id: "card:alpha-card",
      kind: "card",
      label: "Alpha card",
      slug: block.slug,
      collection_ref: null,
      card_kind: "article",
      block_type: "article",
      thumbnail: null,
      preview_manifest: null,
      degree: 1,
    }));
    commandMocks.getBlock.mockResolvedValue(makeIndexedBlock(block));

    const { onOpenBlock, onOpenCardMenu } = renderGraph({ loadedBlocks: [block] });

    fireEvent.click(await screen.findByRole("button", { name: "Alpha card" }));

    await waitFor(() => {
      expect(onOpenBlock).toHaveBeenCalledWith(block);
    });
    expect(onOpenCardMenu).not.toHaveBeenCalled();
    expect(commandMocks.getBlock).not.toHaveBeenCalled();
  });

  it("opens the shared card action menu request on card node right click", async () => {
    const block = makeBlock();
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshot({
      id: "card:alpha-card",
      kind: "card",
      label: "Alpha card",
      slug: block.slug,
      collection_ref: null,
      card_kind: "article",
      block_type: "article",
      thumbnail: null,
      preview_manifest: null,
      degree: 1,
    }));
    commandMocks.getBlock.mockResolvedValue(makeIndexedBlock(block));

    const { onOpenBlock, onOpenCardMenu } = renderGraph({ loadedBlocks: [block] });

    fireEvent.contextMenu(await screen.findByRole("button", { name: "Alpha card" }));

    await waitFor(() => {
      expect(onOpenCardMenu).toHaveBeenCalledWith(block, { x: 144, y: 188 });
    });
    expect(onOpenBlock).not.toHaveBeenCalled();
    expect(commandMocks.getBlock).not.toHaveBeenCalled();
  });

  it("keeps an open hover preview when right clicking a card node", async () => {
    const block = makeBlock();
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshot({
      id: "card:alpha-card",
      kind: "card",
      label: "Alpha card",
      slug: block.slug,
      collection_ref: null,
      card_kind: "article",
      block_type: "article",
      thumbnail: null,
      preview_manifest: null,
      degree: 1,
    }));
    commandMocks.getBlock.mockResolvedValue(makeIndexedBlock(block));

    const { container, onOpenCardMenu } = renderGraph({ loadedBlocks: [block] });
    const cardNode = await screen.findByRole("button", { name: "Alpha card" });

    fireEvent.mouseEnter(cardNode);

    await waitFor(() => {
      expect(container.querySelector("[data-graph-card-hover-preview]")).toBeInTheDocument();
    });
    // The feed's own card unfolded, no lift, with nothing to press
    // (SPEC_CARD_STATES.md, С10).
    const preview = container.querySelector("[data-graph-card-hover-preview]")!;
    expect(preview.querySelector("[data-card-preview]")).toHaveAttribute("data-card-preview-unfolded");
    expect(preview.querySelector("[data-card-preview]")).not.toHaveAttribute("data-card-lift-pinned");
    expect(preview.querySelector("[data-card-preview-collections]")).not.toBeNull();
    expect(preview.querySelector("button")).toBeNull();

    fireEvent.contextMenu(cardNode);

    await waitFor(() => {
      expect(onOpenCardMenu).toHaveBeenCalledWith(block, { x: 144, y: 188 });
    });
    expect(container.querySelector("[data-graph-card-hover-preview]")).toBeInTheDocument();
  });

  it("freezes hover preview changes while a card menu is open", async () => {
    const alpha = makeBlock({ slug: "alpha-card", title: "Alpha card" });
    const beta = makeBlock({ id: 2, slug: "beta-card", title: "Beta card" });
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes([
      {
        id: "card:alpha-card",
        kind: "card",
        label: "Alpha card",
        slug: alpha.slug,
        collection_ref: null,
        card_kind: "article",
        block_type: "article",
        thumbnail: null,
        preview_manifest: null,
        degree: 1,
      },
      {
        id: "card:beta-card",
        kind: "card",
        label: "Beta card",
        slug: beta.slug,
        collection_ref: null,
        card_kind: "article",
        block_type: "article",
        thumbnail: null,
        preview_manifest: null,
        degree: 1,
      },
    ]));
    commandMocks.getBlock.mockImplementation(async (slug) => {
      if (slug === alpha.slug) return makeIndexedBlock(alpha);
      if (slug === beta.slug) return makeIndexedBlock(beta);
      return null;
    });

    const { container, rerenderGraph } = renderGraph({ loadedBlocks: [alpha, beta] });
    const alphaNode = await screen.findByRole("button", { name: "Alpha card" });
    const betaNode = await screen.findByRole("button", { name: "Beta card" });

    fireEvent.mouseEnter(alphaNode);

    await waitFor(() => {
      expect(container.querySelector("[data-graph-card-hover-preview]")).toBeInTheDocument();
    });

    rerenderGraph({ loadedBlocks: [alpha, beta], hoverPreviewFrozen: true });
    fireEvent.mouseEnter(betaNode);

    expect(commandMocks.getBlock).not.toHaveBeenCalledWith(beta.slug);
    expect(container.querySelector("[data-graph-card-hover-preview]")).toBeInTheDocument();
  });

  it("times a card's preview by the shared card preview rule", async () => {
    const alpha = makeBlock({ slug: "alpha-card", title: "Alpha card" });
    const beta = makeBlock({ id: 2, slug: "beta-card", title: "Beta card" });
    const cardNode = (block: LightBlock): GraphNode => ({
      id: `card:${block.slug}`,
      kind: "card",
      label: block.title ?? block.slug,
      slug: block.slug,
      collection_ref: null,
      card_kind: "article",
      block_type: "article",
      thumbnail: null,
      preview_manifest: null,
      degree: 1,
    });
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes([cardNode(alpha), cardNode(beta)]));
    const { container } = renderGraph({ loadedBlocks: [alpha, beta] });
    const alphaNode = await screen.findByRole("button", { name: "Alpha card" });
    const betaNode = screen.getByRole("button", { name: "Beta card" });
    const preview = () => container.querySelector("[data-graph-card-hover-preview]");
    const settle = async (ms: number) => {
      await act(async () => {
        vi.advanceTimersByTime(ms);
        await Promise.resolve();
      });
    };

    previewTimingMocks.real = true;
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance", "Date", "requestAnimationFrame", "cancelAnimationFrame"],
    });
    try {
      // The graph feeds the pointer's speed: a pointer still moving over the
      // node past the delay opens nothing until it rests.
      fireEvent.mouseEnter(alphaNode);
      for (let elapsed = 0; elapsed < HOVER_PREVIEW_COLD_OPEN_DELAY_MS + 100; elapsed += 16) {
        await settle(16);
        fireEvent.pointerMove(alphaNode, { clientX: 100 + elapsed, clientY: 10 });
      }
      expect(preview()).toBeNull();
      await settle(HOVER_INTENT.velocityWindowMs * 2);
      expect(preview()).toBeInTheDocument();

      // Read long past the warm window, it hands over to the next node at once.
      await settle(HOVER_PREVIEW_WARM_WINDOW_MS * 3);
      fireEvent.mouseLeave(alphaNode, { relatedTarget: screen.getByTestId("force-graph") });
      expect(preview()).toBeNull();
      fireEvent.mouseEnter(betaNode);
      await settle(0);
      expect(preview()).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      previewTimingMocks.real = false;
    }
  });

  it("reheats the force simulation when hover preview freeze is released", async () => {
    const block = makeBlock();
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshot({
      id: "card:alpha-card",
      kind: "card",
      label: "Alpha card",
      slug: block.slug,
      collection_ref: null,
      card_kind: "article",
      block_type: "article",
      thumbnail: null,
      preview_manifest: null,
      degree: 1,
    }));

    const { rerenderGraph } = renderGraph({
      loadedBlocks: [block],
      hoverPreviewFrozen: true,
    });

    await screen.findByRole("button", { name: "Alpha card" });
    await waitFor(() => {
      expect(graphMethodMocks.d3ReheatSimulation).toHaveBeenCalled();
    });
    graphMethodMocks.d3ReheatSimulation.mockClear();

    rerenderGraph({
      loadedBlocks: [block],
      hoverPreviewFrozen: false,
    });

    await waitFor(() => {
      expect(graphMethodMocks.d3ReheatSimulation).toHaveBeenCalledTimes(1);
    });
  });

  it("closes a frozen card hover preview when the menu closes away from the node", async () => {
    const block = makeBlock();
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshot({
      id: "card:alpha-card",
      kind: "card",
      label: "Alpha card",
      slug: block.slug,
      collection_ref: null,
      card_kind: "article",
      block_type: "article",
      thumbnail: null,
      preview_manifest: null,
      degree: 1,
    }));
    commandMocks.getBlock.mockResolvedValue(makeIndexedBlock(block));

    const { container, rerenderGraph } = renderGraph({ loadedBlocks: [block] });
    const cardNode = await screen.findByRole("button", { name: "Alpha card" });

    fireEvent.mouseEnter(cardNode);
    await waitFor(() => {
      expect(container.querySelector("[data-graph-card-hover-preview]")).toBeInTheDocument();
    });

    rerenderGraph({ loadedBlocks: [block], hoverPreviewFrozen: true });
    fireEvent.mouseLeave(cardNode);
    fireEvent.pointerMove(window, { clientX: 500, clientY: 500 });
    expect(container.querySelector("[data-graph-card-hover-preview]")).toBeInTheDocument();

    rerenderGraph({ loadedBlocks: [block], hoverPreviewFrozen: false });

    await waitFor(() => {
      expect(container.querySelector("[data-graph-card-hover-preview]")).not.toBeInTheDocument();
    });
  });

  it("renders the force graph only with the measured viewport size", async () => {
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshot({
      id: "collection:design",
      kind: "collection",
      label: "Design",
      slug: null,
      collection_ref: "Design",
      card_kind: null,
      block_type: null,
      thumbnail: null,
      preview_manifest: null,
      degree: 1,
    }));

    renderGraph();

    const graph = await screen.findByTestId("force-graph");
    expect(graph).toHaveAttribute("data-width", "1234");
    expect(graph).toHaveAttribute("data-height", "777");
    expect(screen.queryByText(/nodes ·/)).not.toBeInTheDocument();
  });

  it("fits only after the configured simulation ticks instead of the pre-layout frame", async () => {
    commandMocks.listGraphSnapshot.mockResolvedValue(
      makeSnapshot(graphCardNode("alpha-card", "Alpha card")),
    );
    renderGraph();
    await screen.findByRole("button", { name: "Alpha card" });
    await waitFor(() => expect(graphMethodMocks.d3ReheatSimulation).toHaveBeenCalled());
    expect(graphMethodMocks.zoomToFit).not.toHaveBeenCalled();

    const tick = screen.getByTestId("graph-engine-tick");
    for (let index = 0; index < 17; index += 1) fireEvent.click(tick);
    expect(graphMethodMocks.centerAt).not.toHaveBeenCalled();
    fireEvent.click(tick);

    // The whole graph (the mock's box is 200 by 100) is fitted once.
    expect(graphMethodMocks.centerAt).toHaveBeenCalledTimes(1);
    expect(graphMethodMocks.centerAt).toHaveBeenCalledWith(100, 50, 0);
    expect(graphMethodMocks.zoom).toHaveBeenCalledTimes(1);
  });

  it("keeps collection node left click as graph navigation", async () => {
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshot({
      id: "collection:design",
      kind: "collection",
      label: "Design",
      slug: null,
      collection_ref: "Design",
      card_kind: null,
      block_type: null,
      thumbnail: null,
      preview_manifest: null,
      degree: 1,
    }));
    commandMocks.getBlock.mockResolvedValue(null);

    const { onNavigateCollection } = renderGraph();

    fireEvent.click(await screen.findByRole("button", { name: "Design" }));

    expect(onNavigateCollection).toHaveBeenCalledWith("Design");
    expect(commandMocks.getBlock).not.toHaveBeenCalled();
  });

  it("requests the library projection with the complete default option contract", async () => {
    commandMocks.listGraphSnapshot.mockResolvedValue(
      makeSnapshot(graphCardNode("alpha-card", "Alpha card")),
    );

    renderGraph();

    await screen.findByRole("button", { name: "Alpha card" });
    expect(commandMocks.listGraphSnapshot).toHaveBeenCalledWith(
      {
        kind: "library",
        collection_ref: null,
      },
      {
        include_wikilinks: true,
        include_related_notes: true,
        materialize_large_library: false,
      },
    );
  });

  it("draws the opened collection exactly as hover draws it, with no outline of its own", async () => {
    const card = graphCardNode("alpha-card", "Alpha card");
    const collection: GraphNode = {
      id: "collection:Design",
      kind: "collection",
      label: "Design",
      slug: null,
      collection_ref: "Design",
      card_kind: null,
      block_type: null,
      thumbnail: null,
      preview_manifest: null,
      degree: 1,
    };
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes([card, collection]));

    const { rerenderGraph } = renderGraph();
    await screen.findByRole("button", { name: "Alpha card" });
    const pill = () => graphDataSpy.current?.nodes.find(
      (node) => node.id === "collection:Design",
    ) as MockGraphNode;

    const resting = paintPill(pill());
    fireEvent.mouseOver(screen.getByRole("button", { name: "Design" }));
    const hovered = paintPill(pill());
    expect(hovered.stroke).not.toBe(resting.stroke);

    fireEvent.mouseOut(screen.getByRole("button", { name: "Design" }));
    rerenderGraph({ currentCollection: "Design" });
    await waitFor(() => {
      const opened = paintPill(pill());
      expect(opened.stroke).toBe(hovered.stroke);
      expect(opened.text).toBe(hovered.text);
      // A heavier line was the invented third look; the opened pill wears the
      // hover outline at hover weight.
      expect(opened.lineWidth).toBe(hovered.lineWidth);
    });
  });

  it("recomputes zoom on every navigation instead of inheriting the previous screen's", async () => {
    const collection = (ref: string): GraphNode => ({
      id: `collection:${ref}`,
      kind: "collection",
      label: ref,
      slug: null,
      collection_ref: ref,
      card_kind: null,
      block_type: null,
      thumbnail: null,
      preview_manifest: null,
      degree: 1,
    });
    // The mock lays nodes out at 40px intervals, so a bigger collection has a
    // genuinely wider extent — the thing the zoom is supposed to answer to.
    const small = [graphCardNode("a-card", "A card"), collection("Small")];
    const large = [
      ...Array.from({ length: 60 }, (_, index) => graphCardNode(`c${index}`, `Card ${index}`)),
      collection("Small"),
      collection("Large"),
    ];

    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes(small));
    const { rerenderGraph } = renderGraph();
    await screen.findByRole("button", { name: "A card" });
    const tick = screen.getByTestId("graph-engine-tick");
    fireEvent.click(tick);

    rerenderGraph({ currentCollection: "Small" });
    await waitFor(() => expect(graphMethodMocks.d3ReheatSimulation).toHaveBeenCalled());
    for (let index = 0; index < 20; index += 1) fireEvent.click(tick);
    const smallZoom = graphMethodMocks.zoom.mock.calls.at(-1)?.[0] as number;
    expect(smallZoom).toBeGreaterThan(0);

    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes(large));
    graphMethodMocks.zoom.mockReset();
    graphMethodMocks.d3ReheatSimulation.mockReset();
    rerenderGraph({ currentCollection: "Large" });
    await screen.findByRole("button", { name: "Card 59" });
    // The forces are installed inside an animation frame, and the camera plan
    // with them; ticking before that lands would measure the previous plan.
    await waitFor(() => expect(graphMethodMocks.d3ReheatSimulation).toHaveBeenCalled());
    for (let index = 0; index < 20; index += 1) fireEvent.click(tick);

    const largeZoom = graphMethodMocks.zoom.mock.calls.at(-1)?.[0] as number;
    expect(largeZoom).toBeGreaterThan(0);
    // Wider content, smaller scale. Equal values would mean the camera kept
    // whatever the previous collection left behind.
    expect(largeZoom).toBeLessThan(smallZoom);
  });

  /// Width of the square a card paints, read from the path it traces. The card
  /// is drawn as a rounded rectangle now, so there is no `rect` call to watch.
  function drawnCardSize(zoom = 1): number {
    let minX = Infinity;
    let maxX = -Infinity;
    const seeX = (x: number) => {
      if (!Number.isFinite(x)) return;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    };
    const context = {
      globalAlpha: 1, filter: "none", fillStyle: "", strokeStyle: "", lineWidth: 1,
      font: "", textAlign: "start", textBaseline: "alphabetic",
      save() {}, restore() {}, beginPath() {}, closePath() {}, clip() {},
      translate() {}, scale() {}, setLineDash() {}, fill() {}, stroke() {},
      fillText() {}, drawImage() {},
      measureText: () => ({ width: 40 }),
      moveTo: (x: number) => seeX(x),
      lineTo: (x: number) => seeX(x),
      arcTo: (x1: number, _y1: number, x2: number) => { seeX(x1); seeX(x2); },
      arc: (x: number) => seeX(x),
      rect: (x: number, _y: number, w: number) => { seeX(x); seeX(x + w); },
      fillRect: (x: number, _y: number, w: number) => { seeX(x); seeX(x + w); },
      strokeRect: (x: number, _y: number, w: number) => { seeX(x); seeX(x + w); },
    };
    const node = graphDataSpy.current?.nodes.find((n) => n.kind === "card");
    paintSpy.current?.(node as never, context as never, zoom);
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return 0;
    return (maxX - minX) * zoom;
  }

  it("thickens the simulation while a node is under the hand", async () => {
    // Damping is what stops the layout swinging around a dragged card: at rest
    // a node keeps 64% of its speed per tick and overshoots, under the hand it
    // keeps 30% and settles.
    commandMocks.listGraphSnapshot.mockResolvedValue(
      makeSnapshot(graphCardNode("alpha-card", "Alpha card")),
    );
    renderGraph();
    const graph = await screen.findByTestId("force-graph");
    const atRest = graph.getAttribute("data-velocity-decay");

    fireEvent.click(screen.getByTestId("graph-node-drag"));
    const dragging = screen.getByTestId("force-graph").getAttribute("data-velocity-decay");
    expect(Number(dragging)).toBeGreaterThan(Number(atRest));

    fireEvent.click(screen.getByTestId("graph-node-drag-end"));
    expect(screen.getByTestId("force-graph").getAttribute("data-velocity-decay")).toBe(atRest);
  });

  it("marks the view as panning only once the pointer actually moves", async () => {
    // macOS shows a closed hand while a view is dragged — Preview and Maps
    // both do — and the library marks the canvas only for node drags. Marking
    // on press rather than on movement would flash the cursor on every click.
    commandMocks.listGraphSnapshot.mockResolvedValue(
      makeSnapshot(graphCardNode("alpha-card", "Alpha card")),
    );
    const { container } = renderGraph();
    await screen.findByRole("button", { name: "Alpha card" });
    const view = container.querySelector("[data-graph-view]") as HTMLElement;

    // Moving the pointer without holding anything is not panning.
    fireEvent.pointerMove(window);
    expect(view.hasAttribute("data-graph-panning")).toBe(false);

    fireEvent.pointerDown(view);
    expect(view.hasAttribute("data-graph-panning")).toBe(false);

    fireEvent.pointerMove(window);
    expect(view.hasAttribute("data-graph-panning")).toBe(true);

    fireEvent.pointerUp(window);
    expect(view.hasAttribute("data-graph-panning")).toBe(false);
  });

  it("revives the simulation only when it has actually stopped", async () => {
    // Reviving costs a full alpha of 1 — the same jolt as a first layout. While
    // the engine is still running the library's own alpha target already
    // carries the neighbours, and the jolt on top of it is what made the graph
    // thrash under the hand.
    commandMocks.listGraphSnapshot.mockResolvedValue(
      makeSnapshot(graphCardNode("alpha-card", "Alpha card")),
    );
    renderGraph();
    await screen.findByRole("button", { name: "Alpha card" });
    await waitFor(() => expect(graphMethodMocks.d3ReheatSimulation).toHaveBeenCalled());
    graphMethodMocks.d3ReheatSimulation.mockReset();

    // Engine running: dragging must not add anything.
    fireEvent.click(screen.getByTestId("graph-engine-tick"));
    fireEvent.click(screen.getByTestId("graph-node-drag"));
    expect(graphMethodMocks.d3ReheatSimulation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("graph-node-drag-end"));

    // Engine stopped: now it needs reviving, once.
    fireEvent.click(screen.getByTestId("graph-engine-stop"));
    fireEvent.click(screen.getByTestId("graph-node-drag"));
    fireEvent.click(screen.getByTestId("graph-node-drag"));
    expect(graphMethodMocks.d3ReheatSimulation).toHaveBeenCalledTimes(1);
  });

  it("reheats once per drag, not on every movement", async () => {
    // The library already holds the engine at a low alpha target for the
    // length of a drag. Reheating on each mouse move put full energy into the
    // graph on every one of them, and the whole layout thrashed.
    commandMocks.listGraphSnapshot.mockResolvedValue(
      makeSnapshot(graphCardNode("alpha-card", "Alpha card")),
    );
    renderGraph();
    await screen.findByRole("button", { name: "Alpha card" });
    await waitFor(() => expect(graphMethodMocks.d3ReheatSimulation).toHaveBeenCalled());
    graphMethodMocks.d3ReheatSimulation.mockReset();
    fireEvent.click(screen.getByTestId("graph-engine-stop"));

    const drag = screen.getByTestId("graph-node-drag");
    fireEvent.click(drag);
    fireEvent.click(drag);
    fireEvent.click(drag);

    expect(graphMethodMocks.d3ReheatSimulation).toHaveBeenCalledTimes(1);

    // A new drag revives it again only if it stopped again in between.
    fireEvent.click(screen.getByTestId("graph-node-drag-end"));
    fireEvent.click(screen.getByTestId("graph-engine-stop"));
    fireEvent.click(drag);
    expect(graphMethodMocks.d3ReheatSimulation).toHaveBeenCalledTimes(2);
  });

  it("holds the card size still while a node is being dragged", async () => {
    commandMocks.listGraphSnapshot.mockResolvedValue(
      makeSnapshot(graphCardNode("alpha-card", "Alpha card")),
    );
    renderGraph();
    await screen.findByRole("button", { name: "Alpha card" });

    fireEvent.click(screen.getByTestId("graph-node-drag"));
    const duringDrag = drawnCardSize();
    // Dragging reheats the simulation and the engine stops between mouse
    // moves; each stop used to resize every card on screen.
    fireEvent.click(screen.getByTestId("graph-engine-stop"));
    fireEvent.click(screen.getByTestId("graph-render-frame"));

    expect(drawnCardSize()).toBe(duringDrag);
  });

  it("sizes a card from the zoom alone, and from nothing else", async () => {
    // A card has a size in graph coordinates; the camera scales it. Nothing
    // about the layout enters — which is why opening a collection, a settling
    // simulation and a dragged node can no longer resize anything. Three
    // earlier models computed this from the graph and every defect of the last
    // three days lived in the machinery that kept them stable.
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes(
      Array.from({ length: 6 }, (_, index) => graphCardNode(`c${index}`, `Card ${index}`)),
    ));
    const { rerenderGraph } = renderGraph();
    await screen.findByRole("button", { name: "Card 5" });

    const atOpen = drawnCardSize(1);

    // Everything that used to move the size: ticks, an engine stop, a drag,
    // and a different collection entirely.
    const tick = screen.getByTestId("graph-engine-tick");
    for (let index = 0; index < 30; index += 1) fireEvent.click(tick);
    fireEvent.click(screen.getByTestId("graph-engine-stop"));
    fireEvent.click(screen.getByTestId("graph-node-drag"));
    fireEvent.click(screen.getByTestId("graph-node-drag-end"));
    expect(drawnCardSize(1)).toBe(atOpen);

    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes(
      Array.from({ length: 30 }, (_, index) => graphCardNode(`d${index}`, `Other ${index}`)),
    ));
    rerenderGraph({ currentCollection: "Design" });
    await screen.findByRole("button", { name: "Other 29" });

    expect(drawnCardSize(1)).toBe(atOpen);
    // And it does follow the zoom, proportionally — measured below the
    // ceiling, where the proportion is the only thing acting.
    expect(drawnCardSize(2) / atOpen).toBeCloseTo(2, 5);
  });

  it("holds the card size still while a node is being dragged", async () => {
    commandMocks.listGraphSnapshot.mockResolvedValue(
      makeSnapshot(graphCardNode("alpha-card", "Alpha card")),
    );
    renderGraph();
    await screen.findByRole("button", { name: "Alpha card" });

    fireEvent.click(screen.getByTestId("graph-node-drag"));
    const duringDrag = drawnCardSize();
    // Dragging reheats the simulation and the engine stops between mouse
    // moves; each stop used to resize every card on screen.
    fireEvent.click(screen.getByTestId("graph-engine-stop"));
    fireEvent.click(screen.getByTestId("graph-render-frame"));

    expect(drawnCardSize()).toBe(duringDrag);
  });

  it("draws a card at the size the one source decides, never the bare constant", async () => {
    commandMocks.listGraphSnapshot.mockResolvedValue(
      makeSnapshot(graphCardNode("alpha-card", "Alpha card")),
    );
    renderGraph();
    await screen.findByRole("button", { name: "Alpha card" });

    // Sizing lives in `graphNodeScreenSize` and is unit-tested there; what this
    // guards is that painting asks it rather than reaching for the constant,
    // which is how the hit area and the drawn square used to drift apart.
    const painted = drawnCardSize();
    expect(painted).toBeGreaterThanOrEqual(32);
    expect(painted).toBeLessThanOrEqual(100);
  });

  it("lights a card's frame on hover, in the same highlight the pills use", async () => {
    commandMocks.listGraphSnapshot.mockResolvedValue(
      makeSnapshot(graphCardNode("alpha-card", "Alpha card")),
    );
    // Hovering a card also schedules its preview, which asks for the block.
    commandMocks.getBlock.mockResolvedValue(null);
    renderGraph();
    const card = await screen.findByRole("button", { name: "Alpha card" });

    const strokes = (): string[] => {
      const drawn: string[] = [];
      const context = {
        globalAlpha: 1, filter: "none", fillStyle: "", strokeStyle: "", lineWidth: 1,
        font: "", textAlign: "start", textBaseline: "alphabetic",
        save() {}, restore() {}, beginPath() {}, closePath() {}, clip() {},
        translate() {}, scale() {}, setLineDash() {}, fill() {}, fillText() {},
        moveTo() {}, lineTo() {}, arcTo() {}, arc() {}, rect() {},
        fillRect() {}, strokeRect() {}, drawImage() {},
        measureText: () => ({ width: 40 }),
        stroke() { drawn.push(String(this.strokeStyle)); },
      };
      const node = graphDataSpy.current?.nodes.find((n) => n.id === "card:alpha-card");
      paintSpy.current?.(node as never, context as never, 1);
      return drawn;
    };

    // No picture is loaded here: the card stands on the chrome with the
    // line for a frame (09.10.2026), and the pointer lights that frame.
    const rest = strokes();
    expect(rest).toHaveLength(1);
    fireEvent.mouseEnter(card);
    const hovered = strokes();
    expect(hovered).toHaveLength(1);
    expect(hovered[0]).not.toBe(rest[0]);
  });

  it("dims all but the attended collection, its cards and its membership lines, by the hover intent engine; a card dims nothing (16.10.2026)", async () => {
    // SPEC_GRAPH_VIEW.md, «Приглушение при наведении на коллекцию». The theme
    // probe resolves the line as a browser would: jsdom leaves `var()` as it is.
    const realComputedStyle = window.getComputedStyle.bind(window);
    const computedStyle = vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      const style = realComputedStyle(element, pseudo);
      return new Proxy(style, {
        get: (target, property) => (property === "borderTopColor"
          ? "oklch(0.9394 0 0)"
          : Reflect.get(target, property, target)),
      });
    });
    const collection = (name: string): GraphNode => ({
      id: `collection:${name}`,
      kind: "collection",
      label: name,
      slug: null,
      collection_ref: name,
      card_kind: null,
      block_type: null,
      thumbnail: null,
      preview_manifest: null,
      degree: 2,
    });
    const membership = (name: string, slug: string): GraphLink => ({
      id: `membership:${name}:${slug}`,
      kind: "collection_membership",
      source: `collection:${name}`,
      target: `card:${slug}`,
      directed: false,
      count: 1,
      target_ref: null,
    });
    const links: GraphLink[] = [
      membership("Design", "a"),
      membership("Design", "b"),
      membership("Research", "c"),
      membership("Research", "a"),
      {
        id: "wikilink:a:b",
        kind: "wikilink",
        source: "card:a",
        target: "card:b",
        directed: true,
        count: 1,
        target_ref: "b",
      },
    ];
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes(
      [
        graphCardNode("a", "Card A"),
        graphCardNode("b", "Card B"),
        graphCardNode("c", "Card C"),
        collection("Design"),
        collection("Research"),
      ],
      { links, visible_links: links.length, total_links: links.length },
    ));
    commandMocks.getBlock.mockResolvedValue(null);
    try {
      renderGraph();
      await screen.findByRole("button", { name: "Card A" });

      // The alpha a node's own paint ends at; the canvas underlay of a dimmed
      // node is painted before it, at full alpha.
      const alphaOf = (id: string): number => {
        let alpha = 1;
        const stack: number[] = [];
        const context = {
          globalAlpha: 1, filter: "none", fillStyle: "", strokeStyle: "", lineWidth: 1,
          font: "", textAlign: "start", textBaseline: "alphabetic",
          save() { stack.push(this.globalAlpha); },
          restore() { this.globalAlpha = stack.pop() ?? 1; },
          beginPath() {}, closePath() {}, clip() {}, translate() {}, scale() {},
          setLineDash() {}, fill() {}, fillText() {}, moveTo() {}, lineTo() {},
          arcTo() {}, arc() {}, rect() {}, fillRect() {}, strokeRect() {}, drawImage() {},
          measureText: () => ({ width: 40 }),
          stroke() { alpha = this.globalAlpha; },
        };
        const node = graphDataSpy.current?.nodes.find((candidate) => candidate.id === id);
        paintSpy.current?.(node as never, context as never, 1);
        return alpha;
      };
      const ids = ["collection:Design", "collection:Research", "card:a", "card:b", "card:c"];
      const canvas = () => screen.getByTestId("force-graph");
      const node = (name: string) => screen.getByRole("button", { name });
      // Off a node onto the empty canvas, which unhovers it.
      const leaveForCanvas = (name: string) => fireEvent.mouseLeave(node(name), { relatedTarget: canvas() });
      const alphas = () => Object.fromEntries(ids.map((id) => [id, alphaOf(id)]));
      const colorOf = (id: string) => linkColorSpy.current?.(links.find((link) => link.id === id)!);
      const lit = colorOf("membership:Design:a");
      // The layout's first reheat waits for a frame: let it pass before the
      // count that dimming must leave alone.
      await act(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }));
      const reheats = graphMethodMocks.d3ReheatSimulation.mock.calls.length;
      const atRest = alphas();
      expect(Object.values(atRest).every((alpha) => alpha === 1)).toBe(true);

      const settle = async (ms: number) => {
        await act(async () => {
          vi.advanceTimersByTime(ms);
          await Promise.resolve();
        });
      };
      // The pointer moves along y = 10 over the graph, one step a frame.
      let pointerX = 0;
      const step = async (dx: number) => {
        await settle(16);
        pointerX += dx;
        fireEvent.pointerMove(canvas(), { clientX: pointerX, clientY: 10 });
      };

      // The dimming answers the shared hover intent engine, not the raw hover
      // (SPEC_CARD_STATES.md, С7; SPEC_GRAPH_VIEW.md, «Hover»).
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance", "Date", "requestAnimationFrame", "cancelAnimationFrame"],
      });
      try {
        // A sweep straight across Design dims nothing, on the way or after.
        fireEvent.mouseEnter(node("Design"));
        for (let elapsed = 0; elapsed < HOVER_INTENT.dwellMs * 2; elapsed += 16) {
          await step(40);
          expect(alphas()).toEqual(atRest);
        }
        leaveForCanvas("Design");
        for (let elapsed = 0; elapsed < HOVER_INTENT.dwellMs; elapsed += 16) await step(40);
        await settle(HOVER_INTENT.warmMs * 2);
        expect(alphas()).toEqual(atRest);

        // A pointer resting on Design dims the rest after the engine's dwell,
        // not before.
        fireEvent.mouseEnter(node("Design"));
        await settle(HOVER_INTENT.dwellMs - 20);
        expect(alphas()).toEqual(atRest);
        await settle(40);
        const dimmed = alphas();
        expect(dimmed["collection:Design"]).toBe(1);
        expect(dimmed["card:a"]).toBe(1);
        expect(dimmed["card:b"]).toBe(1);
        expect(dimmed["collection:Research"]).toBe(DEEMPHASIZED_OPACITY);
        expect(dimmed["card:c"]).toBe(DEEMPHASIZED_OPACITY);
        expect(colorOf("membership:Design:a")).toBe(lit);
        expect(colorOf("membership:Design:b")).toBe(lit);
        // Strict: neither the wikilink between two of its cards nor a member's
        // line to another collection belongs to the hovered collection.
        expect(colorOf("wikilink:a:b")).not.toBe(lit);
        expect(colorOf("membership:Research:a")).not.toBe(lit);
        expect(colorOf("membership:Research:c")).toBe(colorOf("wikilink:a:b"));
        // Dimming is paint only: the layout is not woken.
        expect(graphMethodMocks.d3ReheatSimulation.mock.calls.length).toBe(reheats);

        // Once Design has answered, its neighbour Research takes over at once,
        // and so does Design again.
        leaveForCanvas("Design");
        fireEvent.mouseEnter(node("Research"));
        await settle(0);
        expect(alphaOf("collection:Research")).toBe(1);
        expect(alphaOf("card:c")).toBe(1);
        expect(alphaOf("card:b")).toBe(DEEMPHASIZED_OPACITY);
        expect(alphaOf("collection:Design")).toBe(DEEMPHASIZED_OPACITY);
        leaveForCanvas("Research");
        fireEvent.mouseEnter(node("Design"));
        await settle(0);
        expect(alphas()).toEqual(dimmed);

        // A dragged node answers nothing: the dimming clears at once and
        // comes back after the dwell once the node is dropped (С7.8).
        fireEvent.click(screen.getByTestId("graph-node-drag"));
        await settle(0);
        expect(alphas()).toEqual(atRest);
        fireEvent.click(screen.getByTestId("graph-node-drag-end"));
        await settle(HOVER_INTENT.dwellMs + 20);
        expect(alphas()).toEqual(dimmed);

        // Leaving for the empty canvas clears it after the leave grace.
        leaveForCanvas("Design");
        await settle(HOVER_INTENT.leaveGraceMs - 20);
        expect(alphas()).toEqual(dimmed);
        await settle(40);
        expect(alphas()).toEqual(atRest);
        expect(colorOf("wikilink:a:b")).toBe(lit);

        // A selected card outside the hovered part dims like any other node.
        fireEvent.click(node("Card C"));
        fireEvent.mouseEnter(node("Design"));
        await settle(HOVER_INTENT.dwellMs + 20);
        expect(alphaOf("card:c")).toBe(DEEMPHASIZED_OPACITY);
        leaveForCanvas("Design");
        await settle(HOVER_INTENT.leaveGraceMs + 20);

        // A card dims nothing, however long the pointer rests on it.
        fireEvent.mouseEnter(node("Card A"));
        await settle(HOVER_INTENT.dwellMs * 2);
        expect(alphas()).toEqual(atRest);
        expect(colorOf("wikilink:a:b")).toBe(lit);
        expect(colorOf("membership:Research:c")).toBe(lit);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      computedStyle.mockRestore();
    }
  });

  it("draws no text under a card, selected or not", async () => {
    commandMocks.listGraphSnapshot.mockResolvedValue(
      makeSnapshot(graphCardNode("alpha-card", "Alpha card")),
    );
    renderGraph();
    const card = await screen.findByRole("button", { name: "Alpha card" });
    fireEvent.click(card);

    const texts: string[] = [];
    const context = {
      globalAlpha: 1, filter: "none", fillStyle: "", strokeStyle: "", lineWidth: 1,
      font: "", textAlign: "start", textBaseline: "alphabetic",
      save() {}, restore() {}, beginPath() {}, rect() {}, moveTo() {}, lineTo() {},
      arcTo() {}, arc() {}, closePath() {}, clip() {}, translate() {}, scale() {},
      drawImage() {}, fillRect() {}, strokeRect() {}, setLineDash() {}, fill() {}, stroke() {},
      measureText: () => ({ width: 40 }),
      fillText: (value: string) => { texts.push(value); },
    };
    const node = graphDataSpy.current?.nodes.find((n) => n.id === "card:alpha-card");
    paintSpy.current?.(node as never, context as never, 1);

    // The selection outline says which node is selected; a caption repeated it a
    // second time, in text squeezed to 180px until it was unreadable.
    expect(texts).toEqual([]);
  });

  it("hands the canvas the same nodes when an identical snapshot arrives", async () => {
    // Regaining window focus refreshes the vault and the graph receives an
    // equal snapshot as a fresh object. The canvas restarts its simulation
    // whenever the node array changes identity, which is the twitch the user
    // saw on every switch back to the window.
    const card = graphCardNode("alpha-card", "Alpha card");
    commandMocks.listGraphSnapshot.mockImplementation(async () =>
      makeSnapshot(graphCardNode("alpha-card", "Alpha card")));

    renderGraph();
    await screen.findByRole("button", { name: "Alpha card" });
    const before = graphDataSpy.current?.nodes;

    // A refresh identical in content, exactly what a focus change produces.
    window.dispatchEvent(new Event("vault-refreshed"));
    await waitFor(() => expect(commandMocks.listGraphSnapshot).toHaveBeenCalledTimes(2));

    expect(graphDataSpy.current?.nodes).toBe(before);
    void card;
  });

  it("aims the centring force at the pinned collection, not at the origin", async () => {
    const card = graphCardNode("alpha-card", "Alpha card");
    const collection: GraphNode = {
      id: "collection:Design",
      kind: "collection",
      label: "Design",
      slug: null,
      collection_ref: "Design",
      card_kind: null,
      block_type: null,
      thumbnail: null,
      preview_manifest: null,
      degree: 1,
    };
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes([card, collection]));

    const { rerenderGraph } = renderGraph();
    await screen.findByRole("button", { name: "Alpha card" });
    const tick = screen.getByTestId("graph-engine-tick");
    fireEvent.click(tick);
    const resting = graphDataSpy.current?.nodes.find((node) => node.id === "collection:Design");
    const restingX = resting?.x as number;
    const restingY = resting?.y as number;
    expect(restingX).not.toBe(0);

    rerenderGraph({ currentCollection: "Design" });
    await waitFor(() => expect(graphMethodMocks.d3ReheatSimulation).toHaveBeenCalled());
    fireEvent.click(tick);

    // Anchored in one place and pulled toward another, the free nodes drift in
    // that direction for as long as the simulation runs.
    await waitFor(() => {
      expect(centerAimSpy.current.x).toBe(restingX);
      expect(centerAimSpy.current.y).toBe(restingY);
    });
  });

  it("pins the opened collection where it already stands and never teleports it", async () => {
    const card = graphCardNode("alpha-card", "Alpha card");
    const collection: GraphNode = {
      id: "collection:Design",
      kind: "collection",
      label: "Design",
      slug: null,
      collection_ref: "Design",
      card_kind: null,
      block_type: null,
      thumbnail: null,
      preview_manifest: null,
      degree: 1,
    };
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes([card, collection]));

    const { rerenderGraph } = renderGraph();
    await screen.findByRole("button", { name: "Alpha card" });
    // One tick is what gives the nodes their resting places; without it there
    // is nothing to pin to, and the old code invented the origin instead.
    fireEvent.click(screen.getByTestId("graph-engine-tick"));

    const resting = graphDataSpy.current?.nodes.find((node) => node.id === "collection:Design");
    const restingX = resting?.x as number;
    const restingY = resting?.y as number;
    expect(Number.isFinite(restingX)).toBe(true);

    rerenderGraph({ currentCollection: "Design" });
    await waitFor(() => {
      const focused = graphDataSpy.current?.nodes.find((node) => node.id === "collection:Design");
      expect(focused?.fx).toBe(restingX);
      expect(focused?.fy).toBe(restingY);
    });
  });

  it("moves the camera once to the opened collection instead of refitting the graph", async () => {
    const card = graphCardNode("alpha-card", "Alpha card");
    const collection: GraphNode = {
      id: "collection:Design",
      kind: "collection",
      label: "Design",
      slug: null,
      collection_ref: "Design",
      card_kind: null,
      block_type: null,
      thumbnail: null,
      preview_manifest: null,
      degree: 1,
    };
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes([card, collection]));

    const { rerenderGraph } = renderGraph();
    await screen.findByRole("button", { name: "Alpha card" });
    const tick = screen.getByTestId("graph-engine-tick");
    fireEvent.click(tick);
    const resting = graphDataSpy.current?.nodes.find((node) => node.id === "collection:Design");
    const restingX = resting?.x as number;
    const restingY = resting?.y as number;

    graphMethodMocks.zoomToFit.mockReset();
    graphMethodMocks.centerAt.mockReset();
    rerenderGraph({ currentCollection: "Design" });
    await waitFor(() => expect(graphMethodMocks.d3ReheatSimulation).toHaveBeenCalled());

    for (let index = 0; index < 25; index += 1) fireEvent.click(tick);

    expect(graphMethodMocks.centerAt).toHaveBeenCalledWith(restingX, restingY, 0);
    expect(graphMethodMocks.centerAt).toHaveBeenCalledTimes(1);
    // Two cameras on one navigation is what made the graph look like it flew
    // apart: the fit rescaled the view while the glide was still running.
    expect(graphMethodMocks.zoomToFit).not.toHaveBeenCalled();
  });

  it("derives current-route scope from the active collection without a mode switch", async () => {
    commandMocks.listGraphSnapshot.mockResolvedValue(
      makeSnapshot(graphCardNode("alpha-card", "Alpha card")),
    );
    renderGraph({ currentCollection: "Design" });

    await waitFor(() => {
      expect(commandMocks.listGraphSnapshot).toHaveBeenCalledWith(
        {
          kind: "current_route",
          collection_ref: "Design",
        },
        expect.any(Object),
      );
    });
  });

  it("renders no graph-local search, scope selector, settings trigger or Unresolved option", async () => {
    commandMocks.listGraphSnapshot.mockResolvedValue(
      makeSnapshot(graphCardNode("alpha-card", "Alpha card")),
    );
    renderGraph();
    await screen.findByRole("button", { name: "Alpha card" });

    expect(screen.queryByRole("searchbox", { name: "Search graph" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Graph filters" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Route" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Library" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ego" })).not.toBeInTheDocument();
    expect(screen.queryByText("Unresolved")).not.toBeInTheDocument();
  });

  it("reloads the projection when the settings owner passes new graph preferences", async () => {
    commandMocks.listGraphSnapshot.mockResolvedValue(
      makeSnapshot(graphCardNode("alpha-card", "Alpha card")),
    );
    const { rerenderGraph } = renderGraph();
    await screen.findByRole("button", { name: "Alpha card" });

    rerenderGraph({
      graphPreferences: {
        include_wikilinks: false,
        include_related_notes: true,
      },
    });

    await waitFor(() => {
      expect(commandMocks.listGraphSnapshot).toHaveBeenLastCalledWith(
        expect.any(Object),
        expect.objectContaining({ include_wikilinks: false }),
      );
    });
  });

  it("always asks for collections, whatever an older preference object still holds (Панель графа)", async () => {
    commandMocks.listGraphSnapshot.mockResolvedValue(
      makeSnapshot(graphCardNode("alpha-card", "Alpha card")),
    );
    // Saved before 11.10.2026, when collections had a switch.
    const legacy = { include_collections: false, include_wikilinks: true, include_related_notes: true };

    renderGraph({ graphPreferences: legacy });
    await screen.findByRole("button", { name: "Alpha card" });

    const options = commandMocks.listGraphSnapshot.mock.lastCall?.[1];
    expect(options).toEqual({
      include_wikilinks: true,
      include_related_notes: true,
      materialize_large_library: false,
    });
    expect(options).not.toHaveProperty("include_collections");
  });

  it("asks for the graph again as soon as a switch in the Display panel changes (Панель графа)", async () => {
    commandMocks.listGraphSnapshot.mockResolvedValue(
      makeSnapshot(graphCardNode("alpha-card", "Alpha card")),
    );
    // How App wires them: the page's preferences go straight into the graph.
    function GraphWithPanel() {
      const graphPreferences = useGraphPreferences();
      return (
        <>
          <GraphDisplayMenu />
          <GraphView
            vaultPath="/vault"
            loadedBlocks={[]}
            thumbVersions={new Map()}
            graphPreferences={graphPreferences}
            onOpenBlock={vi.fn()}
            onOpenCardMenu={vi.fn()}
            onNavigateCollection={vi.fn()}
          />
        </>
      );
    }
    try {
      render(<GraphWithPanel />);
      await screen.findByRole("button", { name: "Alpha card" });
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Display options" }));

      await user.click(screen.getByRole("menuitemcheckbox", { name: "Wikilinks" }));
      await waitFor(() => {
        expect(commandMocks.listGraphSnapshot).toHaveBeenLastCalledWith(
          expect.any(Object),
          { include_wikilinks: false, include_related_notes: true, materialize_large_library: false },
        );
      });

      await user.click(screen.getByRole("menuitemcheckbox", { name: "Related notes" }));
      await waitFor(() => {
        expect(commandMocks.listGraphSnapshot).toHaveBeenLastCalledWith(
          expect.any(Object),
          { include_wikilinks: false, include_related_notes: false, materialize_large_library: false },
        );
      });
    } finally {
      localStorage.clear();
      reloadGraphPreferences();
    }
  });

  describe("new lines over the same nodes (Панель графа, ГП4)", () => {
    const design: GraphNode = {
      id: "collection:Design",
      kind: "collection",
      label: "Design",
      slug: null,
      collection_ref: "Design",
      card_kind: null,
      block_type: null,
      thumbnail: null,
      preview_manifest: null,
      degree: 1,
    };
    const nodes = () => [graphCardNode("alpha-card", "Alpha card"), graphCardNode("beta-card", "Beta card"), design];
    const membership: GraphLink = {
      id: "collection_membership|collection:Design|card:alpha-card",
      kind: "collection_membership",
      source: "collection:Design",
      target: "card:alpha-card",
      directed: false,
      count: 1,
      target_ref: "Design",
    };
    const wikilink = (source: string, target: string): GraphLink => ({
      id: `wikilink|card:${source}|card:${target}`,
      kind: "wikilink",
      source: `card:${source}`,
      target: `card:${target}`,
      directed: true,
      count: 1,
      target_ref: target,
    });
    const snapshotWith = (links: GraphLink[]) => makeSnapshotFromNodes(
      nodes(),
      { links, visible_links: links.length, total_links: links.length },
    );
    const lines = () => (graphDataSpy.current as unknown as { links: GraphLink[] }).links.map((link) => link.id);
    const positions = () => Object.fromEntries(
      (graphDataSpy.current?.nodes ?? []).map((node) => [node.id, [node.x, node.y]]),
    );
    const ticks = (count: number) => {
      const tick = screen.getByTestId("graph-engine-tick");
      for (let index = 0; index < count; index += 1) fireEvent.click(tick);
    };

    it("switching a kind off takes its lines away and leaves the layout and the camera where they are", async () => {
      commandMocks.listGraphSnapshot.mockImplementation(async (_scope, options) => snapshotWith(
        options.include_wikilinks ? [membership, wikilink("alpha-card", "beta-card")] : [membership],
      ));
      const { rerenderGraph } = renderGraph();
      await screen.findByRole("button", { name: "Alpha card" });
      await waitFor(() => expect(graphMethodMocks.d3ReheatSimulation).toHaveBeenCalled());
      // The first layout spends its camera plan and comes to rest.
      ticks(25);
      fireEvent.click(screen.getByTestId("graph-engine-stop"));
      const atRest = positions();
      graphMethodMocks.d3ReheatSimulation.mockClear();
      graphMethodMocks.centerAt.mockClear();
      graphMethodMocks.zoom.mockClear();

      rerenderGraph({ graphPreferences: { include_wikilinks: false, include_related_notes: true } });
      await waitFor(() => expect(lines()).toEqual([membership.id]));
      // The canvas reheats on new data by itself; it is told to stop before
      // the first tick, and nothing else wakes the simulation.
      expect(screen.getByTestId("force-graph")).toHaveAttribute("data-cooldown-ticks", "0");
      expect(positions()).toEqual(atRest);
      ticks(25);
      expect(graphMethodMocks.d3ReheatSimulation).not.toHaveBeenCalled();
      expect(graphMethodMocks.centerAt).not.toHaveBeenCalled();
      expect(graphMethodMocks.zoom).not.toHaveBeenCalled();

      // Once the engine has stopped, a drag runs the simulation as always.
      fireEvent.click(screen.getByTestId("graph-engine-stop"));
      expect(screen.getByTestId("force-graph")).toHaveAttribute("data-cooldown-ticks", "Infinity");

      rerenderGraph({ graphPreferences: { include_wikilinks: true, include_related_notes: true } });
      await waitFor(() => expect(lines()).toEqual([membership.id, wikilink("alpha-card", "beta-card").id]));
      expect(screen.getByTestId("force-graph")).toHaveAttribute("data-cooldown-ticks", "0");
      expect(graphMethodMocks.d3ReheatSimulation).not.toHaveBeenCalled();
    });

    it("lets a layout still settling run on when new lines arrive", async () => {
      commandMocks.listGraphSnapshot.mockImplementation(async (_scope, options) => snapshotWith(
        options.include_wikilinks ? [membership, wikilink("alpha-card", "beta-card")] : [membership],
      ));
      const { rerenderGraph } = renderGraph();
      await screen.findByRole("button", { name: "Alpha card" });
      ticks(3);

      rerenderGraph({ graphPreferences: { include_wikilinks: false, include_related_notes: true } });
      await waitFor(() => expect(lines()).toEqual([membership.id]));
      expect(screen.getByTestId("force-graph")).toHaveAttribute("data-cooldown-ticks", "Infinity");
    });

    it("hands over the same number of different lines", async () => {
      commandMocks.listGraphSnapshot.mockResolvedValue(snapshotWith([membership, wikilink("alpha-card", "beta-card")]));
      renderGraph();
      await screen.findByRole("button", { name: "Alpha card" });
      await waitFor(() => expect(lines()).toContain(wikilink("alpha-card", "beta-card").id));

      // A note now links the other way round: as many lines, not the same ones.
      commandMocks.listGraphSnapshot.mockResolvedValue(snapshotWith([membership, wikilink("beta-card", "alpha-card")]));
      act(() => {
        window.dispatchEvent(new Event("vault-refreshed"));
      });
      await waitFor(() => expect(lines()).toEqual([membership.id, wikilink("beta-card", "alpha-card").id]));
    });
  });

  it("has no keyboard surface: the graph is pointer-only", async () => {
    // Selection, opening and panning are cursor gestures. A keyboard surface
    // here would promise arrows that the contract deliberately does not offer.
    const alpha = makeBlock({ slug: "alpha-card", title: "Alpha card" });
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes([
      graphCardNode(alpha.slug, "Alpha card", { x: 100, y: 100 }),
    ]));
    renderGraph({ loadedBlocks: [alpha] });
    await screen.findByRole("button", { name: "Alpha card" });

    expect(document.querySelector("[data-graph-keyboard-surface]")).toBeNull();
    expect(document.querySelector("[aria-label='Graph canvas'][tabindex]")).toBeNull();
  });

  it("offers explicit full materialization only when the backend says it is available", async () => {
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes([], {
      truncated: true,
      truncation_reason: "large_library",
      can_materialize_full: true,
      total_nodes: 2_000,
    }));
    renderGraph();
    const showAll = await screen.findByRole("button", { name: "Show all" });

    fireEvent.click(showAll);

    await waitFor(() => {
      expect(commandMocks.listGraphSnapshot).toHaveBeenLastCalledWith(
        expect.any(Object),
        expect.objectContaining({ materialize_large_library: true }),
      );
    });
  });

  it("centers an externally selected node only after Detail closes and only when offscreen", async () => {
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshot(
      graphCardNode("alpha-card", "Alpha card", { x: 2_000, y: 100 }),
    ));
    const { rerenderGraph } = renderGraph({
      selectedSlug: "alpha-card",
      detailOpen: true,
    });
    await screen.findByRole("button", { name: "Alpha card" });
    expect(graphMethodMocks.centerAt).not.toHaveBeenCalled();

    rerenderGraph({ selectedSlug: "alpha-card", detailOpen: false });

    await waitFor(() => {
      expect(graphMethodMocks.centerAt).toHaveBeenCalledWith(2_000, 100, 0);
    });
  });

  it("keeps the camera still when a gesture lands before the queued centring frame (В5.5)", async () => {
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshot(
      graphCardNode("alpha-card", "Alpha card", { x: 2_000, y: 100 }),
    ));
    const { rerenderGraph } = renderGraph({ selectedSlug: "alpha-card", detailOpen: true });
    await screen.findByRole("button", { name: "Alpha card" });

    // Closing Detail queues the centring for the next frame; the person's
    // wheel arrives first and owns the camera from then on.
    rerenderGraph({ selectedSlug: "alpha-card", detailOpen: false });
    fireEvent.wheel(document.querySelector("[data-graph-view]")!);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(graphMethodMocks.centerAt).not.toHaveBeenCalled();
  });

  it("drops a centring that could not run yet once a gesture takes the camera (В5.5)", async () => {
    const graph = createRef<GraphViewHandle>();
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshot(
      graphCardNode("alpha-card", "Alpha card", { x: 100, y: 100 }),
    ));
    const { rerenderGraph } = renderGraph({ ref: graph });
    await screen.findByRole("button", { name: "Alpha card" });

    // The node is not in the graph yet, so the request waits.
    act(() => graph.current?.centerOnNode("card:late-card"));
    fireEvent.pointerDown(document.querySelector("[data-graph-view]")!);

    // The node arrives after the gesture: nothing may move the view for it.
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes([
      graphCardNode("alpha-card", "Alpha card", { x: 100, y: 100 }),
      graphCardNode("late-card", "Late card", { x: 3_000, y: 100 }),
    ]));
    rerenderGraph({
      ref: graph,
      graphPreferences: {
        include_wikilinks: false,
        include_related_notes: true,
      },
    });
    await screen.findByRole("button", { name: "Late card" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(graphMethodMocks.centerAt).not.toHaveBeenCalledWith(3_000, 100, 0);
  });

  it("lets a gesture stop a camera glide where it is (А5.2)", async () => {
    motionMocks.glide = true;
    try {
      commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshot(
        graphCardNode("alpha-card", "Alpha card", { x: 2_000, y: 100 }),
      ));
      const { rerenderGraph } = renderGraph({ selectedSlug: "alpha-card", detailOpen: true });
      await screen.findByRole("button", { name: "Alpha card" });
      rerenderGraph({ selectedSlug: "alpha-card", detailOpen: false });
      await waitFor(() => expect(graphMethodMocks.centerAt).toHaveBeenCalled());

      fireEvent.wheel(document.querySelector("[data-graph-view]")!);
      const calls = graphMethodMocks.centerAt.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(graphMethodMocks.centerAt.mock.calls.length).toBe(calls);
      expect(graphMethodMocks.centerAt).not.toHaveBeenCalledWith(2_000, 100, 0);
    } finally {
      motionMocks.glide = false;
    }
  });

  it("keeps the camera where a gesture left it when a later snapshot of the same route arrives (Г5.1)", async () => {
    const collection = (ref: string): GraphNode => ({
      id: `collection:${ref}`,
      kind: "collection",
      label: ref,
      slug: null,
      collection_ref: ref,
      card_kind: null,
      block_type: null,
      thumbnail: null,
      preview_manifest: null,
      degree: 1,
    });
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes([
      graphCardNode("alpha-card", "Alpha card"),
      collection("Design"),
    ]));
    const { rerenderGraph } = renderGraph({ currentCollection: "Design" });
    await screen.findByRole("button", { name: "Alpha card" });
    // The opened collection arms the glide to its pill; the person's wheel
    // takes the camera before the glide runs.
    await waitFor(() => expect(graphMethodMocks.d3ReheatSimulation).toHaveBeenCalled());
    fireEvent.wheel(document.querySelector("[data-graph-view]")!);

    // A clipper save refreshes the vault: the same route, a different layout.
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes([
      graphCardNode("alpha-card", "Alpha card"),
      graphCardNode("saved-card", "Saved card"),
      collection("Design"),
    ]));
    graphMethodMocks.d3ReheatSimulation.mockReset();
    act(() => {
      window.dispatchEvent(new Event("vault-refreshed"));
    });
    await screen.findByRole("button", { name: "Saved card" });
    await waitFor(() => expect(graphMethodMocks.d3ReheatSimulation).toHaveBeenCalled());
    const tick = screen.getByTestId("graph-engine-tick");
    for (let index = 0; index < 25; index += 1) fireEvent.click(tick);

    expect(graphMethodMocks.centerAt).not.toHaveBeenCalled();
    expect(graphMethodMocks.zoom).not.toHaveBeenCalled();

    // Another route is a new screen: its camera plan runs again.
    graphMethodMocks.d3ReheatSimulation.mockReset();
    rerenderGraph({ currentCollection: undefined });
    await waitFor(() => expect(graphMethodMocks.d3ReheatSimulation).toHaveBeenCalled());
    for (let index = 0; index < 25; index += 1) fireEvent.click(tick);

    expect(graphMethodMocks.centerAt).toHaveBeenCalledWith(100, 50, 0);
  });

  it("arms the camera again when the person returns to a route they had moved in (Г5.1)", async () => {
    const collection = (ref: string): GraphNode => ({
      id: `collection:${ref}`,
      kind: "collection",
      label: ref,
      slug: null,
      collection_ref: ref,
      card_kind: null,
      block_type: null,
      thumbnail: null,
      preview_manifest: null,
      degree: 1,
    });
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes([
      graphCardNode("alpha-card", "Alpha card"),
      collection("Design"),
    ]));
    const { rerenderGraph } = renderGraph();
    await screen.findByRole("button", { name: "Alpha card" });
    await waitFor(() => expect(graphMethodMocks.d3ReheatSimulation).toHaveBeenCalled());
    fireEvent.wheel(document.querySelector("[data-graph-view]")!);

    graphMethodMocks.d3ReheatSimulation.mockReset();
    rerenderGraph({ currentCollection: "Design" });
    await waitFor(() => expect(graphMethodMocks.d3ReheatSimulation).toHaveBeenCalled());
    graphMethodMocks.d3ReheatSimulation.mockReset();
    graphMethodMocks.centerAt.mockReset();
    rerenderGraph({ currentCollection: undefined });
    await waitFor(() => expect(graphMethodMocks.d3ReheatSimulation).toHaveBeenCalled());
    const tick = screen.getByTestId("graph-engine-tick");
    for (let index = 0; index < 25; index += 1) fireEvent.click(tick);

    expect(graphMethodMocks.centerAt).toHaveBeenCalledWith(100, 50, 0);
  });

  // The stuck preview of 16.10.2026 (SPEC_GRAPH_VIEW.md, «Hover»;
  // SPEC_CARD_STATES.md, С7.10). force-graph reads the node under the pointer
  // every frame at the last position its container heard (force-graph.mjs:
  // `pointerPos` is set by pointermove/pointerdown and never reset on leave;
  // `_animationCycle` calls `getObjUnderPointer`). So after the pointer leaves
  // the canvas, or an open card covers it, a node drifting under that old
  // point became hovered and opened its preview over the open card.
  it("closes the card preview when the pointer leaves the graph", async () => {
    const alpha = makeBlock({ slug: "alpha-card", title: "Alpha card" });
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes([
      graphCardNode("alpha-card", "Alpha card"),
    ]));
    const { container } = renderGraph({ loadedBlocks: [alpha] });
    const alphaNode = await screen.findByRole("button", { name: "Alpha card" });

    fireEvent.mouseEnter(alphaNode);
    await waitFor(() => {
      expect(container.querySelector("[data-graph-card-hover-preview]")).toBeInTheDocument();
    });

    // The pointer goes to the sidebar. The page fires pointerleave on the
    // graph's container; force-graph keeps its old point and reports no
    // hover change, so no onNodeHover(null) follows.
    fireEvent.pointerLeave(container.querySelector("[data-graph-view]")!);

    expect(container.querySelector("[data-graph-card-hover-preview]")).not.toBeInTheDocument();
  });

  it("opens no preview for a node drifting under the old pointer point while a card is open", async () => {
    const alpha = makeBlock({ slug: "alpha-card", title: "Alpha card" });
    const beta = makeBlock({ id: 2, slug: "beta-card", title: "Beta card" });
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes([
      graphCardNode("alpha-card", "Alpha card"),
      graphCardNode("beta-card", "Beta card"),
    ]));
    const { container, rerenderGraph } = renderGraph({ loadedBlocks: [alpha, beta] });
    const betaNode = await screen.findByRole("button", { name: "Beta card" });

    // A card opened over the graph (Detail, `absolute inset-0 z-10` in the
    // same <main>); the graph stays mounted under it.
    rerenderGraph({ loadedBlocks: [alpha, beta], detailOpen: true });
    // The layout moves (the open card was connected to a collection in the
    // sidebar, the simulation reheats): beta drifts under the old point.
    fireEvent.mouseEnter(betaNode);
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector("[data-graph-card-hover-preview]")).not.toBeInTheDocument();
  });

  it("stops hearing the pointer off the graph and under an open card, and forgets what it hovered", async () => {
    const collection: GraphNode = {
      id: "collection:Design",
      kind: "collection",
      label: "Design",
      slug: null,
      collection_ref: "Design",
      card_kind: null,
      block_type: null,
      thumbnail: null,
      preview_manifest: null,
      degree: 1,
    };
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes(
      [graphCardNode("alpha-card", "Alpha card"), collection],
    ));
    const { container, rerenderGraph } = renderGraph();
    await screen.findByRole("button", { name: "Alpha card" });
    const surface = container.querySelector("[data-graph-view]")!;
    const graph = () => screen.getByTestId("force-graph");
    const pill = () => graphDataSpy.current?.nodes.find(
      (node) => node.id === "collection:Design",
    ) as MockGraphNode;
    const resting = paintPill(pill());
    expect(graph()).toHaveAttribute("data-pointer-interaction", "true");

    // A hovered collection lights its pill; leaving the graph unlights it
    // (and with it the collection's dimming) although the library reports
    // nothing, and the library stops reading its stale point.
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Design" }));
    expect(paintPill(pill()).stroke).not.toBe(resting.stroke);
    fireEvent.pointerLeave(surface);
    expect(paintPill(pill()).stroke).toBe(resting.stroke);
    expect(graph()).toHaveAttribute("data-pointer-interaction", "false");

    // Back over the graph it listens again, and the same pill hovers again.
    fireEvent.pointerEnter(surface);
    expect(graph()).toHaveAttribute("data-pointer-interaction", "true");
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Design" }));
    expect(paintPill(pill()).stroke).not.toBe(resting.stroke);

    // An open card covers the graph: the same as the pointer leaving.
    rerenderGraph({ detailOpen: true });
    expect(paintPill(pill()).stroke).toBe(resting.stroke);
    expect(graph()).toHaveAttribute("data-pointer-interaction", "false");
    rerenderGraph({ detailOpen: false });
    expect(graph()).toHaveAttribute("data-pointer-interaction", "true");
  });
});
