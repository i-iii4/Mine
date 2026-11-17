import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { cardConnectSpec, cardMenuSpec, type CardMenuPicker } from "@/lib/cardMenuEntries";
import { MENU_PANEL_TO_PAGE_EVENT } from "@/lib/menuPanelProtocol";
import { MENU_SHADOW_FIELD_PX, menuSpecSize } from "@/lib/menuSpec";
import { displayChoice, displaySpec } from "@/lib/displayMenu";
import { mediaAssetSpec } from "@/lib/openCardMenus";
import type { MenuPanelPageRequest, MenuPanelProgress, MenuPanelToPage, MenuSpec } from "@/types";
import { MenuPanelApp } from "./MenuPanelApp";

const PICKER: CardMenuPicker = { card: "card", selected: [], tags: [{ tag: "Web", count: 1 }], currentTag: null };
const SPEC: MenuSpec = cardMenuSpec({ hasUrl: false, disconnectFrom: null, tableCommands: [], picker: PICKER });
const WITH_LINK: MenuSpec = cardMenuSpec({ hasUrl: true, disconnectFrom: null, tableCommands: [], picker: PICKER });

const SOURCE = "tab-source";

/** The frame the backend sets for a menu with no submenu room: the menu and
 *  the shadow's field round it. */
function frameOf(spec: MenuSpec) {
  const { size } = menuSpecSize(spec);
  return { width: size.width + 2 * MENU_SHADOW_FIELD_PX, height: size.height + 2 * MENU_SHADOW_FIELD_PX };
}

function opening(spec: MenuSpec = SPEC, byKey = false): MenuPanelToPage {
  const { size } = menuSpecSize(spec);
  return {
    kind: "open",
    size,
    spec,
    by_key: byKey,
    buttons: null,
    // What the backend lays out for a menu below a button.
    layout: {
      menu: { x: 12, y: 12, ...size },
      origin: { x: 600, y: 300 },
      frame: frameOf(spec),
      anchor: { x: 252, y: 8 },
      side: "bottom",
      align: "end",
      max_height: null,
      submenu_right: true,
    },
  };
}

/** The page's area takes a size, as the panel's window gives it. */
function resizeTo(size: { width: number; height: number }) {
  act(() => {
    window.innerWidth = size.width;
    window.innerHeight = size.height;
    window.dispatchEvent(new Event("resize"));
  });
}

/** The backend's message number `seq` of the menu `menu` of a page. */
function toPage(menu: number, seq: number, body: MenuPanelToPage, source = SOURCE) {
  act(() => {
    const payload = { source, menu, seq, body };
    window.dispatchEvent(new CustomEvent(MENU_PANEL_TO_PAGE_EVENT, { detail: { event: MENU_PANEL_TO_PAGE_EVENT, payload } }));
  });
}

function invokes(name: string) {
  return vi.mocked(invoke).mock.calls.filter(([command]) => command === name).map(([, args]) => args);
}

/** The steps the page told of its menus, with its area then. */
function steps(): [MenuPanelProgress["step"], number, number][] {
  return (invokes("menu_panel_progress") as { progress: MenuPanelProgress }[]).map(({ progress }) => [progress.step, progress.area.width, progress.area.height]);
}

/** What the page asked of the backend, in the order it asked. */
function requests(): MenuPanelPageRequest[] {
  return (invokes("menu_panel_request") as { request: MenuPanelPageRequest }[]).map(({ request }) => request);
}

const original = { width: window.innerWidth, height: window.innerHeight };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(null);
  // The panel's window stands in the frame of the menu the tests open.
  window.innerWidth = frameOf(SPEC).width;
  window.innerHeight = frameOf(SPEC).height;
});

afterEach(() => {
  window.innerWidth = original.width;
  window.innerHeight = original.height;
});

describe("the menu panel's page", () => {
  it("tells the backend it is ready once it drew its rest", async () => {
    render(<MenuPanelApp />);
    await waitFor(() => expect(invokes("menu_panel_ready")).toHaveLength(1));
  });

  it("draws a menu at once where the backend laid it out, and reports each step's time", async () => {
    render(<MenuPanelApp />);
    toPage(1, 1, opening());
    // Drawn within the event's own task: no second round with the backend.
    expect(screen.getByText("Reveal in Finder")).toBeTruthy();
    await waitFor(() => expect(invokes("menu_panel_painted")).toHaveLength(1));
    const [{ paint }] = invokes("menu_panel_painted") as [{ paint: { source: string; menu: number; received_at: number; sized_at: number; drawn_at: number; frame_at: number } }];
    expect([paint.source, paint.menu]).toEqual([SOURCE, 1]);
    expect(paint.received_at).toBeLessThanOrEqual(paint.sized_at);
    expect(paint.sized_at).toBeLessThanOrEqual(paint.drawn_at);
    expect(paint.drawn_at).toBeLessThanOrEqual(paint.frame_at);
    expect(requests()).toEqual([]);
    // Each step before the first frame is told, the menu named (МО40а).
    const frame = frameOf(SPEC);
    expect(steps()).toEqual([
      ["received", frame.width, frame.height],
      ["frame_requested", frame.width, frame.height],
    ]);
    const [{ progress }] = invokes("menu_panel_progress") as [{ progress: MenuPanelProgress }];
    expect([progress.source, progress.menu]).toEqual([SOURCE, 1]);
  });

  it("tells each step of a menu that waits for its frame, the sizes it saw among them", () => {
    render(<MenuPanelApp />);
    window.innerWidth = 564;
    const frame = frameOf(SPEC);
    toPage(1, 1, opening());
    resizeTo({ width: 300, height: 300 });
    resizeTo(frame);
    expect(steps()).toEqual([
      ["received", 564, frame.height],
      ["resized", 300, 300],
      ["sized", frame.width, frame.height],
      ["frame_requested", frame.width, frame.height],
    ]);
  });

  it("writes a first frame's report the backend did not take to the log", async () => {
    vi.mocked(invoke).mockImplementation((command: string) =>
      command === "menu_panel_painted" ? Promise.reject(new Error("no such command")) : Promise.resolve(null),
    );
    render(<MenuPanelApp />);
    toPage(1, 1, opening());
    await waitFor(() =>
      expect(
        (invokes("plugin:log|log") as { message: string }[]).some(({ message }) => message.includes("the first frame's report did not reach the backend")),
      ).toBe(true),
    );
  });

  it("draws a menu only once its area is the frame the backend set for it", async () => {
    render(<MenuPanelApp />);
    // The panel still stands in the frame of the menu before.
    window.innerWidth = 564;
    toPage(1, 1, opening());
    expect(screen.queryByText("Reveal in Finder")).toBeNull();
    // Another size on the way is not the frame.
    resizeTo({ width: 300, height: 300 });
    expect(screen.queryByText("Reveal in Finder")).toBeNull();
    resizeTo(frameOf(SPEC));
    expect(screen.getByText("Reveal in Finder")).toBeTruthy();
    await waitFor(() => expect(invokes("menu_panel_painted")).toHaveLength(1));
    // Drawn once: a later change of size draws nothing again.
    resizeTo(frameOf(SPEC));
    expect(invokes("menu_panel_painted")).toHaveLength(1);
  });

  it("never draws a menu that closed while it waited for its frame", () => {
    render(<MenuPanelApp />);
    window.innerWidth = 564;
    toPage(1, 1, opening());
    toPage(1, 2, { kind: "closed", reason: "source" });
    resizeTo(frameOf(SPEC));
    expect(screen.queryByText("Reveal in Finder")).toBeNull();
    expect(invokes("menu_panel_painted")).toEqual([]);
  });

  it("asks for a chosen item and the menu's closing in one request, the choice first", async () => {
    render(<MenuPanelApp />);
    toPage(2, 1, opening());
    fireEvent.click(screen.getByText("Copy Path"));
    await waitFor(() => expect(requests()).toHaveLength(1));
    // One request: the backend passes the choice to the page, then closes.
    expect(requests()).toEqual([
      { source: SOURCE, menu: 2, request: 1, action: { kind: "run", id: "copy-path" }, close: "chosen" },
    ]);
    await waitFor(() => expect(screen.queryByText("Copy Path")).toBeNull());
    expect(requests()).toHaveLength(1);
  });

  it("closes as escaped on Escape", async () => {
    render(<MenuPanelApp />);
    toPage(3, 1, opening());
    fireEvent.keyDown(screen.getByText("Rename…"), { key: "Escape" });
    await waitFor(() => expect(requests()).toEqual([{ source: SOURCE, menu: 3, request: 1, action: null, close: "escape" }]));
  });

  it("closes a menu the backend closed without asking again", async () => {
    render(<MenuPanelApp />);
    toPage(4, 1, opening());
    toPage(4, 2, { kind: "closed", reason: "outside" });
    await waitFor(() => expect(screen.queryByText("Copy Path")).toBeNull());
    expect(requests()).toEqual([]);
  });

  it("takes the backend's messages of a menu in the order of their count", async () => {
    render(<MenuPanelApp />);
    // The change is the second message and came before the opening.
    toPage(6, 2, { kind: "update", spec: WITH_LINK });
    expect(screen.queryByText("Reveal in Finder")).toBeNull();
    toPage(6, 1, opening());
    expect(screen.getByText("Copy Link")).toBeTruthy();
    // The same message again is dropped, and so is one of another menu.
    toPage(6, 2, { kind: "update", spec: SPEC });
    toPage(9, 2, { kind: "closed", reason: "outside" });
    expect(screen.getByText("Copy Link")).toBeTruthy();
  });

  it("counts its requests for a menu from one, and starts again with the next menu", async () => {
    render(<MenuPanelApp />);
    toPage(7, 1, opening());
    fireEvent.keyDown(screen.getByText("Rename…"), { key: "Escape" });
    await waitFor(() => expect(requests()).toHaveLength(1));
    toPage(7, 2, { kind: "closed", reason: "escape" });
    // Another page's menu with the same number is another menu.
    toPage(7, 1, opening(), "tab-other");
    fireEvent.click(await screen.findByText("Copy Path"));
    await waitFor(() => expect(requests()).toHaveLength(2));
    expect(requests()[1]).toMatchObject({ source: "tab-other", menu: 7, request: 1, close: "chosen" });
  });

  it("asks nothing more of a menu it has asked to close", async () => {
    render(<MenuPanelApp />);
    toPage(8, 1, opening());
    fireEvent.click(screen.getByText("Copy Path"));
    await waitFor(() => expect(requests()).toHaveLength(1));
    // The backend's word of the closing asks for nothing either.
    toPage(8, 2, { kind: "closed", reason: "chosen" });
    await waitFor(() => expect(screen.queryByText("Copy Path")).toBeNull());
    expect(requests()).toHaveLength(1);
  });

  it("draws a list under a search field as a menu, and sends its choices without closing", async () => {
    const picker = cardConnectSpec({ ...PICKER, tags: [{ tag: "Web", count: 1 }, { tag: "Read", count: 4 }] });
    window.innerWidth = frameOf(picker).width;
    window.innerHeight = frameOf(picker).height;
    render(<MenuPanelApp />);
    toPage(9, 1, opening(picker));
    expect(screen.getByPlaceholderText("Search collections...")).toBeTruthy();
    // The surface is the list's: the width's role and no inset of its own.
    const surface = document.querySelector("[data-menu-panel-surface]");
    expect(surface?.getAttribute("data-floating-menu")).toBe("search");
    fireEvent.click(screen.getByText("Read"));
    await waitFor(() => expect(requests()).toHaveLength(1));
    expect(requests()[0]).toEqual({
      source: SOURCE,
      menu: 9,
      request: 1,
      action: { kind: "widget", id: "connect.picker", action: { kind: "toggle_collection", collection: "Read", connected: false } },
      close: null,
    });
    // The page's answer comes back by the request's number.
    toPage(9, 2, { kind: "answer", request: 1, answer: { kind: "membership", made: true } });
    expect(screen.getByText("Read")).toBeTruthy();
  });

  it("asks for a command that keeps the menu open without its closing, and draws what comes of it", async () => {
    const tags = [{ tag: "Web", count: 1 }];
    const media = mediaAssetSpec({ tags, currentTag: null, copyError: null });
    // The frame is the menu's at its largest: with the note of a failed copy.
    const largest = mediaAssetSpec({ tags, currentTag: null, copyError: "Media file was not found." });
    window.innerWidth = frameOf(largest).width;
    window.innerHeight = frameOf(largest).height;
    render(<MenuPanelApp />);
    const first = opening(largest);
    toPage(11, 1, first.kind === "open" ? { ...first, spec: media } : first);
    fireEvent.click(screen.getByText("Copy Media"));
    await waitFor(() => expect(requests()).toHaveLength(1));
    expect(requests()[0]).toEqual({ source: SOURCE, menu: 11, request: 1, action: { kind: "run", id: "copy-media" }, close: null });
    toPage(11, 2, { kind: "answer", request: 1, answer: { kind: "done" } });
    // The page the menu came from sends the menu anew, the note under the row.
    toPage(11, 3, { kind: "update", spec: largest });
    expect(screen.getByText("Media file was not found.").getAttribute("data-menu-note")).toBe("error");
    expect(screen.getByText("Copy Media")).toBeTruthy();
    // Every other command closes it with the choice.
    fireEvent.click(screen.getByText("Reveal in Finder"));
    await waitFor(() => expect(requests()).toHaveLength(2));
    expect(requests()[1]).toEqual({ source: SOURCE, menu: 11, request: 2, action: { kind: "run", id: "reveal" }, close: "chosen" });
  });

  it("asks for a choice and a switch without closing, moves the tick with the next description, and lights a choice's row for a key", async () => {
    const panel = (sort: string, wikilinks: boolean): MenuSpec => displaySpec([
      displayChoice("sort", "Sort", sort, [{ value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }]),
      [{ kind: "caption", text: "Links" }, { kind: "checkbox", id: "links.wikilinks", label: "Wikilinks", checked: wikilinks }],
    ]);
    const first = panel("newest", true);
    window.innerWidth = frameOf(first).width;
    window.innerHeight = frameOf(first).height;
    render(<MenuPanelApp />);
    toPage(12, 1, opening(first, true));
    // A key opened it: the first row is a choice's, and takes the highlight.
    expect(document.activeElement?.textContent).toBe("Newest first");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Oldest first" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Wikilinks" }));
    await waitFor(() => expect(requests()).toHaveLength(2));
    expect(requests()).toEqual([
      { source: SOURCE, menu: 12, request: 1, action: { kind: "choose", id: "sort", value: "oldest" }, close: null },
      { source: SOURCE, menu: 12, request: 2, action: { kind: "check", id: "links.wikilinks", checked: false }, close: null },
    ]);
    expect(screen.getByRole("menuitemradio", { name: "Newest first" }).getAttribute("aria-checked")).toBe("true");
    // The page the menu came from applied both and sends the menu anew.
    toPage(12, 2, { kind: "update", spec: panel("oldest", false) });
    expect(screen.getByRole("menuitemradio", { name: "Oldest first" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemcheckbox", { name: "Wikilinks" }).getAttribute("aria-checked")).toBe("false");
  });

  it("asks for a choice and the menu's closing in one request where the menu is there for the one choice", async () => {
    const select: MenuSpec = {
      role: "action",
      entries: [{ kind: "radio", id: "space", value: "mine", options: [{ value: "mine", label: "Mine" }, { value: "archive", label: "Archive" }], closes: true }],
    };
    window.innerWidth = frameOf(select).width;
    window.innerHeight = frameOf(select).height;
    render(<MenuPanelApp />);
    toPage(13, 1, opening(select));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Archive" }));
    await waitFor(() => expect(requests()).toHaveLength(1));
    expect(requests()).toEqual([
      { source: SOURCE, menu: 13, request: 1, action: { kind: "choose", id: "space", value: "archive" }, close: "chosen" },
    ]);
    await waitFor(() => expect(screen.queryByRole("menuitemradio")).toBeNull());
    expect(requests()).toHaveLength(1);
  });

  it("draws the list of spaces, keeps the keyboard in its field for a key, and closes on a space chosen but not on a folder shown", async () => {
    const spaces: MenuSpec = {
      role: "search",
      entries: [{
        kind: "widget",
        id: "spaces",
        widget: {
          kind: "space_list",
          spaces: [{ path: "/spaces/Archive", name: "Archive", tab: true }],
          unavailable: [],
          tabs: true,
        },
      }],
    };
    window.innerWidth = frameOf(spaces).width;
    window.innerHeight = frameOf(spaces).height;
    render(<MenuPanelApp />);
    toPage(14, 1, opening(spaces, true));
    // A key opened it: no row takes the keyboard from the field.
    expect(document.activeElement?.getAttribute("role")).not.toBe("menuitem");
    fireEvent.click(screen.getByRole("button", { name: "Reveal Archive in Finder" }));
    await waitFor(() => expect(requests()).toHaveLength(1));
    expect(requests()[0]).toEqual({
      source: SOURCE,
      menu: 14,
      request: 1,
      action: { kind: "widget", id: "spaces", action: { kind: "reveal_space", path: "/spaces/Archive" } },
      close: null,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(requests()).toHaveLength(2));
    expect(requests()[1]).toEqual({
      source: SOURCE,
      menu: 14,
      request: 2,
      action: { kind: "widget", id: "spaces", action: { kind: "switch_space", path: "/spaces/Archive", new_tab: false } },
      close: "chosen",
    });
    await waitFor(() => expect(screen.queryByPlaceholderText("Search spaces...")).toBeNull());
  });

  it("lights the first row of a menu a key opened", () => {
    render(<MenuPanelApp />);
    toPage(10, 1, opening(SPEC, true));
    expect(document.activeElement?.textContent).toContain("Connect");
  });
});
