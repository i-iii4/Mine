// TRIAL (SPEC_MENU_WINDOW.md; DESIGN_SYSTEM.md, «Меню карточки в отдельном
// окне: проба»): the feed card's menu in the menu panel, and on the page when
// the panel cannot take it.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { StrictMode, createRef } from "react";
import { CardConnectMenu, CardHoverMenu, CardPointMenuHost, type CardPointMenuHandle } from "./CardHoverMenu";
import { getBlock } from "@/lib/commands";
import { MENU_MODE_STORAGE_KEY } from "@/lib/menuMode";
import { MENU_PANEL_TO_SOURCE_EVENT } from "@/lib/menuPanelProtocol";
import type { MenuPanelToSource, MenuSpec } from "@/types";
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

/** The backend's message number `seq` of this page's menu `menu`. */
function toSource(menu: number, seq: number, body: MenuPanelToSource) {
  act(() => {
    const payload = { menu, seq, body };
    window.dispatchEvent(new CustomEvent(MENU_PANEL_TO_SOURCE_EVENT, { detail: { event: MENU_PANEL_TO_SOURCE_EVENT, payload } }));
  });
}

/** The backend takes every command of the panel. */
function panelTakes() {
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(command === "menu_panel_close" ? { closed: true, key_returned: false } : null));
}

function invokes(name: string) {
  return vi.mocked(invoke).mock.calls.filter(([command]) => command === name).map(([, args]) => args);
}

function opens() {
  return vi.mocked(invoke).mock.calls.filter(([command]) => command === "menu_panel_open");
}

/** The menu the page asked the panel for, as data. */
function openedSpec(): MenuSpec | null {
  const args = opens()[0]?.[1] as { request: { spec: MenuSpec } } | undefined;
  return args?.request.spec ?? null;
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
  it("asks for the panel in the press's own handler, with the page menu's rows, nothing on the page", async () => {
    panelTakes();
    renderCard();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Element actions", hidden: true }), { button: 0, ctrlKey: false });
    // Before React has run an effect: the request left with the press.
    expect(opens()).toHaveLength(1);
    expect(screen.queryByText("Copy Path")).toBeNull();
    const spec = openedSpec();
    expect((opens()[0]?.[1] as { request: { opener: unknown } }).request.opener).toEqual({ kind: "plate" });
    expect(spec?.entries.map((entry) => (entry.kind === "item" ? entry.label : entry.kind))).toEqual([
      "submenu",
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
    panelTakes();
    const onRequestRename = vi.fn();
    renderCard({ onRequestRename });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Element actions", hidden: true }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(opens()).toHaveLength(1));
    // The page's first menu: the choice, then the closing it brought.
    toSource(1, 1, { kind: "action", request: 1, action: { kind: "run", id: "rename" } });
    await waitFor(() => expect(onRequestRename).toHaveBeenCalledWith(block));
    toSource(1, 2, { kind: "closed", reason: "chosen", key_returned: true });
    // Closed: the next press opens it again, the page's second menu.
    fireEvent.pointerDown(screen.getByRole("button", { name: "Element actions", hidden: true }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(opens()).toHaveLength(2));
    expect((opens()[1]?.[1] as { request: { menu: number } }).request.menu).toBe(2);
  });

  it("closes its menu when the card unmounts, and not on its mount in StrictMode", async () => {
    panelTakes();
    const { unmount } = render(
      <StrictMode>
        <CardHoverMenu
          block={block}
          vaultPath="/vault"
          tags={[]}
          currentTag="Web"
          onToggleTag={vi.fn()}
          onCreateAndAssign={vi.fn()}
          onRequestRename={vi.fn()}
          onRequestDelete={vi.fn()}
        />
      </StrictMode>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Element actions", hidden: true }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(opens()).toHaveLength(1));
    // The button owns the menu: nothing closed it while it stood.
    expect(invokes("menu_panel_close")).toEqual([]);
    unmount();
    expect(invokes("menu_panel_close")).toEqual([expect.objectContaining({ menu: 1, reason: "source" })]);
  });

  it("asks for Connect's picker in the panel as a list under a search field, and runs its choices with the card's handlers", async () => {
    panelTakes();
    const onToggleTag = vi.fn(async () => true);
    render(
      <CardHoverMenu
        block={block}
        vaultPath="/vault"
        tags={[{ tag: "Web", count: 1 }, { tag: "Read", count: 2 }]}
        currentTag="Web"
        onToggleTag={onToggleTag}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
      />,
    );
    fireEvent.pointerDown(screen.getAllByRole("button", { name: "Connect", hidden: true })[0] as HTMLElement, { button: 0, ctrlKey: false });
    expect(opens()).toHaveLength(1);
    // Nothing on the page: the picker is in the panel.
    expect(screen.queryByPlaceholderText("Search collections...")).toBeNull();
    const spec = openedSpec();
    expect(spec?.role).toBe("search");
    expect(spec?.entries).toEqual([{
      kind: "widget",
      id: "connect.picker",
      widget: {
        kind: "collection_picker",
        card: "alpha-block",
        selected: ["Web"],
        collections: [{ name: "Web", count: 1 }, { name: "Read", count: 2 }],
        current: "Web",
      },
    }]);
    // The picker's change comes back as the widget's action and is answered.
    toSource(1, 1, {
      kind: "action",
      request: 1,
      action: { kind: "widget", id: "connect.picker", action: { kind: "toggle_collection", collection: "Read", connected: false } },
    });
    await waitFor(() => expect(onToggleTag).toHaveBeenCalledWith("alpha-block", "Read", false));
    await waitFor(() => expect(invokes("menu_panel_answer")).toEqual([{ menu: 1, request: 1, answer: { kind: "membership", made: true } }]));
  });

  it("opens Connect's picker on the page when the panel refuses it", async () => {
    vi.mocked(invoke).mockRejectedValue({ kind: "not_ready" });
    renderCard();
    fireEvent.pointerDown(screen.getAllByRole("button", { name: "Connect", hidden: true })[0] as HTMLElement, { button: 0, ctrlKey: false });
    expect(await screen.findByPlaceholderText("Search collections...")).toBeTruthy();
  });

  it("opens on the page when the panel refuses it", async () => {
    vi.mocked(invoke).mockRejectedValue({ kind: "not_ready" });
    renderCard();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Element actions", hidden: true }), { button: 0, ctrlKey: false });
    expect(await screen.findByText("Copy Path")).toBeTruthy();
  });

  it("opens on the page with the menu mode Web", async () => {
    window.localStorage.removeItem(MENU_MODE_STORAGE_KEY);
    renderCard();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Element actions", hidden: true }), { button: 0, ctrlKey: false });
    expect(await screen.findByText("Copy Path")).toBeTruthy();
    expect(opens()).toHaveLength(0);
  });

  it("sends the panel what the file says of the card's collections once it is read", async () => {
    panelTakes();
    vi.mocked(getBlock).mockResolvedValue(indexedBlock({ slug: "alpha-block", tags: ["Web", "Read"] }));
    renderCard();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Element actions", hidden: true }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(invokes("menu_panel_update")).not.toEqual([]));
    const [update] = invokes("menu_panel_update") as [{ menu: number; number: number; spec: MenuSpec }];
    expect([update.menu, update.number]).toEqual([1, 1]);
    const connect = update.spec.entries[0];
    const picker = connect?.kind === "submenu" ? connect.content.entries[0] : undefined;
    expect(picker?.kind === "widget" && picker.widget.kind === "collection_picker" && picker.widget.selected).toEqual(["Web", "Read"]);
  });
});

describe("the card menu at a point: the feed's right click, the graph and the sidebar's thumbnails", () => {
  function renderHost(onOpenChange = vi.fn()) {
    const handle = createRef<CardPointMenuHandle>();
    const onRequestRename = vi.fn();
    const view = render(
      <StrictMode>
        <CardPointMenuHost
          handleRef={handle}
          vaultPath="/vault"
          tags={[{ tag: "Web", count: 1 }]}
          currentTag="Web"
          onToggleTag={vi.fn()}
          onCreateAndAssign={vi.fn()}
          onRequestRename={onRequestRename}
          onRequestDelete={vi.fn()}
          onOpenChange={onOpenChange}
        />
      </StrictMode>,
    );
    return { handle, onOpenChange, onRequestRename, ...view };
  }

  it("asks the panel the moment it is opened, at the point, and runs a choice with the card's handlers", async () => {
    panelTakes();
    const { handle, onOpenChange, onRequestRename } = renderHost();
    // Mounted with no menu: StrictMode's trial run of the mount closed nothing.
    expect(invokes("menu_panel_close")).toEqual([]);
    act(() => handle.current?.open(block, { x: 300, y: 200 }));
    const args = opens()[0]?.[1] as { request: { anchor: unknown; opener: unknown; menu: number } } | undefined;
    expect(args?.request).toMatchObject({ menu: 1, anchor: { x: 300, y: 200, width: 0, height: 0 }, opener: { kind: "point" } });
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    // In the panel: nothing on the page.
    await waitFor(() => expect(invokes("menu_panel_open")).toHaveLength(1));
    expect(screen.queryByText("Copy Path")).toBeNull();
    toSource(1, 1, { kind: "action", request: 1, action: { kind: "run", id: "rename" } });
    await waitFor(() => expect(onRequestRename).toHaveBeenCalledWith(block));
    toSource(1, 2, { kind: "closed", reason: "chosen", key_returned: true });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(invokes("menu_panel_close")).toEqual([]);
  });

  it("opens on the page at the point when the panel refuses it, and when the menu mode is Web", async () => {
    vi.mocked(invoke).mockRejectedValue({ kind: "app_inactive" });
    const { handle, onOpenChange } = renderHost();
    act(() => handle.current?.open(block, { x: 300, y: 200 }));
    expect(await screen.findByText("Copy Path")).toBeTruthy();
    // On the page the menu stands as in the panel: right of the point, its
    // top on it, its corner on the point with no offset (МО10, МО69).
    const surface = document.querySelector("[data-slot='dropdown-menu-content']");
    expect([surface?.getAttribute("data-side"), surface?.getAttribute("data-align")]).toEqual(["right", "start"]);
    const anchor = document.querySelector<HTMLElement>("[data-card-point-menu-anchor]");
    expect([anchor?.style.left, anchor?.style.top]).toEqual(["300px", "200px"]);
    expect(anchor?.className).toContain("size-0");
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    // The owner takes it away.
    act(() => handle.current?.close());
    await waitFor(() => expect(screen.queryByText("Copy Path")).toBeNull());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    window.localStorage.removeItem(MENU_MODE_STORAGE_KEY);
    vi.mocked(invoke).mockClear();
    act(() => handle.current?.open(block, { x: 40, y: 50 }));
    expect(await screen.findByText("Copy Path")).toBeTruthy();
    expect(opens()).toHaveLength(0);
  });

  // DESIGN_SYSTEM.md, «Открытое меню»: the first press outside a menu only
  // closes it. The page's menu goes with its surface at once, and the press
  // is still held to its end.
  it("closes on a press outside on the page without acting there", async () => {
    window.localStorage.removeItem(MENU_MODE_STORAGE_KEY);
    const user = userEvent.setup();
    const onClick = vi.fn();
    const handle = createRef<CardPointMenuHandle>();
    render(
      <>
        <button type="button" onClick={onClick}>Under the menu</button>
        <CardPointMenuHost
          handleRef={handle}
          vaultPath="/vault"
          tags={[]}
          onToggleTag={vi.fn()}
          onCreateAndAssign={vi.fn()}
          onRequestRename={vi.fn()}
          onRequestDelete={vi.fn()}
        />
      </>,
    );
    act(() => handle.current?.open(block, { x: 300, y: 200 }));
    expect(await screen.findByText("Copy Path")).toBeTruthy();
    await user.click(screen.getByText("Under the menu"));
    await waitFor(() => expect(screen.queryByText("Copy Path")).toBeNull());
    expect(onClick).not.toHaveBeenCalled();
    // The next press is the page's own.
    await user.click(screen.getByText("Under the menu"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("closes its menu in the panel when it is taken away, and when it unmounts", async () => {
    panelTakes();
    const { handle, unmount } = renderHost();
    act(() => handle.current?.open(block, { x: 300, y: 200 }));
    await waitFor(() => expect(opens()).toHaveLength(1));
    act(() => handle.current?.close());
    expect(invokes("menu_panel_close")).toEqual([expect.objectContaining({ menu: 1, reason: "source" })]);
    act(() => handle.current?.open(block, { x: 300, y: 200 }));
    await waitFor(() => expect(opens()).toHaveLength(2));
    unmount();
    expect(invokes("menu_panel_close")).toEqual([
      expect.objectContaining({ menu: 1, reason: "source" }),
      expect.objectContaining({ menu: 2, reason: "source" }),
    ]);
  });
});

describe("Connect of the open card: the picker off a button of its own", () => {
  function renderConnect() {
    return render(
      <CardConnectMenu
        block={block}
        tags={[{ tag: "Web", count: 1 }]}
        currentTag="Web"
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
      >
        <button type="button">Connect to</button>
      </CardConnectMenu>,
    );
  }

  it("asks the panel for the picker off the button given, which looks open meanwhile", async () => {
    panelTakes();
    renderConnect();
    const button = screen.getByRole("button", { name: "Connect to" });
    fireEvent.pointerDown(button, { button: 0, ctrlKey: false });
    expect(opens()).toHaveLength(1);
    expect(openedSpec()?.role).toBe("search");
    expect((opens()[0]?.[1] as { request: { opener: unknown } }).request.opener).toEqual({ kind: "plate" });
    await waitFor(() => expect(button.getAttribute("data-state")).toBe("open"));
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByPlaceholderText("Search collections...")).toBeNull();
    toSource(1, 1, { kind: "closed", reason: "escape", key_returned: true });
    await waitFor(() => expect(button.getAttribute("data-state")).toBe("closed"));
  });

  it("opens the picker on the page with the menu mode Web", async () => {
    window.localStorage.removeItem(MENU_MODE_STORAGE_KEY);
    renderConnect();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Connect to" }), { button: 0, ctrlKey: false });
    expect(await screen.findByPlaceholderText("Search collections...")).toBeTruthy();
    expect(opens()).toHaveLength(0);
  });
});
