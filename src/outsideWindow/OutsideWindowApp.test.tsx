import { act, render, screen, waitFor } from "@testing-library/react";
import { THEME_STORAGE_KEY } from "@/lib/themeMode";
import type { LightBlock, OutsidePageMessage, OutsidePageReport } from "@/types";

type Handler = (event: { payload: unknown }) => void;
const heard = vi.hoisted(() => new Map<string, Handler>());

vi.mock("@/lib/pageEvents", () => ({
  listenPage: (event: string, handler: Handler) => {
    heard.set(event, handler);
    return Promise.resolve(() => undefined);
  },
}));

const { OutsideWindowApp, collectionContent } = await import("./OutsideWindowApp");

function send(message: OutsidePageMessage) {
  act(() => heard.get("outside-window-message")?.({ payload: message }));
}

const CARD = {
  id: 1,
  slug: "a-note",
  block_type: "article",
  card_kind: "article",
  title: "A note kept for later",
  content_heading: null,
  display_title: "A note kept for later",
  fallback_label: "a-note",
  url: null,
  media_file: null,
  thumbnail: null,
  saved_at: "2026-11-16T10:00:00Z",
  width: null,
  height: null,
  author: null,
  body: "The first lines.",
  preview_text: "The first lines.",
  first_image: null,
  media_urls: null,
  media_dimensions: null,
  preview_manifest: null,
  feed_playback: null,
  collections: [],
  search_match: null,
} satisfies LightBlock;

describe("the outside window's page (SPEC_OUTSIDE_WINDOW.md, НО1, НО6)", () => {
  beforeEach(() => {
    heard.clear();
  });

  it("says it listens once it is subscribed, and draws a showing's card where the backend says", async () => {
    const told: OutsidePageReport[] = [];
    render(<OutsideWindowApp tell={(report) => told.push(report)} />);
    await waitFor(() => expect(told).toContainEqual({ kind: "ready" }));
    expect(document.querySelector("[data-hover-preview-window]")).toBeNull();

    send({ kind: "preview", session: 1, area: { left: 22, top: 22, right: 262, bottom: 1102 }, look: { vault_path: "/vault", thumbs_root_path: null, collection_order: [] } });
    send({
      kind: "preview_step",
      session: 1,
      number: 1,
      step: { kind: "offer", key: "row", trigger: { x: -300, y: 380, width: 280, height: 40 }, content: { kind: "card", block: CARD, thumb_version: null } },
    });
    await waitFor(() => expect(told.some((report) => report.kind === "preview" && report.report.event?.kind === "settled")).toBe(true));
    expect(screen.getByText("A note kept for later")).toBeInTheDocument();
    expect(document.querySelector("[data-outside-preview]")).not.toBeNull();

    send({ kind: "end", session: 1, reason: "window" });
    expect(document.querySelector("[data-hover-preview-window]")).toBeNull();
  });

  it("draws the dragged card at the frame's spot, says when it is drawn, and drops it at the drag's end (ПК1, ПК2)", async () => {
    const told: OutsidePageReport[] = [];
    render(<OutsideWindowApp tell={(report) => told.push(report)} />);
    await waitFor(() => expect(told).toContainEqual({ kind: "ready" }));
    send({
      kind: "drag",
      session: 7,
      at: { x: 34, y: 44 },
      stack: { blocks: [CARD], thumb_versions: [null], look: { vault_path: "/vault", thumbs_root_path: null, collection_order: [] } },
    });
    const card = document.querySelector<HTMLElement>("[data-outside-drag]");
    expect(card).not.toBeNull();
    expect(card!.style.left).toBe("34px");
    expect(card!.style.top).toBe("44px");
    expect(screen.getByText("A note kept for later")).toBeInTheDocument();
    await waitFor(() => expect(told).toContainEqual({ kind: "drag_shown", session: 7 }));
    send({ kind: "drag_end", session: 6 });
    expect(document.querySelector("[data-outside-drag]")).not.toBeNull();
    send({ kind: "drag_end", session: 7 });
    expect(document.querySelector("[data-outside-drag]")).toBeNull();
  });

  it("turns the backend's collection into the window's own content (С7.12)", () => {
    expect(collectionContent({
      row_key: "tag:Reading",
      name: "Reading",
      count: 2,
      cards: [{ slug: null, url: "asset://a", text: true, has_thumb: false }],
      placeholders: 1,
    })).toEqual({
      kind: "collection",
      rowKey: "tag:Reading",
      name: "Reading",
      count: 2,
      cards: [{ slug: undefined, url: "asset://a", text: true, hasThumb: false }],
      placeholders: 1,
    });
  });
});

describe("the outside window's entry", () => {
  it("applies the stored look before the first render and renders the page into #root", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    document.documentElement.removeAttribute("data-theme");
    document.body.innerHTML = '<div id="root"></div>';
    await act(async () => {
      await import("./main");
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    localStorage.clear();
  }, 30_000);
});
