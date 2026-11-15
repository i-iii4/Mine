// TRIAL (DESIGN_SYSTEM.md, «Меню карточки в отдельном окне: проба»): the feed
// card's menu in the menu panel, and on the page when the panel cannot take it.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { CardHoverMenu, CardPanelPointMenu } from "./CardHoverMenu";
import { getBlock } from "@/lib/commands";
import { MENU_MODE_STORAGE_KEY } from "@/lib/menuMode";
import {
  MENU_PANEL_ACTION_EVENT,
  MENU_PANEL_CLOSED_EVENT,
  MENU_PANEL_SHOWN_EVENT,
  decodeCardMenuPayload,
} from "@/lib/menuPanelProtocol";
import { resetMenuPanelSourceForTests } from "@/lib/menuPanelSource";
import { indexedBlock, lightBlock } from "@/test/blocks";

vi.mock("@/lib/commands", () => ({
  getBlock: vi.fn(async () => ({ tags: [] })),
  startWindowDrag: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
  revealItemInDir: vi.fn(async () => undefined),
}));

const block = lightBlock({ slug: "alpha-block", url: "https://example.com", collections: ["Web"] });

function backend(event: string, payload: unknown) {
  act(() => {
    window.dispatchEvent(new CustomEvent(event, { detail: { event, payload } }));
  });
}

function opens() {
  return vi.mocked(invoke).mock.calls.filter(([command]) => command === "menu_panel_open");
}

function openedPayload() {
  const args = opens()[0]?.[1] as { request: { payload: string } } | undefined;
  return args ? decodeCardMenuPayload(args.request.payload) : null;
}

function renderCard(handlers: { onRequestRename?: () => void } = {}) {
  return render(
    <CardHoverMenu
      block={block}
      vaultPath="/vault"
      tags={[{ tag: "Web", count: 1 }]}
      currentTag="Web"
      onToggleTag={vi.fn()}
      onCreateAndAssign={vi.fn()}
      onRequestRename={handlers.onRequestRename ?? vi.fn()}
      onRequestDelete={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(getBlock).mockResolvedValue(indexedBlock({ slug: "alpha-block", tags: ["Web"] }));
  window.localStorage.setItem(MENU_MODE_STORAGE_KEY, "window");
  resetMenuPanelSourceForTests(true);
});

afterEach(() => {
  window.localStorage.removeItem(MENU_MODE_STORAGE_KEY);
  resetMenuPanelSourceForTests();
});

describe("the feed card's menu with the menu mode Window", () => {
  it("opens in the panel with the page menu's rows, nothing on the page", async () => {
    vi.mocked(invoke).mockResolvedValue({ menu: 1 });
    renderCard();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Card actions", hidden: true }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(opens()).toHaveLength(1));
    expect(screen.queryByText("Copy Path")).toBeNull();
    const payload = openedPayload();
    expect(payload?.opener).toEqual({ kind: "plate", align: "end" });
    expect(payload?.entries.map((entry) => (entry.kind === "item" ? entry.label : entry.kind))).toEqual([
      "connect",
      "separator",
      "Source",
      "Copy Link",
      "separator",
      "Reveal in Finder",
      "Copy Path",
      "separator",
      "Rename…",
      "Disconnect from “Web”",
      "Delete",
    ]);
  });

  it("runs a choice of the panel with the card's own handler", async () => {
    vi.mocked(invoke).mockResolvedValue({ menu: 2 });
    const onRequestRename = vi.fn();
    renderCard({ onRequestRename });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Card actions", hidden: true }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(opens()).toHaveLength(1));
    backend(MENU_PANEL_SHOWN_EVENT, { menu: 2 });
    backend(MENU_PANEL_ACTION_EVENT, { menu: 2, request: 1, action: { kind: "run", id: "rename" } });
    await waitFor(() => expect(onRequestRename).toHaveBeenCalledWith(block));
    backend(MENU_PANEL_CLOSED_EVENT, { menu: 2, reason: "chosen" });
    // Closed: the next press opens it again.
    vi.mocked(invoke).mockResolvedValue({ menu: 3 });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Card actions", hidden: true }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(opens()).toHaveLength(2));
  });

  it("opens on the page when the panel refuses it", async () => {
    vi.mocked(invoke).mockRejectedValue({ kind: "not_ready" });
    renderCard();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Card actions", hidden: true }), { button: 0, ctrlKey: false });
    expect(await screen.findByText("Copy Path")).toBeTruthy();
  });

  it("opens on the page with the menu mode Web", async () => {
    window.localStorage.removeItem(MENU_MODE_STORAGE_KEY);
    renderCard();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Card actions", hidden: true }), { button: 0, ctrlKey: false });
    expect(await screen.findByText("Copy Path")).toBeTruthy();
    expect(opens()).toHaveLength(0);
  });

  it("opens a right click's menu at the point, and the page's point menu when refused", async () => {
    vi.mocked(invoke).mockRejectedValue({ kind: "app_inactive" });
    render(
      <CardPanelPointMenu
        block={block}
        vaultPath="/vault"
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        x={300}
        y={200}
        eventAt={1}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(opens()).toHaveLength(1));
    const args = opens()[0]?.[1] as { request: { anchor: unknown } } | undefined;
    expect(args?.request.anchor).toEqual({ x: 300, y: 200, width: 0, height: 0 });
    expect(await screen.findByText("Copy Path")).toBeTruthy();
  });
});
