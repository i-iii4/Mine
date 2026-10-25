// The sidebar's thumbnail strip draws as many cards as its width holds, from
// the whole list the preview read gives (SPEC_SIDEBAR_STRIP.md, приёмка 2
// and 3). The real Sidebar and useChannelPreviewsEvents; the read is a mock
// that counts its calls, and the test says how wide the strips are.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { DndContext } from "@dnd-kit/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { listChannelPreviews } from "@/lib/commands";
import { sidebarStripTileCount } from "@/lib/appLayout";
import { useChannelPreviewsEvents } from "@/hooks/useChannelPreviewsEvents";
import { installSidebarStripWidth, setSidebarStripWidth } from "@/test/sidebarStrip";
import type { ChannelPreviewsSnapshot, PreviewCard, TagCount } from "@/types";
import { Sidebar, SidebarTagRowDragPreview } from "./Sidebar";

vi.mock("@/lib/commands", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/commands")>(),
  listChannelPreviews: vi.fn(),
}));

const pageEvents = vi.hoisted(() => ({
  listeners: [] as Array<{ event: string; handler: (event: { payload: unknown }) => void }>,
}));

vi.mock("@/lib/pageEvents", () => ({
  listenPage: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    const listener = { event, handler };
    pageEvents.listeners.push(listener);
    return () => {
      pageEvents.listeners = pageEvents.listeners.filter((item) => item !== listener);
    };
  }),
}));

/** A strip of the narrowest table (`W_table`, light theme): 4 tiles. */
const TABLE_STRIP_PX = 125.6;
installSidebarStripWidth(TABLE_STRIP_PX);

const THUMBS = "/space/.mine/thumbs";
const MTIME = 7;

function tag(name: string, count: number): TagCount {
  return { tag: name, count };
}

/** `count` cards of `prefix`, newest first, as the read lists them. */
function slugs(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(3, "0")}`);
}

function snapshot(generation: number, lists: Record<string, string[]>): ChannelPreviewsSnapshot {
  return {
    generation,
    previews: Object.fromEntries(Object.entries(lists).map(([key, list]) => [
      key,
      list.map((slug) => ({ slug, text: false, mtime: MTIME, has_thumb: true })),
    ])),
  };
}

const read = {
  refresh: async () => {},
  bumpThumbVersion: (_slug: string) => {},
};

function Harness({ tags, total, previewsPending = false }: {
  tags: TagCount[];
  total: number;
  previewsPending?: boolean;
}) {
  const { channelPreviews, refresh, bumpThumbVersion } = useChannelPreviewsEvents({ thumbsRootPath: THUMBS });
  read.refresh = refresh;
  read.bumpThumbVersion = bumpThumbVersion;
  return (
    <MemoryRouter>
      <TooltipProvider>
        <DndContext>
          <Sidebar
            collapsed={false}
            widthAnimating={false}
            orderedTags={tags}
            channelPreviews={channelPreviews}
            previewsPending={previewsPending}
            totalBlocks={total}
            isDropDragging={false}
            isCreatingChannel={false}
            onSetCreatingChannel={vi.fn()}
            onDeleteTag={vi.fn()}
            onRenameTag={vi.fn()}
            onCreateChannel={vi.fn()}
          />
        </DndContext>
      </TooltipProvider>
    </MemoryRouter>
  );
}

const stripOf = (rowKey: string) =>
  document.querySelector(`[data-sidebar-row-key="${rowKey}"] [data-sidebar-thumbnail-strip]`) as HTMLElement;
const tileSlugs = (rowKey: string) =>
  Array.from(stripOf(rowKey).querySelectorAll("[data-sidebar-preview-thumbnail] img"), (image) => {
    const src = image.getAttribute("src") ?? "";
    return decodeURIComponent(src).replace(/^.*\//, "").replace(/\.micro\.jpg.*$/, "");
  });
/** Everything the strip's track holds: thumbnails and placeholders. */
const tilesOf = (rowKey: string) => stripOf(rowKey).querySelectorAll("[data-sidebar-strip-track] > *");
const placeholders = (rowKey: string) =>
  stripOf(rowKey).querySelectorAll("[data-sidebar-preview-placeholder]").length;

function announceThumbUpdated(slug: string) {
  act(() => {
    for (const listener of [...pageEvents.listeners]) {
      if (listener.event === "thumb:updated") listener.handler({ payload: { path: "/space", slug } });
    }
  });
}

const reads = () => vi.mocked(listChannelPreviews).mock.calls.length;

/** Renders the harness and waits for the first read to land. */
async function renderRead(lists: Record<string, string[]>, tags: TagCount[], total: number) {
  vi.mocked(listChannelPreviews).mockResolvedValueOnce(snapshot(1, lists));
  const view = render(<Harness tags={tags} total={total} />);
  await waitFor(() => expect(stripOf("all")).toHaveAttribute("data-sidebar-previews", "ready"));
  return view;
}

describe("N(W): the tiles a strip holds", () => {
  it("counts every whole tile and the one the edge cuts", () => {
    expect([88, 103.9, 104, 125.6, 1893].map(sidebarStripTileCount)).toEqual([3, 3, 4, 4, 53]);
  });

  it("holds none in a strip that is not laid out", () => {
    expect(sidebarStripTileCount(0)).toBe(0);
  });
});

describe("the sidebar's thumbnail strip (SPEC_SIDEBAR_STRIP.md)", () => {
  beforeEach(() => {
    vi.mocked(listChannelPreviews).mockReset();
    setSidebarStripWidth(TABLE_STRIP_PX);
  });
  afterEach(() => {
    pageEvents.listeners = [];
  });

  it("reads the whole list once and draws what the width holds, widening and narrowing without a read", async () => {
    const art = slugs("art", 100);
    await renderRead({ __all__: art, Art: art }, [tag("Art", 100)], 100);
    expect(listChannelPreviews).toHaveBeenCalledWith();
    expect(tileSlugs("tag:Art")).toEqual(art.slice(0, 4));
    expect(tileSlugs("all")).toEqual(art.slice(0, 4));

    // Widening draws the next cards of the list it has.
    setSidebarStripWidth(1893);
    expect(tileSlugs("tag:Art")).toEqual(art.slice(0, 53));
    // Narrowing takes the tiles past the edge off the page.
    setSidebarStripWidth(88);
    expect(tileSlugs("tag:Art")).toEqual(art.slice(0, 3));
    expect(reads()).toBe(1);
  });

  it("ends a list shorter than the strip early, with no placeholder after the pass", async () => {
    const short = slugs("short", 2);
    await renderRead({ __all__: short, Short: short }, [tag("Short", 2)], 2);
    setSidebarStripWidth(1893);
    expect(tileSlugs("tag:Short")).toEqual(short);
    expect(placeholders("tag:Short")).toBe(0);
  });

  it("draws placeholders by N(W) before the read, during the pass and none after it", async () => {
    let answer!: (value: ChannelPreviewsSnapshot) => void;
    vi.mocked(listChannelPreviews).mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const tags = [tag("Art", 10)];
    const { rerender } = render(<Harness tags={tags} total={10} previewsPending />);

    // Not answered: min(count, N(W)).
    setSidebarStripWidth(88);
    expect(placeholders("tag:Art")).toBe(3);
    setSidebarStripWidth(200);
    expect(placeholders("tag:Art")).toBe(sidebarStripTileCount(200));

    // The pass: the thumbnails first, then min(count, N(W)) − shown.
    await act(async () => {
      answer(snapshot(1, { __all__: slugs("art", 2), Art: slugs("art", 2) }));
    });
    expect(tileSlugs("tag:Art")).toHaveLength(2);
    expect(placeholders("tag:Art")).toBe(sidebarStripTileCount(200) - 2);
    setSidebarStripWidth(88);
    expect(placeholders("tag:Art")).toBe(1);

    // The pass is over: the real thumbnails only.
    rerender(<Harness tags={tags} total={10} />);
    expect(placeholders("tag:Art")).toBe(0);
    expect(reads()).toBe(1);
  });

  it("holds no tile while the strip is not laid out, and the table's count in the frame it comes back", async () => {
    const art = slugs("art", 40);
    await renderRead({ __all__: art, Art: art }, [tag("Art", 40)], 40);

    // The List look or the hidden column: the strip is 0 wide.
    setSidebarStripWidth(0);
    expect(tilesOf("tag:Art")).toHaveLength(0);
    expect(tilesOf("all")).toHaveLength(0);

    // Back to the table: the tiles are there as the width is.
    setSidebarStripWidth(TABLE_STRIP_PX);
    expect(tileSlugs("tag:Art")).toEqual(art.slice(0, 4));
    expect(reads()).toBe(1);
  });

  it("recounts on a change of theme without a read", async () => {
    const art = slugs("art", 20);
    await renderRead({ __all__: art, Art: art }, [tag("Art", 20)], 20);
    // The dark theme's strip is 4 px narrower than the light one's.
    setSidebarStripWidth(105);
    expect(tileSlugs("tag:Art")).toHaveLength(4);
    setSidebarStripWidth(101);
    expect(tileSlugs("tag:Art")).toHaveLength(3);
    expect(reads()).toBe(1);
  });

  it("puts a card an event added in its place and keeps the count by the width", async () => {
    const art = slugs("art", 10);
    await renderRead({ __all__: art, Art: art }, [tag("Art", 10)], 10);
    const added = ["art-new", ...art];

    vi.mocked(listChannelPreviews).mockResolvedValueOnce(snapshot(2, { __all__: added, Art: added }));
    await act(async () => { await read.refresh(); });

    expect(tileSlugs("tag:Art")).toEqual(added.slice(0, 4));
  });

  it("takes off a card an event removed and draws the next one from the list", async () => {
    const art = slugs("art", 10);
    await renderRead({ __all__: art, Art: art }, [tag("Art", 10)], 10);
    const removed = art.filter((slug) => slug !== "art-001");

    vi.mocked(listChannelPreviews).mockResolvedValueOnce(snapshot(2, { __all__: removed, Art: removed }));
    await act(async () => { await read.refresh(); });

    expect(tileSlugs("tag:Art")).toEqual(["art-000", "art-002", "art-003", "art-004"]);
  });

  it("keeps a row whose list did not change as it was", async () => {
    const art = slugs("art", 10);
    const city = slugs("city", 10);
    await renderRead({ __all__: [...art, ...city], Art: art, City: city }, [tag("Art", 10), tag("City", 10)], 20);
    const artTile = tilesOf("tag:Art")[0];
    const cityTile = tilesOf("tag:City")[0];
    const changed = ["city-new", ...city];

    vi.mocked(listChannelPreviews).mockResolvedValueOnce(snapshot(2, { __all__: [...art, ...changed], Art: art, City: changed }));
    await act(async () => { await read.refresh(); });

    expect(tilesOf("tag:Art")[0]).toBe(artTile);
    expect(tilesOf("tag:City")[0]).not.toBe(cityTile);
    expect(tileSlugs("tag:City")[0]).toBe("city-new");
  });

  it("lifts a copy of the row with the row's tiles and placeholders", () => {
    const cards: PreviewCard[] = slugs("art", 2).map((slug) => ({ slug, url: `/t/${slug}.micro.jpg`, text: false, hasThumb: true }));
    setSidebarStripWidth(200);
    const { container } = render(
      <SidebarTagRowDragPreview label="Art" count={10} cards={cards} previewsPending />,
    );
    const strip = container.querySelector("[data-sidebar-thumbnail-strip]") as HTMLElement;
    expect(strip.querySelectorAll("[data-sidebar-preview-thumbnail]")).toHaveLength(2);
    expect(strip.querySelectorAll("[data-sidebar-preview-placeholder]")).toHaveLength(sidebarStripTileCount(200) - 2);

    setSidebarStripWidth(88);
    expect(strip.querySelectorAll("[data-sidebar-strip-track] > *")).toHaveLength(3);
  });

  it("stacks the list's first three cards in the compact item, whatever the strip's width", async () => {
    const art = slugs("art", 10);
    await renderRead({ __all__: art, Art: art }, [tag("Art", 10)], 10);
    const stackCards = () =>
      document.querySelectorAll('[data-sidebar-row-key="tag:Art"] [data-sidebar-stack-card="trigger"]').length;
    expect(stackCards()).toBe(3);
    setSidebarStripWidth(1893);
    expect(stackCards()).toBe(3);
    setSidebarStripWidth(0);
    expect(stackCards()).toBe(3);
  });
});

describe("the strip's pictures (SPEC_SIDEBAR_STRIP.md, ЛМ4)", () => {
  beforeEach(() => {
    vi.mocked(listChannelPreviews).mockReset();
    setSidebarStripWidth(TABLE_STRIP_PX);
  });
  afterEach(() => {
    pageEvents.listeners = [];
  });

  const imageOf = (rowKey: string, index = 0) =>
    stripOf(rowKey).querySelectorAll("[data-sidebar-preview-thumbnail] img")[index] as HTMLImageElement | undefined;

  it("asks for the micro level, marked by the read's mtime, decoded off the main thread", async () => {
    const art = slugs("art", 4);
    await renderRead({ __all__: art, Art: art }, [tag("Art", 4)], 4);
    const image = imageOf("tag:Art");
    expect(image?.getAttribute("src")).toBe(`asset://localhost/${THUMBS}/art-000.micro.jpg?m=${MTIME}`);
    expect(image).toHaveAttribute("decoding", "async");
    expect(image).toHaveAttribute("loading", "lazy");
  });

  it("keeps the loading fill without the level and asks again after its card's thumb:updated, never for the full thumbnail", async () => {
    const art = slugs("art", 4);
    await renderRead({ __all__: art, Art: art }, [tag("Art", 4)], 4);
    const tile = tilesOf("tag:Art")[0] as HTMLElement;
    fireEvent.error(imageOf("tag:Art") as HTMLImageElement);
    // The tile is the picture's slot: no box of its own around the image.
    expect(tile).toHaveAttribute("data-micro-preview-state", "missing");
    expect(tile.querySelector("img")).toBeNull();

    // Another card's preview changes nothing.
    announceThumbUpdated("art-002");
    expect(tile.querySelector("img")).toBeNull();

    // The card's own: the page bumps its version and reads again.
    act(() => read.bumpThumbVersion("art-000"));
    announceThumbUpdated("art-000");
    vi.mocked(listChannelPreviews).mockResolvedValueOnce(snapshot(2, { __all__: art, Art: art }));
    await act(async () => { await read.refresh(); });

    const again = imageOf("tag:Art")?.getAttribute("src") ?? "";
    expect(again).toMatch(/\/art-000\.micro\.jpg\?v=1/);
    const sources = Array.from(document.querySelectorAll("[data-sidebar-thumbnail-strip] img"), (image) => image.getAttribute("src") ?? "");
    expect(sources.every((src) => src.includes(".micro.jpg"))).toBe(true);
  });

  it("gives a tile shown again after narrowing the same address", async () => {
    const art = slugs("art", 10);
    await renderRead({ __all__: art, Art: art }, [tag("Art", 10)], 10);
    setSidebarStripWidth(1893);
    const before = imageOf("tag:Art", 8)?.getAttribute("src");
    setSidebarStripWidth(88);
    expect(imageOf("tag:Art", 8)).toBeUndefined();
    setSidebarStripWidth(1893);
    expect(imageOf("tag:Art", 8)?.getAttribute("src")).toBe(before);
  });
});
