// The chrome's menus off a button with the menu mode Window
// (SPEC_MENU_WINDOW.md, Г2, Г3): the Display panels and the logo's menu go
// to the menu panel with their one description, and a choice made there
// comes back to the setting's owner.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { CARD_VIEW_STORAGE_KEY, getCardView, reloadCardView } from "@/lib/cardView";
import { applyDensity, getStoredDensity } from "@/lib/density";
import { getFeedDisplay, reloadFeedDisplay } from "@/lib/feedDisplay";
import { getGraphPreferences, reloadGraphPreferences } from "@/lib/graphPreferences";
import { MENU_MODE_STORAGE_KEY } from "@/lib/menuMode";
import { MENU_PANEL_TO_SOURCE_EVENT } from "@/lib/menuPanelProtocol";
import { resetMenuPanelSourceForTests } from "@/lib/menuPanelSource";
import type { MenuAction, MenuPanelToSource, MenuSpec } from "@/types";
import { AppSettingsMenu } from "./AppSettingsMenu";
import { FeedDisplayMenu } from "./FeedDisplayMenu";
import { GraphDisplayMenu } from "./GraphDisplayMenu";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

interface OpenRequest {
  opener: unknown;
  spec: MenuSpec;
  size: { width: number; height: number };
  by_key: boolean;
}

function opens(): OpenRequest[] {
  return vi.mocked(invoke).mock.calls.filter(([command]) => command === "menu_panel_open")
    .map(([, args]) => (args as { request: OpenRequest }).request);
}

function updates(): MenuSpec[] {
  return vi.mocked(invoke).mock.calls.filter(([command]) => command === "menu_panel_update")
    .map(([, args]) => (args as { spec: MenuSpec }).spec);
}

function toSource(menu: number, seq: number, body: MenuPanelToSource) {
  act(() => {
    const payload = { menu, seq, body };
    window.dispatchEvent(new CustomEvent(MENU_PANEL_TO_SOURCE_EVENT, { detail: { event: MENU_PANEL_TO_SOURCE_EVENT, payload } }));
  });
}

function choice(request: number, action: MenuAction) {
  toSource(1, request, { kind: "action", request, action });
}

function ids(spec: MenuSpec): string[] {
  return spec.entries.map((entry) => ("id" in entry ? entry.id : entry.kind));
}

function valueOf(spec: MenuSpec, id: string): string | boolean | null {
  const entry = spec.entries.find((candidate) => "id" in candidate && candidate.id === id);
  return entry?.kind === "radio" ? entry.value : entry?.kind === "checkbox" ? entry.checked : null;
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(command === "menu_panel_close" ? { closed: true, key_returned: true } : null));
  window.localStorage.setItem(MENU_MODE_STORAGE_KEY, "window");
  resetMenuPanelSourceForTests(true);
});

afterEach(() => {
  window.localStorage.clear();
  resetMenuPanelSourceForTests();
  act(() => {
    reloadFeedDisplay();
    reloadCardView();
    reloadGraphPreferences();
    applyDensity(32);
  });
});

describe("the feed's Display panel in the menu panel", () => {
  it("asks the panel for its groups off the button, the frame counted with the Peek window's width", async () => {
    render(<FeedDisplayMenu />);
    const button = screen.getByRole("button", { name: "Display options" });
    fireEvent.pointerDown(button, { button: 0, ctrlKey: false });
    expect(opens()).toHaveLength(1);
    expect(opens()[0]?.opener).toEqual({ kind: "plate" });
    expect(ids(opens()[0]!.spec)).toEqual(["caption", "sort", "separator", "caption", "show", "separator", "caption", "spacing", "separator", "caption", "card-view"]);
    // Sort and Element view two rows, Show three, Spacing five, four captions,
    // three separators; and the Peek width's caption and two rows more.
    const rows = 2 + 3 + 5 + 2;
    expect(opens()[0]?.size).toEqual({ width: 240, height: 10 + rows * 32 + 4 * 28 + 3 * 9 + (28 + 2 * 32) });
    await waitFor(() => expect(button.getAttribute("data-state")).toBe("open"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("applies the panel's choices at once and sends the panel the menu anew each time", async () => {
    render(<FeedDisplayMenu />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Display options" }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(opens()).toHaveLength(1));

    choice(1, { kind: "choose", id: "sort", value: "oldest" });
    await waitFor(() => expect(getFeedDisplay().sort).toBe("oldest"));
    await waitFor(() => expect(valueOf(updates().at(-1)!, "sort")).toBe("oldest"));

    choice(2, { kind: "choose", id: "show", value: "media-only" });
    await waitFor(() => expect(getFeedDisplay().show).toBe("media-only"));

    choice(3, { kind: "choose", id: "spacing", value: "8" });
    await waitFor(() => expect(getStoredDensity()).toBe(8));
    await waitFor(() => expect(valueOf(updates().at(-1)!, "spacing")).toBe("8"));

    // Peek brings its width's group into the menu, inside the frame set at
    // the opening.
    choice(4, { kind: "choose", id: "card-view", value: "peek" });
    await waitFor(() => expect(getCardView()).toBe("peek"));
    await waitFor(() => expect(ids(updates().at(-1)!).slice(-4)).toEqual(["caption", "card-view", "caption", "peek-width"]));
    expect(window.localStorage.getItem(CARD_VIEW_STORAGE_KEY)).toBe("peek");

    // A value the group does not offer changes nothing.
    choice(5, { kind: "choose", id: "sort", value: "random" });
    await act(async () => {});
    expect(getFeedDisplay().sort).toBe("oldest");
    // No choice closed the menu.
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "menu_panel_close")).toBe(false);
  });
});

describe("the graph's Display panel in the menu panel", () => {
  it("asks the panel for its switches and the open card's view, and applies a switch", async () => {
    render(<GraphDisplayMenu />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Display options" }), { button: 0, ctrlKey: false });
    expect(opens()).toHaveLength(1);
    expect(ids(opens()[0]!.spec)).toEqual(["caption", "links.include_wikilinks", "links.include_related_notes", "separator", "caption", "card-view"]);
    expect(valueOf(opens()[0]!.spec, "links.include_wikilinks")).toBe(true);

    choice(1, { kind: "check", id: "links.include_wikilinks", checked: false });
    await waitFor(() => expect(getGraphPreferences().include_wikilinks).toBe(false));
    await waitFor(() => expect(valueOf(updates().at(-1)!, "links.include_wikilinks")).toBe(false));
    expect(getGraphPreferences().include_related_notes).toBe(true);
  });
});

describe("the logo's menu in the menu panel", () => {
  it("asks the panel for the settings' sections as rows with no leading slot, and opens the section chosen", async () => {
    const onSelectSection = vi.fn();
    render(<AppSettingsMenu onSelectSection={onSelectSection} />);
    const button = screen.getByRole("button", { name: "Mine settings" });
    fireEvent.pointerDown(button, { button: 0, ctrlKey: false });
    expect(opens()).toHaveLength(1);
    expect(opens()[0]?.opener).toEqual({ kind: "plate" });
    const { entries } = opens()[0]!.spec;
    expect(entries.map((entry) => (entry.kind === "item" ? entry.label : entry.kind))).toEqual(
      ["Appearance", "Shortcuts", "Graph", "Spaces", "New files", "Updates", "Orphans"],
    );
    expect(entries.every((entry) => entry.kind === "item" && entry.plain && entry.icon === null)).toBe(true);
    expect(opens()[0]?.size).toEqual({ width: 240, height: 10 + 7 * 32 });
    await waitFor(() => expect(button.getAttribute("data-state")).toBe("open"));
    expect(screen.queryByRole("menu")).toBeNull();

    choice(1, { kind: "run", id: "spaces" });
    await waitFor(() => expect(onSelectSection).toHaveBeenCalledExactlyOnceWith("spaces"));
    // An id that is no section opens nothing.
    choice(2, { kind: "run", id: "billing" });
    await act(async () => {});
    expect(onSelectSection).toHaveBeenCalledTimes(1);
  });
});
