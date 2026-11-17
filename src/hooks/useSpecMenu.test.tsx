// A menu described as data and opened by its owner (SPEC_MENU_WINDOW.md,
// МО19, МО26, МО41): in the menu panel when the panel takes it, else on the
// owner's page; the panel follows the description as it changes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { MENU_MODE_STORAGE_KEY } from "@/lib/menuMode";
import { MENU_PANEL_TO_SOURCE_EVENT } from "@/lib/menuPanelProtocol";
import { resetMenuPanelSourceForTests } from "@/lib/menuPanelSource";
import { menuSpecSize } from "@/lib/menuSpec";
import type { MenuAnswer, MenuPanelToSource, MenuSpec } from "@/types";
import { useSpecMenu, type SpecMenuAnchor } from "./useSpecMenu";

function spec(label: string, note: string | null = null): MenuSpec {
  return {
    role: "action",
    entries: [
      { kind: "item", id: "reveal", label, icon: null, variant: "default", truncate: false, disabled: false, stays_open: false, plain: false, detail: null },
      ...(note === null ? [] : [{ kind: "separator" } as const, { kind: "note", text: note, tone: "error" } as const]),
    ],
  };
}

const AT_BUTTON: SpecMenuAnchor = {
  rect: { x: 100, y: 100, width: 24, height: 24 },
  opener: { kind: "plate" },
  byKey: true,
  contextMenu: false,
};

function invokes(name: string) {
  return vi.mocked(invoke).mock.calls.filter(([command]) => command === name).map(([, args]) => args);
}

function toSource(menu: number, seq: number, body: MenuPanelToSource) {
  act(() => {
    const payload = { menu, seq, body };
    window.dispatchEvent(new CustomEvent(MENU_PANEL_TO_SOURCE_EVENT, { detail: { event: MENU_PANEL_TO_SOURCE_EVENT, payload } }));
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderMenu(first: MenuSpec, largest?: MenuSpec) {
  const onAct = vi.fn(async (): Promise<MenuAnswer> => ({ kind: "done" }));
  const onOpenChange = vi.fn();
  const view = renderHook(
    ({ now }: { now: MenuSpec }) => useSpecMenu({ spec: now, largest, act: onAct, onOpenChange }),
    { initialProps: { now: first } },
  );
  return { ...view, onAct, onOpenChange };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(command === "menu_panel_close" ? { closed: true, key_returned: true } : null));
  window.localStorage.setItem(MENU_MODE_STORAGE_KEY, "window");
  resetMenuPanelSourceForTests(true);
});

afterEach(() => {
  window.localStorage.removeItem(MENU_MODE_STORAGE_KEY);
  resetMenuPanelSourceForTests();
});

describe("useSpecMenu", () => {
  it("asks the panel for the menu as it stands, and is open in the panel", async () => {
    const first = spec("Reveal in Finder");
    const { result, onOpenChange } = renderMenu(first);
    act(() => result.current.show(AT_BUTTON));
    const [args] = invokes("menu_panel_open") as [{ request: Record<string, unknown> }];
    expect(args.request).toMatchObject({ anchor: AT_BUTTON.rect, opener: AT_BUTTON.opener, spec: first, by_key: true, ...menuSpecSize(first) });
    expect([result.current.open, result.current.inPanel, result.current.onPage]).toEqual([true, true, false]);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
  });

  it("gives the panel the size of the menu at its largest, when it may grow", () => {
    const first = spec("Reveal in Finder");
    const largest = spec("Reveal in Finder", "The collections could not be read.");
    const { result } = renderMenu(first, largest);
    act(() => result.current.show(AT_BUTTON));
    const [args] = invokes("menu_panel_open") as [{ request: { spec: MenuSpec; size: unknown } }];
    // The menu drawn is the one of now; the frame holds the largest.
    expect(args.request.spec).toEqual(first);
    expect(args.request.size).toEqual(menuSpecSize(largest).size);
  });

  it("is open on the page when the menu mode is Web, and when the panel refuses the menu", async () => {
    window.localStorage.removeItem(MENU_MODE_STORAGE_KEY);
    const web = renderMenu(spec("Reveal in Finder"));
    act(() => web.result.current.show(AT_BUTTON));
    expect(invokes("menu_panel_open")).toEqual([]);
    expect([web.result.current.open, web.result.current.onPage]).toEqual([true, true]);

    window.localStorage.setItem(MENU_MODE_STORAGE_KEY, "window");
    vi.mocked(invoke).mockRejectedValue({ kind: "not_ready" });
    const refused = renderMenu(spec("Reveal in Finder"));
    act(() => refused.result.current.show(AT_BUTTON));
    expect(refused.result.current.inPanel).toBe(true);
    await settle();
    expect([refused.result.current.open, refused.result.current.onPage]).toEqual([true, true]);
  });

  it("sends the panel every later description, and not the one the opening carried", async () => {
    const first = spec("Reveal in Finder");
    const { result, rerender } = renderMenu(first);
    act(() => result.current.show(AT_BUTTON));
    await settle();
    expect(invokes("menu_panel_update")).toEqual([]);
    const second = spec("Show in Finder");
    rerender({ now: second });
    expect(invokes("menu_panel_update")).toEqual([{ menu: 1, number: 1, spec: second }]);
    // The same description again is nothing new.
    rerender({ now: second });
    expect(invokes("menu_panel_update")).toHaveLength(1);
  });

  it("runs a choice made in the panel with the handler as it stands", async () => {
    const { result, onAct } = renderMenu(spec("Reveal in Finder"));
    act(() => result.current.show(AT_BUTTON));
    await settle();
    toSource(1, 1, { kind: "action", request: 1, action: { kind: "run", id: "reveal" } });
    await settle();
    expect(onAct).toHaveBeenCalledWith({ kind: "run", id: "reveal" });
  });

  it("closes when the menu closed in the panel, and when its owner takes it away", async () => {
    const { result, onOpenChange } = renderMenu(spec("Reveal in Finder"));
    act(() => result.current.show(AT_BUTTON));
    await settle();
    toSource(1, 1, { kind: "closed", reason: "escape", key_returned: true });
    expect(result.current.open).toBe(false);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(invokes("menu_panel_close")).toEqual([]);

    act(() => result.current.show(AT_BUTTON));
    await settle();
    act(() => result.current.hide());
    expect(result.current.open).toBe(false);
    expect(invokes("menu_panel_close")).toEqual([expect.objectContaining({ menu: 2, reason: "source" })]);
    // Closed already: nothing more to say.
    onOpenChange.mockClear();
    act(() => result.current.hide());
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
