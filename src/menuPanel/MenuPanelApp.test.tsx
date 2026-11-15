import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { cardMenuEntries } from "@/lib/cardMenuEntries";
import {
  MENU_PANEL_ACTION_EVENT,
  MENU_PANEL_CLOSED_EVENT,
  MENU_PANEL_OPEN_EVENT,
  encodeCardMenuPayload,
  type CardMenuPayload,
} from "@/lib/menuPanelProtocol";
import { MENU_PANEL_SIZE, MENU_SHADOW_FIELD_PX } from "@/lib/menuPanelGeometry";
import type { MenuPanelOpening } from "@/types";
import { MenuPanelApp } from "./MenuPanelApp";

const PAYLOAD: CardMenuPayload = {
  opener: { kind: "plate", align: "end" },
  byKey: false,
  buttons: null,
  entries: cardMenuEntries({ hasUrl: false, disconnectFrom: null, tableCommands: [] }),
  picker: { blockSlug: "card", selectedTags: [], tags: [{ tag: "Web", count: 1 }], currentTag: null },
};

function opening(menu: number, payload: string = encodeCardMenuPayload(PAYLOAD)): MenuPanelOpening {
  return {
    menu,
    source: "tab-source",
    anchor: { x: 700, y: 200, width: 24, height: 24 },
    screen: { x: 0, y: 25, width: 1440, height: 875 },
    payload,
    event_at: 1000,
  };
}

function backend(event: string, payload: unknown) {
  act(() => {
    window.dispatchEvent(new CustomEvent(event, { detail: { event, payload } }));
  });
}

function invokes(name: string) {
  return vi.mocked(invoke).mock.calls.filter(([command]) => command === name).map(([, args]) => args);
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(null);
  vi.mocked(emitTo).mockClear();
  document.documentElement.setAttribute("data-menu-panel-hidden", "");
});

afterEach(() => {
  document.documentElement.removeAttribute("data-menu-panel-hidden");
});

describe("the menu panel's page", () => {
  it("tells the backend it listens, then shows a menu where it laid it out", async () => {
    render(<MenuPanelApp />);
    await waitFor(() => expect(invokes("menu_panel_ready")).toHaveLength(1));
    backend(MENU_PANEL_OPEN_EVENT, opening(1));
    await waitFor(() => expect(invokes("menu_panel_show")).toHaveLength(1));
    const [args] = invokes("menu_panel_show");
    // jsdom measures the menu as 0 × 0: it stands at the plate's right edge,
    // under it, and the panel holds it the shadow's field off its left edge.
    expect(args).toEqual({ menu: 1, origin: { x: 724 - MENU_SHADOW_FIELD_PX, y: expect.any(Number) } });
    expect(screen.getByText("Reveal in Finder")).toBeTruthy();
    await waitFor(() => expect(document.documentElement.hasAttribute("data-menu-panel-hidden")).toBe(false));
    await waitFor(() => expect(invokes("menu_panel_painted")).toHaveLength(1));
    expect(invokes("menu_panel_painted")[0]).toMatchObject({ paint: { menu: 1, opener: "plate" } });
    expect(MENU_PANEL_SIZE.width).toBeGreaterThan(0);
  });

  it("sends a chosen item to the tab and closes the menu as chosen", async () => {
    render(<MenuPanelApp />);
    backend(MENU_PANEL_OPEN_EVENT, opening(2));
    await waitFor(() => expect(invokes("menu_panel_show")).toHaveLength(1));
    fireEvent.click(screen.getByText("Copy Path"));
    await waitFor(() => expect(invokes("menu_panel_close")).toEqual([{ menu: 2, reason: "chosen" }]));
    expect(emitTo).toHaveBeenCalledWith("tab-source", MENU_PANEL_ACTION_EVENT, {
      menu: 2,
      request: expect.any(Number),
      action: { kind: "run", id: "copy-path" },
    });
  });

  it("closes as escaped on Escape", async () => {
    render(<MenuPanelApp />);
    backend(MENU_PANEL_OPEN_EVENT, opening(3));
    await waitFor(() => expect(invokes("menu_panel_show")).toHaveLength(1));
    fireEvent.keyDown(screen.getByText("Rename…"), { key: "Escape" });
    await waitFor(() => expect(invokes("menu_panel_close")).toEqual([{ menu: 3, reason: "escape" }]));
  });

  // The card's context menu drawn here (a right click in the Window trial):
  // Escape in Connect climbs one layer at a time, as on the page
  // (CardContextMenu.tsx; user's decision of 15.11.2026).
  it("clears the query, then closes Connect alone with the focus on it, then the menu, in a context menu", async () => {
    render(<MenuPanelApp />);
    const point = encodeCardMenuPayload({ ...PAYLOAD, opener: { kind: "point" } });
    backend(MENU_PANEL_OPEN_EVENT, opening(6, point));
    await waitFor(() => expect(invokes("menu_panel_show")).toHaveLength(1));
    const connect = screen.getByRole("menuitem", { name: "Connect" });
    fireEvent.keyDown(connect, { key: "ArrowRight" });
    const field = (await screen.findByPlaceholderText("Search collections...")) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "We" } });

    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("");
    expect(invokes("menu_panel_close")).toEqual([]);

    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(screen.queryByPlaceholderText("Search collections...")).toBeNull());
    expect(screen.getByText("Copy Path")).toBeTruthy();
    expect(invokes("menu_panel_close")).toEqual([]);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Connect" })).toHaveFocus());

    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Connect" }), { key: "Escape" });
    await waitFor(() => expect(invokes("menu_panel_close")).toEqual([{ menu: 6, reason: "escape" }]));
  });

  it("closes a menu the backend closed without asking again", async () => {
    render(<MenuPanelApp />);
    backend(MENU_PANEL_OPEN_EVENT, opening(4));
    await waitFor(() => expect(invokes("menu_panel_show")).toHaveLength(1));
    backend(MENU_PANEL_CLOSED_EVENT, { menu: 4, reason: "outside" });
    await waitFor(() => expect(screen.queryByText("Copy Path")).toBeNull());
    expect(invokes("menu_panel_close")).toEqual([]);
  });

  it("draws nothing and closes as failed when the tab sent no menu", async () => {
    render(<MenuPanelApp />);
    backend(MENU_PANEL_OPEN_EVENT, opening(5, "{\"entries\":3}"));
    await waitFor(() => expect(invokes("menu_panel_close")).toEqual([{ menu: 5, reason: "failed" }]));
    expect(invokes("menu_panel_show")).toEqual([]);
  });
});
