// TRIAL (SPEC_MENU_WINDOW.md; DESIGN_SYSTEM.md, «Меню карточки в отдельном
// окне: проба»): the feed card's menu in the menu panel, and on the page when
// the panel cannot take it.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { StrictMode, useState } from "react";
import { CARD_POINT_OPENER, CardHoverMenu, CardPanelPointMenu, startCardMenuPanel } from "./CardHoverMenu";
import { getBlock } from "@/lib/commands";
import { MENU_MODE_STORAGE_KEY } from "@/lib/menuMode";
import { MENU_PANEL_TO_SOURCE_EVENT } from "@/lib/menuPanelProtocol";
import type { MenuPanelToSource, MenuSpec } from "@/types";
import type { MenuPanelSession } from "@/lib/menuPanelSource";
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
    fireEvent.pointerDown(screen.getByRole("button", { name: "Card actions", hidden: true }), { button: 0, ctrlKey: false });
    // Before React has run an effect: the request left with the press.
    expect(opens()).toHaveLength(1);
    expect(screen.queryByText("Copy Path")).toBeNull();
    const spec = openedSpec();
    expect((opens()[0]?.[1] as { request: { opener: unknown } }).request.opener).toEqual({ kind: "plate", align: "end" });
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
    fireEvent.pointerDown(screen.getByRole("button", { name: "Card actions", hidden: true }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(opens()).toHaveLength(1));
    // The page's first menu: the choice, then the closing it brought.
    toSource(1, 1, { kind: "action", request: 1, action: { kind: "run", id: "rename" } });
    await waitFor(() => expect(onRequestRename).toHaveBeenCalledWith(block));
    toSource(1, 2, { kind: "closed", reason: "chosen", key_returned: true });
    // Closed: the next press opens it again, the page's second menu.
    fireEvent.pointerDown(screen.getByRole("button", { name: "Card actions", hidden: true }), { button: 0, ctrlKey: false });
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
    fireEvent.pointerDown(screen.getByRole("button", { name: "Card actions", hidden: true }), { button: 0, ctrlKey: false });
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

  it("sends the panel what the file says of the card's collections once it is read", async () => {
    panelTakes();
    vi.mocked(getBlock).mockResolvedValue(indexedBlock({ slug: "alpha-block", tags: ["Web", "Read"] }));
    renderCard();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Card actions", hidden: true }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(invokes("menu_panel_update")).not.toEqual([]));
    const [update] = invokes("menu_panel_update") as [{ menu: number; number: number; spec: MenuSpec }];
    expect([update.menu, update.number]).toEqual([1, 1]);
    const connect = update.spec.entries[0];
    const picker = connect?.kind === "submenu" ? connect.content.entries[0] : undefined;
    expect(picker?.kind === "widget" && picker.widget.selected).toEqual(["Web", "Read"]);
  });

  it("opens a right click's menu at the point, and the page's point menu when refused", async () => {
    vi.mocked(invoke).mockRejectedValue({ kind: "app_inactive" });
    const actions = {
      block,
      vaultPath: "/vault",
      tags: [],
      currentTag: undefined,
      onToggleTag: vi.fn(),
      onCreateAndAssign: vi.fn(),
      onRequestRename: vi.fn(),
      onRequestDelete: vi.fn(),
    };
    function Feed() {
      const [menu] = useState(() => {
        const state: { session: MenuPanelSession | null; onPage: boolean; refused: () => void } = { session: null, onPage: false, refused: () => undefined };
        state.session = startCardMenuPanel(
          () => ({ ...actions, checkName: undefined }),
          { anchor: { x: 300, y: 200, width: 0, height: 0 }, opener: CARD_POINT_OPENER, byKey: false, eventAt: 1, contextMenu: true },
          { onClosed: () => undefined, onRefused: () => state.refused() },
        );
        return state;
      });
      const [onPage, setOnPage] = useState(false);
      menu.refused = () => setOnPage(true);
      return menu.session && <CardPanelPointMenu {...actions} session={menu.session} onPage={onPage} x={300} y={200} onClose={vi.fn()} />;
    }
    render(<Feed />);
    const args = opens()[0]?.[1] as { request: { anchor: unknown; opener: unknown } } | undefined;
    expect(args?.request.anchor).toEqual({ x: 300, y: 200, width: 0, height: 0 });
    expect(args?.request.opener).toEqual({ kind: "point" });
    expect(await screen.findByText("Copy Path")).toBeTruthy();
    // On the page the menu stands as in the panel: right of the point, its
    // top on it, its corner on the point with no offset (МО10, МО69).
    const surface = document.querySelector("[data-slot='dropdown-menu-content']");
    expect([surface?.getAttribute("data-side"), surface?.getAttribute("data-align")]).toEqual(["right", "start"]);
    const anchor = document.querySelector<HTMLElement>("[data-card-point-menu-anchor]");
    expect([anchor?.style.left, anchor?.style.top]).toEqual(["300px", "200px"]);
    expect(anchor?.className).toContain("size-0");
  });

  it("the component that follows a right click's menu never closes it: the feed owns it", async () => {
    panelTakes();
    const session: MenuPanelSession = { update: vi.fn(), close: vi.fn() };
    const { unmount } = render(
      <StrictMode>
        <CardPanelPointMenu
          block={block}
          vaultPath="/vault"
          tags={[]}
          currentTag={undefined}
          onToggleTag={vi.fn()}
          onCreateAndAssign={vi.fn()}
          onRequestRename={vi.fn()}
          onRequestDelete={vi.fn()}
          session={session}
          onPage={false}
          x={300}
          y={200}
          onClose={vi.fn()}
        />
      </StrictMode>,
    );
    // StrictMode ran its effects' cleanups on mount (the trial's defect:
    // the menu closed the moment it opened in the debug build).
    expect(session.close).not.toHaveBeenCalled();
    unmount();
    expect(session.close).not.toHaveBeenCalled();
  });
});
