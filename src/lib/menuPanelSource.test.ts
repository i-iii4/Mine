import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  followMenuPanel,
  focusReturnsFromMenuPanel,
  menuPanelUsable,
  openMenuPanel,
  resetMenuPanelSourceForTests,
  type MenuPanelHandlers,
} from "./menuPanelSource";
import { MENU_PANEL_STATUS_EVENT, MENU_PANEL_TO_SOURCE_EVENT } from "./menuPanelProtocol";
import { cardMenuSpec, type CardMenuPicker } from "./cardMenuEntries";
import { menuSpecSize } from "./menuSpec";
import { MENU_MODE_STORAGE_KEY } from "./menuMode";
import { SETTINGS_CHANGED_EVENT } from "./settingsChanged";
import type { MenuAction, MenuOpener, MenuPanelCloseOutcome, MenuPanelToSource, MenuSpec } from "@/types";

const PICKER: CardMenuPicker = { card: "card", selected: [], tags: [{ tag: "Web", count: 2 }], currentTag: null };
const SPEC: MenuSpec = cardMenuSpec({ hasUrl: true, disconnectFrom: null, tableCommands: [], picker: PICKER });
/** The same menu after the card joined a collection. */
const CHANGED: MenuSpec = cardMenuSpec({ hasUrl: true, disconnectFrom: null, tableCommands: [], picker: { ...PICKER, selected: ["Web"] } });
const TOGGLE: MenuAction = { kind: "widget", id: "connect.picker", action: { kind: "toggle_collection", collection: "Web", connected: false } };
const ANCHOR = { x: 100, y: 100, width: 24, height: 24 };
const PLATE: MenuOpener = { kind: "plate" };

function backend(event: string, payload: unknown) {
  window.dispatchEvent(new CustomEvent(event, { detail: { event, payload } }));
}

/** The backend's message number `seq` of this page's menu `menu`. */
function toSource(menu: number, seq: number, body: MenuPanelToSource) {
  backend(MENU_PANEL_TO_SOURCE_EVENT, { menu, seq, body });
}

function action(request: number, choice: MenuAction): MenuPanelToSource {
  return { kind: "action", request, action: choice };
}

function run(id: string): MenuAction {
  return { kind: "run", id };
}

function closed(reason: Extract<MenuPanelToSource, { kind: "closed" }>["reason"], keyReturned = false): MenuPanelToSource {
  return { kind: "closed", reason, key_returned: keyReturned };
}

function handlers() {
  return {
    onAction: vi.fn<MenuPanelHandlers["onAction"]>(() => ({ kind: "done" })),
    onClosed: vi.fn<MenuPanelHandlers["onClosed"]>(),
    onRefused: vi.fn<MenuPanelHandlers["onRefused"]>(),
  };
}

function invokes(name: string) {
  return vi.mocked(invoke).mock.calls.filter(([command]) => command === name).map(([, args]) => args);
}

/** The backend takes every command; a closing comes to `outcome`. */
function backendAnswers(outcome: MenuPanelCloseOutcome = { closed: true, key_returned: false }) {
  vi.mocked(invoke).mockImplementation((command) => Promise.resolve(command === "menu_panel_close" ? outcome : null));
}

function open(on = handlers(), options: { contextMenu: boolean; eventAt: number | null } = { contextMenu: false, eventAt: 1 }) {
  const session = openMenuPanel(ANCHOR, PLATE, { spec: SPEC, byKey: false }, on, options);
  return { session, on };
}

/** Let the promises of the commands settle: no clock moves. */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  resetMenuPanelSourceForTests(true);
  vi.mocked(invoke).mockReset();
  backendAnswers();
});

afterEach(() => {
  resetMenuPanelSourceForTests();
  // The page's own guard of a press ends on a timer of its own
  // (src/lib/openMenus.ts): none of it reaches the next test.
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** The menu's sessions set no timer: nothing here waits on a clock. */
function noTimerIsLeft() {
  expect(vi.getTimerCount()).toBe(0);
}

describe("openMenuPanel", () => {
  afterEach(noTimerIsLeft);

  it("asks the backend at once with its own number, the anchor, the opener, the menu, its counted sizes and the times", () => {
    document.documentElement.setAttribute("data-buttons", "retro");
    openMenuPanel(ANCHOR, PLATE, { spec: SPEC, byKey: true }, handlers(), { contextMenu: false, eventAt: 1234 });
    document.documentElement.removeAttribute("data-buttons");
    // Before any await: the request left in the caller's own task.
    const [args] = invokes("menu_panel_open") as [{ request: Record<string, unknown> }];
    expect(args.request).toMatchObject({
      menu: 1,
      anchor: ANCHOR,
      opener: PLATE,
      // The menu as data, never as text: the backend reads it (МО17).
      spec: SPEC,
      by_key: true,
      // The dev button style of the window the menu came from.
      buttons: "retro",
      ...menuSpecSize(SPEC),
      event_at: 1234,
    });
    expect((args.request.submenus as unknown[]).length).toBe(1);
    expect(typeof args.request.sent_at).toBe("number");
    expect(args.request.page).toMatch(/\S/);
  });

  it("numbers its menus itself, one after another, and says when no input's event was at hand", async () => {
    const first = open();
    await settle();
    first.session.close("source");
    open(handlers(), { contextMenu: false, eventAt: null });
    const requests = (invokes("menu_panel_open") as { request: { menu: number; page: string; event_at: number | null } }[]).map(({ request }) => request);
    expect(requests.map((request) => request.menu)).toEqual([1, 2]);
    expect(requests[1]?.event_at).toBeNull();
    // One load of the page: the backend tells a page loaded anew by this.
    expect(requests[1]?.page).toBe(requests[0]?.page);
  });

  it("opens on the page when the backend refuses", async () => {
    vi.mocked(invoke).mockRejectedValue({ kind: "not_ready" });
    const { on } = open();
    await settle();
    expect(on.onRefused).toHaveBeenCalledTimes(1);
    expect(on.onClosed).not.toHaveBeenCalled();
  });

  it("opens on the page when the panel drew nothing in time or could not draw it", async () => {
    for (const [menu, reason] of [[1, "unresponsive"], [2, "failed"]] as const) {
      const { on } = open();
      await settle();
      toSource(menu, 1, closed(reason));
      expect(on.onRefused).toHaveBeenCalledTimes(1);
      expect(on.onClosed).not.toHaveBeenCalled();
    }
  });

  it("reports the reason a shown menu closed, and drops a word of another menu", async () => {
    const { on } = open();
    await settle();
    toSource(99, 1, closed("chosen"));
    expect(on.onClosed).not.toHaveBeenCalled();
    toSource(1, 1, closed("escape"));
    expect(on.onClosed).toHaveBeenCalledWith("escape");
    expect(on.onRefused).not.toHaveBeenCalled();
    // The menu is over: a second word of it is not heard.
    toSource(1, 2, closed("outside"));
    expect(on.onClosed).toHaveBeenCalledTimes(1);
  });

  it("takes a closing that came before the answer to its opening: the page knew the number", async () => {
    let answer: (value: null) => void = () => undefined;
    vi.mocked(invoke).mockImplementation((command) => command === "menu_panel_open"
      ? new Promise((resolve) => {
        answer = resolve;
      })
      : Promise.resolve(null));
    const { on } = open();
    toSource(1, 1, closed("outside"));
    expect(on.onClosed).toHaveBeenCalledWith("outside");
    answer(null);
    await settle();
    expect(on.onClosed).toHaveBeenCalledTimes(1);
    expect(on.onRefused).not.toHaveBeenCalled();
  });

  it("sends a change made before the backend said the menu shows once it does, each with its number", async () => {
    let answer: (value: null) => void = () => undefined;
    vi.mocked(invoke).mockImplementation((command) => command === "menu_panel_open"
      ? new Promise((resolve) => {
        answer = resolve;
      })
      : Promise.resolve(null));
    const { session } = open();
    session.update(SPEC);
    session.update(CHANGED);
    expect(invokes("menu_panel_update")).toEqual([]);
    answer(null);
    await settle();
    // The last one alone: the whole menu each time.
    expect(invokes("menu_panel_update")).toEqual([{ menu: 1, number: 1, spec: CHANGED }]);
    session.update(SPEC);
    expect(invokes("menu_panel_update")[1]).toEqual({ menu: 1, number: 2, spec: SPEC });
  });

  it("runs each choice of the panel with the tab's handlers and answers it through the backend", async () => {
    const on = handlers();
    on.onAction.mockImplementation(async () => ({ kind: "membership" as const, made: true }));
    open(on);
    await settle();
    toSource(1, 1, action(2, TOGGLE));
    await settle();
    expect(on.onAction).toHaveBeenCalledTimes(1);
    expect(on.onAction).toHaveBeenCalledWith(TOGGLE);
    expect(invokes("menu_panel_answer")).toEqual([{ menu: 1, request: 2, answer: { kind: "membership", made: true } }]);
  });

  it("answers a failed choice as not made", async () => {
    const on = handlers();
    on.onAction.mockImplementation(async () => {
      throw new Error("disk");
    });
    open(on);
    await settle();
    toSource(1, 1, action(1, TOGGLE));
    toSource(1, 2, action(2, { kind: "widget", id: "connect.picker", action: { kind: "check_collection_name", name: "New" } }));
    toSource(1, 3, action(3, { kind: "widget", id: "connect.picker", action: { kind: "create_collection", name: "New" } }));
    await settle();
    // Not connected, no reason to refuse the name, nothing more to say.
    expect(invokes("menu_panel_answer")).toEqual([
      { menu: 1, request: 1, answer: { kind: "membership", made: false } },
      { menu: 1, request: 2, answer: { kind: "name_refusal", reason: null } },
      { menu: 1, request: 3, answer: { kind: "done" } },
    ]);
  });

  it("carries out a choice made before the closing however the two arrive, and no clock decides it", async () => {
    const { on } = open();
    await settle();
    // The closing is the backend's second message and came first: it waits.
    toSource(1, 2, closed("chosen"));
    expect(on.onClosed).not.toHaveBeenCalled();
    // However long the choice takes to come.
    vi.advanceTimersByTime(60_000);
    expect(on.onClosed).not.toHaveBeenCalled();
    toSource(1, 1, action(1, run("rename")));
    expect(on.onAction).toHaveBeenCalledWith(run("rename"));
    expect(on.onClosed).toHaveBeenCalledWith("chosen");
    expect(on.onAction.mock.invocationCallOrder[0]).toBeLessThan(on.onClosed.mock.invocationCallOrder[0] ?? 0);
  });

  it("takes each of the backend's messages once", async () => {
    const { on } = open();
    await settle();
    toSource(1, 1, action(1, run("copy-path")));
    toSource(1, 1, action(1, run("copy-path")));
    expect(on.onAction).toHaveBeenCalledTimes(1);
  });

  it("never runs a choice for a menu that did not show", async () => {
    vi.mocked(invoke).mockRejectedValue({ kind: "not_ready" });
    const { on } = open();
    await settle();
    toSource(1, 1, action(1, run("delete")));
    await settle();
    expect(on.onAction).not.toHaveBeenCalled();
  });

  it("closes from its owner without reporting back, and drops a choice made in it since", async () => {
    const { session, on } = open();
    await settle();
    session.close("source");
    const [args] = invokes("menu_panel_close") as [{ page: string; menu: number; reason: string }];
    expect(args).toMatchObject({ menu: 1, reason: "source" });
    expect(args.page).toBe((invokes("menu_panel_open")[0] as { request: { page: string } }).request.page);
    toSource(1, 1, action(1, run("delete")));
    toSource(1, 2, closed("source"));
    await settle();
    expect(on.onAction).not.toHaveBeenCalled();
    expect(on.onClosed).not.toHaveBeenCalled();
    expect(on.onRefused).not.toHaveBeenCalled();
    // Once is enough.
    session.close("source");
    expect(invokes("menu_panel_close")).toHaveLength(1);
  });

  it("closes a menu its owner closed before the backend answered, and opens nothing on the page for it", async () => {
    let refuse: (reason: unknown) => void = () => undefined;
    vi.mocked(invoke).mockImplementation((command) => command === "menu_panel_open"
      ? new Promise((_resolve, reject) => {
        refuse = reject;
      })
      : Promise.resolve({ closed: false, key_returned: false }));
    const { session, on } = open();
    session.close("source");
    expect(invokes("menu_panel_close")).toEqual([expect.objectContaining({ menu: 1, reason: "source" })]);
    // The closing overtook the opening: the backend refuses the opening.
    refuse({ kind: "superseded" });
    await settle();
    expect(on.onRefused).not.toHaveBeenCalled();
    expect(on.onClosed).not.toHaveBeenCalled();
  });

  it("replaces an open menu of the page, telling its owner", async () => {
    const first = open();
    await settle();
    const second = open();
    expect(first.on.onClosed).toHaveBeenCalledWith("source");
    expect(second.on.onClosed).not.toHaveBeenCalled();
    expect(invokes("menu_panel_close")).toEqual([expect.objectContaining({ menu: 1, reason: "source" })]);
    expect((invokes("menu_panel_open")[1] as { request: { menu: number } }).request.menu).toBe(2);
  });
});

describe("the page while the menu is in the panel", () => {
  it("only closes the menu on a press that reaches it, and holds the press and its click", async () => {
    open();
    await settle();
    const button = document.createElement("button");
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    document.body.append(button);
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(clicked).not.toHaveBeenCalled();
    expect(invokes("menu_panel_close")).toEqual([expect.objectContaining({ menu: 1, reason: "outside" })]);
    expect(document.documentElement.hasAttribute("data-menu-open")).toBe(true);
    button.remove();
  });

  it("lets presses through the moment the menu closed: the backend held the press that closed it", async () => {
    open();
    await settle();
    toSource(1, 1, closed("outside", true));
    expect(document.documentElement.hasAttribute("data-menu-open")).toBe(false);
    const button = document.createElement("button");
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    document.body.append(button);
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(clicked).toHaveBeenCalledTimes(1);
    button.remove();
  });
});

describe("the window's focus after a menu in the panel", () => {
  afterEach(noTimerIsLeft);

  function focus() {
    window.dispatchEvent(new Event("focus"));
    return focusReturnsFromMenuPanel();
  }

  function blur() {
    window.dispatchEvent(new Event("blur"));
  }

  it("is the person's when no menu was in the panel", async () => {
    const { session } = open();
    await settle();
    session.close("source");
    await settle();
    expect(focus()).toBe(false);
  });

  it("is the panel giving the keyboard back when it comes before the word of the closing", async () => {
    open();
    await settle();
    blur();
    expect(focus()).toBe(true);
    // The word comes after: the focus it names was counted already.
    toSource(1, 1, closed("chosen", true));
    blur();
    expect(focus()).toBe(false);
  });

  it("is the panel giving the keyboard back when it comes after the word of the closing, however late", async () => {
    open();
    await settle();
    blur();
    toSource(1, 1, closed("escape", true));
    vi.advanceTimersByTime(60_000);
    expect(focus()).toBe(true);
    // Once: the next focus is the person's.
    blur();
    expect(focus()).toBe(false);
  });

  it("is a return to the app when the backend gave no keyboard back: the app was away", async () => {
    open();
    await settle();
    blur();
    toSource(1, 1, closed("outside", false));
    expect(focus()).toBe(false);
  });

  it("is the panel's after the owner closed the menu and the backend gave the keyboard back", async () => {
    backendAnswers({ closed: true, key_returned: true });
    const { session } = open();
    await settle();
    blur();
    session.close("source");
    await settle();
    expect(focus()).toBe(true);
    blur();
    expect(focus()).toBe(false);
  });

  it("counts a keyboard given back once, whichever of the backend's two words of it comes first", async () => {
    backendAnswers({ closed: true, key_returned: true });
    const { session } = open();
    await settle();
    blur();
    session.close("source");
    // The message of the closing, then the command's own answer.
    toSource(1, 1, closed("source", true));
    await settle();
    expect(focus()).toBe(true);
    blur();
    expect(focus()).toBe(false);
  });

  it("forgets a keyboard promised back when the window loses it again first", async () => {
    open();
    await settle();
    toSource(1, 1, closed("chosen", true));
    blur();
    // A return to the app: at most a reading of the disk too many.
    expect(focus()).toBe(false);
  });
});

describe("the menu mode", () => {
  it("makes the panel for Window and takes it away for Web at once, and follows its readiness", async () => {
    resetMenuPanelSourceForTests(false);
    vi.mocked(invoke).mockResolvedValue({ ready: false });
    window.localStorage.removeItem(MENU_MODE_STORAGE_KEY);
    followMenuPanel();
    await settle();
    expect(invokes("menu_panel_prepare")).toEqual([]);

    window.localStorage.setItem(MENU_MODE_STORAGE_KEY, "window");
    backend(SETTINGS_CHANGED_EVENT, { key: MENU_MODE_STORAGE_KEY, value: "window" });
    await settle();
    // With the page's load: a menu its former load left open closes.
    expect(invokes("menu_panel_prepare")).toEqual([{ page: expect.stringMatching(/\S/) }]);
    // Not ready until the backend found the panel clear.
    expect(menuPanelUsable()).toBe(false);
    backend(MENU_PANEL_STATUS_EVENT, { ready: true });
    expect(menuPanelUsable()).toBe(true);

    window.localStorage.removeItem(MENU_MODE_STORAGE_KEY);
    backend(SETTINGS_CHANGED_EVENT, { key: MENU_MODE_STORAGE_KEY, value: null });
    await settle();
    expect(invokes("menu_panel_dispose")).toHaveLength(1);
    expect(menuPanelUsable()).toBe(false);
  });
});

describe("the backend's commands of the panel", () => {
  it("name the commands and their arguments as the backend declares them", async () => {
    const commands = await import("./menuPanelCommands");
    vi.mocked(invoke).mockResolvedValue({ ready: true });
    await commands.prepareMenuPanelWindow("load");
    await commands.disposeMenuPanelWindow();
    await commands.reportMenuPanelReady();
    await commands.updateMenuInPanel(3, 2, SPEC);
    await commands.answerMenuPanel(3, 4, { kind: "done" });
    await commands.closeMenuPanel("load", 3, "escape");
    const request = { source: "tab-a", menu: 3, request: 1, action: null, close: "escape" as const };
    await commands.requestOfMenuPanel(request);
    const paint = { source: "tab-a", menu: 3, received_at: 1, sized_at: 1, drawn_at: 2, frame_at: 3, measured: { width: 240, height: 325 } };
    await commands.reportMenuPanelPainted(paint);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["menu_panel_prepare", { page: "load" }],
      ["menu_panel_dispose"],
      ["menu_panel_ready"],
      ["menu_panel_update", { menu: 3, number: 2, spec: SPEC }],
      ["menu_panel_answer", { menu: 3, request: 4, answer: { kind: "done" } }],
      ["menu_panel_close", { page: "load", menu: 3, reason: "escape" }],
      ["menu_panel_request", { request }],
      ["menu_panel_painted", { paint }],
    ]);
  });

  it("has a command of the app's menu bar only close an open menu, the commands of text editing apart", () => {
    // SPEC_MENU_WINDOW.md, МО51, МО52: Undo, Redo and Select All still reach
    // the field of a menu's search; any other command closes the menu and is
    // not carried out.
    const handler = /fn on_menu_event\([^)]*\) \{([\s\S]*?)\n\}/.exec(readFileSync("src-tauri/src/lib.rs", "utf8"))?.[1] ?? "";
    const edit = handler.indexOf("EditMenuCommand::from_menu_id");
    const closes = handler.indexOf("menu_panel::closes_for_command(app)");
    const commands = handler.indexOf("match id {");
    expect(edit).toBeGreaterThanOrEqual(0);
    expect(closes).toBeGreaterThan(edit);
    expect(commands).toBeGreaterThan(closes);
  });

  it("are every command the backend registers for the panel, each on the main thread", () => {
    const registered = [...readFileSync("src-tauri/src/lib.rs", "utf8").matchAll(/commands::menu_panel::(menu_panel_\w+)/g)].map((match) => match[1]);
    const used = [...readFileSync("src/lib/menuPanelCommands.ts", "utf8").matchAll(/"(menu_panel_\w+)"/g)].map((match) => match[1]);
    expect([...registered].sort()).toEqual([...used].sort());
    // One thread sets the order of what is said about a menu (МО36).
    const backendCommands = readFileSync("src-tauri/src/commands/menu_panel.rs", "utf8");
    expect(backendCommands).not.toMatch(/async fn/);
  });
});

describe("the order of events about a menu", () => {
  // SPEC_MENU_WINDOW.md, section 5: told by numbers, never by time. One time
  // is left, the backend's deadline for the panel's first frame (МО40).
  const pages = [
    "src/lib/menuPanelSource.ts",
    "src/lib/menuPanelProtocol.ts",
    "src/lib/menuPanelCommands.ts",
    "src/menuPanel/MenuPanelApp.tsx",
  ];

  it("is told by no timer and no clock on either page", () => {
    for (const path of pages) {
      const code = readFileSync(path, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code, path).not.toMatch(/setTimeout|setInterval|Date\.now\(\)/);
      // The page's clock is read for the log of an opening's steps alone.
      for (const line of code.split("\n").filter((text) => text.includes("performance."))) {
        expect(line, path).toMatch(/performance\.timeOrigin \+ (performance\.now\(\)|event\.timeStamp|frame)/);
      }
    }
  });

  it("leaves the backend one time, the deadline of the panel's first frame", () => {
    const backendCode = readFileSync("src-tauri/src/menu_panel/mod.rs", "utf8");
    expect(backendCode.match(/Duration::from_(millis|secs)/g)).toEqual(["Duration::from_millis"]);
    expect(backendCode).toMatch(/const PAINT_DEADLINE: Duration = Duration::from_millis\(400\);/);
    expect(backendCode).not.toMatch(/Instant/);
  });

  it("uses none of the methods the first trial borrowed from AppKit's private side", () => {
    const native = readFileSync("src-tauri/src/menu_panel/native.rs", "utf8");
    // The panel has a window class of its own (МО62); the look of the window
    // under the menu is read from public properties (МО63).
    expect(native).not.toMatch(/class_replaceMethod|_hasActiveAppearance/);
    expect(native).toMatch(/ClassBuilder::new\(PANEL_CLASS/);
  });
});
