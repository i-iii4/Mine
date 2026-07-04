import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphNode, GraphSnapshot, IndexedBlock, LightBlock } from "@/types";
import { GraphView } from "./GraphView";

type MockGraphNode = GraphNode & {
  x?: number;
  y?: number;
};

type MockGraphProps = {
  graphData?: {
    nodes: MockGraphNode[];
  };
  width?: number;
  height?: number;
  onNodeClick?: (node: MockGraphNode, event: MouseEvent) => void;
  onNodeRightClick?: (node: MockGraphNode, event: MouseEvent) => void;
  onNodeHover?: (node: MockGraphNode | null) => void;
};

type MockGraphHandle = {
  d3Force: (_name: string, _force?: unknown) => MockForceAccessor;
  zoomToFit: () => void;
  zoom: () => number;
  d3ReheatSimulation: () => void;
  graph2ScreenCoords: (x: number, y: number) => { x: number; y: number };
};

type MockForceAccessor = {
  strength: (_accessor: unknown) => MockForceAccessor;
  distanceMax: (_distance: number) => MockForceAccessor;
  distance: (_accessor: unknown) => MockForceAccessor;
};

const commandMocks = vi.hoisted(() => ({
  listGraphSnapshot: vi.fn<() => Promise<GraphSnapshot>>(),
  getBlock: vi.fn<(slug: string) => Promise<IndexedBlock | null>>(),
}));

const graphMethodMocks = vi.hoisted(() => ({
  zoomToFit: vi.fn(),
  d3ReheatSimulation: vi.fn(),
}));

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
  };

  const MockForceGraph2D = React.forwardRef<MockGraphHandle, MockGraphProps>(
    function MockForceGraph2D({
      graphData,
      width,
      height,
      onNodeClick,
      onNodeRightClick,
      onNodeHover,
    }, ref) {
      React.useImperativeHandle(ref, () => ({
        d3Force: () => forceAccessor,
        zoomToFit: graphMethodMocks.zoomToFit,
        zoom: () => 1,
        d3ReheatSimulation: graphMethodMocks.d3ReheatSimulation,
        graph2ScreenCoords: (x: number, y: number) => ({ x, y }),
      }));

      (graphData?.nodes ?? []).forEach((node, index) => {
        node.x ??= 100 + index * 40;
        node.y ??= 120;
      });

      return React.createElement(
        "div",
        {
          "data-testid": "force-graph",
          "data-width": String(width),
          "data-height": String(height),
        },
        (graphData?.nodes ?? []).map((node) =>
          React.createElement(
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
            },
            node.label,
          ),
        ),
      );
    },
  );

  return { default: MockForceGraph2D };
});

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

function makeSnapshotFromNodes(nodes: GraphNode[]): GraphSnapshot {
  return {
    nodes,
    links: [],
    total_cards: nodes.filter((node) => node.kind === "card").length,
    total_collections: nodes.filter((node) => node.kind === "collection").length,
    current_collection: null,
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
      expect(commandMocks.getBlock).toHaveBeenCalledWith(alpha.slug);
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
});
