import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { GraphView } from "./GraphView";

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
  onBackgroundClick?: () => void;
  onEngineTick?: () => void;
  nodeCanvasObject?: (
    node: MockGraphNode,
    context: CanvasRenderingContext2D,
    globalScale: number,
  ) => void;
  linkCurvature?: (link: GraphLink) => number;
  linkLineDash?: (link: GraphLink) => number[] | null;
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

// The nodes the canvas was last handed. Positions live on these objects, so a
// test asserting where a node is pinned has to read the very objects d3 would.
const graphDataSpy = vi.hoisted(() => ({ current: null as { nodes: Array<Record<string, unknown>> } | null }));

// The painter itself, so a test can ask what a pill is actually drawn with
// rather than trusting a flag that claims it was highlighted.
const paintSpy = vi.hoisted(() => ({ current: null as MockGraphProps["nodeCanvasObject"] }));

const centerAimSpy = vi.hoisted(() => ({ current: { x: 0, y: 0 } }));

vi.mock("@/lib/commands", () => ({
  listGraphSnapshot: commandMocks.listGraphSnapshot,
  getBlock: commandMocks.getBlock,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));

vi.mock("@/lib/hoverPreviewTiming", () => ({
  getHoverPreviewOpenDelay: vi.fn(() => 0),
}));

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
      onBackgroundClick,
      onEngineTick,
      nodeCanvasObject,
      linkCurvature,
      linkLineDash,
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
        centerAt: (x?: number, y?: number, ms?: number) => {
          // Called without arguments this reads the camera centre; only a call
          // that moves it counts as a camera move.
          if (x === undefined) return { x: 0, y: 0 };
          graphMethodMocks.centerAt(x, y, ms);
          return undefined as never;
        },
      }));

      (graphData?.nodes ?? []).forEach((node, index) => {
        node.x ??= 100 + index * 40;
        node.y ??= 120;
      });
      graphDataSpy.current = graphData as never;
      paintSpy.current = nodeCanvasObject;
      const membershipLink = graphData?.links.find(
        (link) => link.kind === "collection_membership",
      );
      const referenceLink = graphData?.links.find(
        (link) => link.kind === "wikilink",
      );

      return React.createElement(
        "div",
        {
          "data-testid": "force-graph",
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
              onMouseLeave: () => onNodeHover?.(null),
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
  const context = {
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
  } as unknown as CanvasRenderingContext2D;
  paint(node, context, 1);
  return paintedAlpha;
}

function makeBlock(overrides: Partial<LightBlock> = {}): LightBlock {
  return {
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
    feed_playback: null,
    ...overrides,
  };
}

function makeIndexedBlock(block: LightBlock): IndexedBlock {
  return {
    ...block,
    description: null,
    source: null,
    thumb_format: null,
    thumb_mtime: 0,
    related_notes: [],
    body_hash: null,
    tags: [],
  };
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
        include_collections: true,
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
            include_collections: true,
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
    expect(graphMethodMocks.zoomToFit).not.toHaveBeenCalled();
    fireEvent.click(tick);

    expect(graphMethodMocks.zoomToFit).toHaveBeenCalledWith(250, 40);
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
        include_collections: true,
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

  it("draws a card at the size the one source decides, never the bare constant", async () => {
    commandMocks.listGraphSnapshot.mockResolvedValue(
      makeSnapshot(graphCardNode("alpha-card", "Alpha card")),
    );
    renderGraph();
    await screen.findByRole("button", { name: "Alpha card" });

    let painted = 0;
    const context = {
      globalAlpha: 1, filter: "none", fillStyle: "", strokeStyle: "", lineWidth: 1,
      font: "", textAlign: "start", textBaseline: "alphabetic",
      save() {}, restore() {}, beginPath() {}, rect() {}, moveTo() {}, lineTo() {},
      arcTo() {}, arc() {}, closePath() {}, clip() {}, translate() {}, scale() {},
      setLineDash() {}, fill() {}, stroke() {}, fillText() {}, drawImage() {},
      measureText: () => ({ width: 40 }),
      fillRect: (_x: number, _y: number, w: number) => { painted = w; },
      strokeRect: (_x: number, _y: number, w: number) => { painted = painted || w; },
    };
    const node = graphDataSpy.current?.nodes.find((n) => n.id === "card:alpha-card");
    paintSpy.current?.(node as never, context as never, 1);

    // Sizing lives in `graphNodeScreenSize` and is unit-tested there; what this
    // guards is that painting asks it rather than reaching for the constant,
    // which is how the hit area and the drawn square used to drift apart.
    expect(painted).toBeGreaterThanOrEqual(32);
    expect(painted).toBeLessThanOrEqual(100);
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

    expect(graphMethodMocks.centerAt).toHaveBeenCalledWith(restingX, restingY, 400);
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
        include_collections: true,
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

  it("shares one selected node between arrow navigation, status and Enter activation", async () => {
    const alpha = makeBlock({ slug: "alpha-card", title: "Alpha card" });
    const beta = makeBlock({ id: 2, slug: "beta-card", title: "Beta card" });
    commandMocks.listGraphSnapshot.mockResolvedValue(makeSnapshotFromNodes([
      graphCardNode(alpha.slug, "Alpha card", { x: 100, y: 100 }),
      graphCardNode(beta.slug, "Beta card", { x: 200, y: 100 }),
    ]));
    const { onOpenBlock } = renderGraph({ loadedBlocks: [alpha, beta] });
    await screen.findByRole("button", { name: "Alpha card" });
    const surface = document.querySelector<HTMLElement>("[data-graph-keyboard-surface]");
    expect(surface).not.toBeNull();

    fireEvent.keyDown(surface!, { key: "ArrowRight" });
    expect(screen.getByText("Alpha card, 1 neighbor")).toBeInTheDocument();
    fireEvent.keyDown(surface!, { key: "ArrowRight" });
    expect(screen.getByText("Beta card, 1 neighbor")).toBeInTheDocument();
    fireEvent.keyDown(surface!, { key: "Enter" });

    await waitFor(() => expect(onOpenBlock).toHaveBeenCalledWith(beta));
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
      expect(graphMethodMocks.centerAt).toHaveBeenCalledWith(2_000, 100, 400);
    });
  });
});
