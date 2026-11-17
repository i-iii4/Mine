// Which open space a section acts on (SPEC_TABS.md, В71), as a menu
// described as data (SPEC_MENU_WINDOW.md, Д1): on the page, and in the menu
// panel when the menu mode is `window`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { MENU_MODE_STORAGE_KEY } from "@/lib/menuMode";
import { MENU_PANEL_TO_SOURCE_EVENT } from "@/lib/menuPanelProtocol";
import { resetMenuPanelSourceForTests } from "@/lib/menuPanelSource";
import { menuActionCloses, menuSpecSize } from "@/lib/menuSpec";
import type { MenuPanelToSource, MenuSpec } from "@/types";
import { OPEN_SPACE_ID, OpenSpaceSelect, openSpaceSpec } from "./OpenSpaceSelect";
import type { OpenSpace } from "./useOpenSpaces";

const MINE: OpenSpace = { vaultId: "mine", name: "Mine", path: "/Users/me/Mine" };
const ARCHIVE: OpenSpace = { vaultId: "archive", name: "Archive", path: "/Users/me/Archive" };
const WORK: OpenSpace = { vaultId: "work", name: "Work", path: "/Users/me/Work" };

function opens() {
  return vi.mocked(invoke).mock.calls.filter(([command]) => command === "menu_panel_open")
    .map(([, args]) => (args as { request: { opener: unknown; spec: MenuSpec; size: unknown } }).request);
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

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(command === "menu_panel_close" ? { closed: true, key_returned: true } : null));
  resetMenuPanelSourceForTests(true);
});

afterEach(() => {
  window.localStorage.removeItem(MENU_MODE_STORAGE_KEY);
  resetMenuPanelSourceForTests();
});

describe("the open spaces as a menu", () => {
  it("is one choice, a row for each space, the section's own ticked, and closes on a choice", () => {
    const spec = openSpaceSpec([MINE, ARCHIVE], ARCHIVE);
    expect(spec).toEqual({
      role: "action",
      entries: [{
        kind: "radio",
        id: OPEN_SPACE_ID,
        value: "archive",
        options: [{ value: "mine", label: "Mine" }, { value: "archive", label: "Archive" }],
        closes: true,
      }],
    });
    expect(menuActionCloses(spec, { kind: "choose", id: OPEN_SPACE_ID, value: "mine" })).toBe(true);
    expect(menuSpecSize(spec).size).toEqual({ width: 240, height: 10 + 2 * 32 });
  });
});

describe("OpenSpaceSelect on the page", () => {
  it("lists the open spaces, ticks the section's, and closes on the space chosen", async () => {
    const onChoose = vi.fn();
    render(<OpenSpaceSelect spaces={[MINE, ARCHIVE]} current={MINE} onChoose={onChoose} />);
    const button = screen.getByRole("button", { name: "Space: Mine" });
    fireEvent.pointerDown(button, { button: 0, ctrlKey: false });
    const rows = await screen.findAllByRole("menuitemradio");
    expect(rows.map((row) => [row.textContent, row.getAttribute("aria-checked")])).toEqual([["Mine", "true"], ["Archive", "false"]]);
    expect(opens()).toEqual([]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Archive" }));
    expect(onChoose).toHaveBeenCalledExactlyOnceWith("archive");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});

describe("OpenSpaceSelect in the menu panel", () => {
  beforeEach(() => {
    window.localStorage.setItem(MENU_MODE_STORAGE_KEY, "window");
  });

  it("asks the panel for the spaces off the button, follows the tabs, and takes the panel's choice", async () => {
    const onChoose = vi.fn();
    const view = render(<OpenSpaceSelect spaces={[MINE, ARCHIVE]} current={MINE} onChoose={onChoose} />);
    const button = screen.getByRole("button", { name: "Space: Mine" });
    fireEvent.pointerDown(button, { button: 0, ctrlKey: false });
    expect(opens()).toHaveLength(1);
    expect(opens()[0]?.opener).toEqual({ kind: "plate" });
    expect(opens()[0]?.spec).toEqual(openSpaceSpec([MINE, ARCHIVE], MINE));
    await waitFor(() => expect(button.getAttribute("data-state")).toBe("open"));
    expect(screen.queryByRole("menu")).toBeNull();

    // A tab of another space opens under the open menu: the panel hears the
    // menu anew.
    const spaces = [MINE, ARCHIVE, WORK];
    view.rerender(<OpenSpaceSelect spaces={spaces} current={MINE} onChoose={onChoose} />);
    await waitFor(() => expect(updates().at(-1)).toEqual(openSpaceSpec(spaces, MINE)));

    toSource(1, 1, { kind: "action", request: 1, action: { kind: "choose", id: OPEN_SPACE_ID, value: "work" } });
    await waitFor(() => expect(onChoose).toHaveBeenCalledExactlyOnceWith("work"));
    // A space that is not open is no choice.
    toSource(1, 2, { kind: "action", request: 2, action: { kind: "choose", id: OPEN_SPACE_ID, value: "gone" } });
    await act(async () => {});
    expect(onChoose).toHaveBeenCalledTimes(1);
  });
});
