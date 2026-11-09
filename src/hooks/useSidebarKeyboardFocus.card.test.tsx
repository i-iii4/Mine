import { createRef, useEffect, useRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DndContext } from "@dnd-kit/core";
import { EditorView } from "@codemirror/view";
import { CardPeek, type CardPeekOpening } from "@/components/CardPeek";
import { Detail } from "@/components/Detail";
import { NoteEditingSwitch } from "@/components/editing/noteEditingSwitch";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { beginNoteEdit, noteBodyState, resolveNoteLink } from "@/lib/commands";
import { sidebarRowDomId } from "@/lib/sidebarSearch";
import { indexedBlock } from "@/test/blocks";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";
import {
  useSidebarKeyboardFocus,
  type FeedKeyboardFocus,
  type SidebarKeyboardFocus,
} from "./useSidebarKeyboardFocus";

// The real open card, with CodeMirror and a table cell's editor, beside the focus
// owner (SPEC_KEYBOARD.md, М9).

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
  revealItemInDir: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => undefined), writeHtml: vi.fn(async () => undefined) }));
vi.mock("@/lib/reading/mermaid", () => ({
  readMermaidLayout: vi.fn(() => ({ fontFamily: "system-ui", fontFamilyMono: "ui-monospace", width: 680 })),
  renderMermaid: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/commands", () => ({
  getBlock: vi.fn(async () => null),
  resolveNoteLink: vi.fn(async () => null),
  toggleTaskItem: vi.fn(),
  beginNoteEdit: vi.fn(),
  endNoteEdit: vi.fn(async () => undefined),
  noteBodyState: vi.fn(),
  reportEditsFlushed: vi.fn(async () => undefined),
  reportNoteEdits: vi.fn(async () => undefined),
  reportFocusedEditor: vi.fn(async () => undefined),
  saveNoteBody: vi.fn(() => new Promise(() => undefined)),
  suggestNoteLinks: vi.fn(async () => []),
  icloudDownloadProgress: vi.fn(async () => ({ status: "unknown", percent: null })),
  listCardAssociations: vi.fn(async (slug: string) => ({ generation: 1, slug, groups: [] })),
}));

const BODY = "First line of the note.\n\n| A | B |\n|---|---|\n| a | 1 |\n";
const card = indexedBlock({ slug: "Cards/Open", body: BODY, body_hash: "hash-0", display_title: "Open" });
const ROWS = ["all", "tag:alpha", "tag:beta"];

const handle: { current: SidebarKeyboardFocus | null } = { current: null };
const sidebar = { shown: false };
const connections: string[] = [];

function Page({ currentRowKey, sidebarHidden, cardOpen, sizedBy, feed, onOpen, onClose }: {
  currentRowKey: string | null;
  sidebarHidden: boolean;
  cardOpen: boolean;
  sizedBy: "window" | "frame";
  feed: FeedKeyboardFocus;
  onOpen: (rowKey: string) => void;
  onClose: () => void;
}) {
  const [opened, setOpened] = useState(false);
  // The card's connections, as the page keeps them.
  const [linked, setLinkedRows] = useState<ReadonlySet<string>>(new Set());
  const setLinked = (rowKey: string, on: boolean) => {
    connections.push(`${on ? "connect" : "disconnect"} ${rowKey}`);
    setLinkedRows((rows) => {
      const next = new Set(rows);
      if (on) next.add(rowKey);
      else next.delete(rowKey);
      return next;
    });
  };
  const sidebarShown = !sidebarHidden || opened;
  sidebar.shown = sidebarShown;
  const [query, setQuery] = useState("");
  const fieldRef = useRef<HTMLInputElement>(null);
  const focus = useSidebarKeyboardFocus({
    rows: ROWS,
    currentRowKey,
    feedOnScreen: true,
    cardOpen,
    sidebarShown,
    openedForKeyboard: opened,
    setOpenedForKeyboard: setOpened,
    filterQuery: query,
    setFilterQuery: setQuery,
    filterFieldRef: fieldRef,
    moveRow: () => false,
  });
  handle.current = focus;
  const { reportFeed } = focus;
  useEffect(() => reportFeed(feed), [feed, reportFeed]);
  return (
    <TooltipProvider>
      <DndContext>
        {sidebarShown && (
          <input
            ref={fieldRef}
            aria-label="The filter"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={focus.fieldFocused}
            onBlur={focus.fieldBlurred}
          />
        )}
        <nav data-sidebar-scroll="">
          {ROWS.map((rowKey) => (
            <ContextMenu key={rowKey}>
              <ContextMenuTrigger asChild>
                <div id={sidebarRowDomId(rowKey)}>
                  <a data-sidebar-row-body="" href="#row" onClick={(event) => { event.preventDefault(); onOpen(rowKey); }}>
                    <span data-sidebar-name-text="">{rowKey}</span>
                  </a>
                  {rowKey !== "all" && (
                    <button type="button" data-sidebar-link-action="" onClick={() => setLinked(rowKey, !linked.has(rowKey))}>
                      {linked.has(rowKey) ? `Disconnect ${rowKey}` : `Connect ${rowKey}`}
                    </button>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem>{`Rename ${rowKey}`}</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </nav>
        <NoteEditingSwitch.Provider value={true}>
          {cardOpen && (
            <Detail
              block={card}
              vaultPath="/vault"
              thumbsRootPath="/thumbs"
              tags={[]}
              sizedBy={sizedBy}
              onClose={onClose}
              onNavigate={vi.fn()}
              onToggleTag={vi.fn()}
              onCreateAndAssign={vi.fn()}
              onTagsChanged={vi.fn()}
              onRequestRename={vi.fn()}
              onRequestDelete={vi.fn()}
              onOpenRelatedNote={vi.fn()}
            />
          )}
        </NoteEditingSwitch.Provider>
      </DndContext>
    </TooltipProvider>
  );
}

beforeAll(() => {
  installCodeMirrorLayoutStubs();
  // jsdom has no `isContentEditable`; the card's Escape asks it, as a browser answers.
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest("[contenteditable='true']") !== null;
    },
  });
});

afterAll(() => {
  delete (HTMLElement.prototype as { isContentEditable?: boolean }).isContentEditable;
});

beforeEach(() => {
  connections.length = 0;
  vi.mocked(beginNoteEdit).mockImplementation(async () => card);
  vi.mocked(noteBodyState).mockImplementation(async () => ({ body: BODY, body_hash: "hash-0" }));
  vi.mocked(resolveNoteLink).mockResolvedValue(null);
});

const focusedRow = () => handle.current?.rowKey ?? null;
const root = () => document.querySelector<HTMLElement>("[data-detail-root] [data-detail-scroll]")!;

function key(init: KeyboardEventInit, target: Element = document.activeElement ?? document.body) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
}

async function open(overrides: Partial<Parameters<typeof Page>[0]> = {}) {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const feed = { take: vi.fn(() => true), release: vi.fn() };
  const props = {
    currentRowKey: "tag:beta",
    sidebarHidden: false,
    cardOpen: true,
    sizedBy: "window" as const,
    feed,
    onOpen,
    onClose,
    ...overrides,
  };
  const view = render(<Page {...props} />);
  await waitFor(() => {
    const content = view.container.querySelector<HTMLElement>(".cm-content");
    if (!content || !EditorView.findFromDOM(content)) throw new Error("no editor yet");
  });
  let current = props;
  return {
    ...view,
    onOpen,
    onClose,
    feed,
    update: (next: Partial<Parameters<typeof Page>[0]>) => {
      current = { ...current, ...next };
      view.rerender(<Page {...current} />);
    },
    editor: () => EditorView.findFromDOM(view.container.querySelector<HTMLElement>(".cm-content")!)!,
  };
}

describe.each(["window", "frame"] as const)("the open card sized by its %s (SPEC_KEYBOARD.md, М9)", (sizedBy) => {
  it("ArrowLeft from the card's root goes to the current collection's row, and the card hears nothing", async () => {
    const { onClose } = await open({ sizedBy });
    act(() => root().focus());
    expect(document.activeElement).toBe(root());
    const event = key({ key: "ArrowLeft" });
    expect(event.defaultPrevented).toBe(true);
    expect(focusedRow()).toBe("tag:beta");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("with the caret in the editor ArrowLeft stays the caret's, and the menu is not reached", async () => {
    const { editor } = await open({ sizedBy });
    const view = editor();
    act(() => {
      view.dispatch({ selection: { anchor: 5 }, userEvent: "select" });
      view.focus();
    });
    expect(document.activeElement).toBe(view.contentDOM);
    key({ key: "ArrowLeft", keyCode: 37 }, view.contentDOM);
    expect(focusedRow()).toBeNull();
  });

  it("with the caret in a table cell ArrowLeft stays the caret's", async () => {
    const { container } = await open({ sizedBy });
    const drawn = await waitFor(() => {
      const found = container.querySelector<HTMLElement>("[data-editor-block='table'] tbody td");
      if (!found) throw new Error("no table yet");
      return found;
    });
    fireEvent.mouseDown(drawn, { button: 0 });
    fireEvent.mouseUp(window);
    const cell = await waitFor(() => {
      const found = container.querySelector<HTMLElement>("[data-table-cell-editor] .cm-content");
      if (!found) throw new Error("no cell editor yet");
      return found;
    });
    act(() => cell.focus());
    expect(document.activeElement).toBe(cell);
    key({ key: "ArrowLeft", keyCode: 37 }, cell);
    expect(focusedRow()).toBeNull();
  });

  it("from the card's root again after the text, ArrowLeft goes to the menu", async () => {
    const { editor } = await open({ sizedBy });
    act(() => editor().focus());
    key({ key: "ArrowLeft", keyCode: 37 }, editor().contentDOM);
    expect(focusedRow()).toBeNull();
    act(() => root().focus());
    key({ key: "ArrowLeft" });
    expect(focusedRow()).toBe("tag:beta");
  });

  it("Escape leaves the text for the card's root, ArrowLeft then goes to the menu", async () => {
    const { editor, onClose } = await open({ sizedBy });
    const view = editor();
    act(() => view.focus());
    expect(document.activeElement).toBe(view.contentDOM);
    key({ key: "Escape", keyCode: 27 }, view.contentDOM);
    expect(document.activeElement).toBe(root());
    expect(onClose).not.toHaveBeenCalled();
    key({ key: "ArrowLeft" });
    expect(focusedRow()).toBe("tag:beta");
  });

  it("the next Escape after the text closes the card", async () => {
    const { editor, onClose } = await open({ sizedBy });
    act(() => editor().focus());
    key({ key: "Escape", keyCode: 27 }, editor().contentDOM);
    expect(onClose).not.toHaveBeenCalled();
    key({ key: "Escape", keyCode: 27 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a table cell's first Escape goes to the main editor, the next to the root", async () => {
    const { container, editor } = await open({ sizedBy });
    const drawn = await waitFor(() => {
      const found = container.querySelector<HTMLElement>("[data-editor-block='table'] tbody td");
      if (!found) throw new Error("no table yet");
      return found;
    });
    fireEvent.mouseDown(drawn, { button: 0 });
    fireEvent.mouseUp(window);
    const cell = await waitFor(() => {
      const found = container.querySelector<HTMLElement>("[data-table-cell-editor] .cm-content");
      if (!found) throw new Error("no cell editor yet");
      return found;
    });
    act(() => cell.focus());
    key({ key: "Escape", keyCode: 27 }, cell);
    await waitFor(() => expect(container.querySelector("[data-table-cell-editor]")).toBeNull());
    expect(document.activeElement).toBe(editor().contentDOM);
    key({ key: "Escape", keyCode: 27 }, editor().contentDOM);
    expect(document.activeElement).toBe(root());
    key({ key: "ArrowLeft" });
    expect(focusedRow()).toBe("tag:beta");
  });

  it("an Escape the editor takes for itself stays in the text", async () => {
    const { editor } = await open({ sizedBy });
    const view = editor();
    act(() => view.focus());
    const taken = new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true, cancelable: true });
    view.contentDOM.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    act(() => { view.contentDOM.dispatchEvent(taken); });
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it("← then → on the same row returns to that card: no route change, no click and no close", async () => {
    const { onOpen, onClose, feed } = await open({ sizedBy });
    act(() => root().focus());
    key({ key: "ArrowLeft" });
    act(() => root().blur());
    key({ key: "ArrowRight" });
    expect(focusedRow()).toBeNull();
    expect(document.activeElement).toBe(root());
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(feed.take).not.toHaveBeenCalled();
  });

  it("Enter toggles the card's connection twice, the button following and the focus staying", async () => {
    const { onOpen, onClose } = await open({ sizedBy });
    act(() => root().focus());
    key({ key: "ArrowLeft" });
    expect(screen.getByRole("button", { name: "Connect tag:beta" })).toBeInTheDocument();

    key({ key: "Enter" });
    expect(connections).toEqual(["connect tag:beta"]);
    expect(screen.getByRole("button", { name: "Disconnect tag:beta" })).toBeInTheDocument();
    expect(focusedRow()).toBe("tag:beta");

    key({ key: "Enter" });
    expect(connections).toEqual(["connect tag:beta", "disconnect tag:beta"]);
    expect(screen.getByRole("button", { name: "Connect tag:beta" })).toBeInTheDocument();
    expect(focusedRow()).toBe("tag:beta");

    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Enter on another row toggles that row, and never opens it or closes the card", async () => {
    const { onOpen, onClose } = await open({ sizedBy });
    act(() => root().focus());
    key({ key: "ArrowLeft" });
    key({ key: "ArrowUp" });
    key({ key: "Enter" });
    expect(connections).toEqual(["connect tag:alpha"]);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(focusedRow()).toBe("tag:alpha");
  });

  it("a held Enter toggles once", async () => {
    await open({ sizedBy });
    act(() => root().focus());
    key({ key: "ArrowLeft" });
    key({ key: "Enter" });
    key({ key: "Enter", repeat: true });
    key({ key: "Enter", repeat: true });
    expect(connections).toEqual(["connect tag:beta"]);
  });

  it("ArrowRight returns to the card's root with no caret, and the next Escape closes the card", async () => {
    const { onClose } = await open({ sizedBy });
    act(() => root().focus());
    key({ key: "ArrowLeft" });
    act(() => root().blur());
    key({ key: "ArrowRight" });
    expect(focusedRow()).toBeNull();
    expect(document.activeElement).toBe(root());
    expect(onClose).not.toHaveBeenCalled();
    key({ key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape returns to the card's root as well, and does not close the card; the next one does", async () => {
    const { onClose, feed } = await open({ sizedBy });
    act(() => root().focus());
    key({ key: "ArrowLeft" });
    key({ key: "Escape" });
    expect(focusedRow()).toBeNull();
    expect(document.activeElement).toBe(root());
    expect(onClose).not.toHaveBeenCalled();
    expect(feed.release).not.toHaveBeenCalled();
    key({ key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the keys belong to the sidebar while the focus is in it: the arrows walk, and ⌘K opens the row's menu", async () => {
    const { onOpen } = await open({ sizedBy });
    act(() => root().focus());
    key({ key: "ArrowLeft" });
    key({ key: "ArrowUp" });
    expect(focusedRow()).toBe("tag:alpha");
    expect(onOpen).not.toHaveBeenCalled();
    key({ key: "k", metaKey: true });
    expect(await screen.findByRole("menuitem", { name: "Rename tag:alpha" })).toBeInTheDocument();
  });
});

describe("the card's window at rest (SPEC_CARD_PEEK.md, О11)", () => {
  function inWindow() {
    const area = document.createElement("main");
    document.body.append(area);
    const areaRef = createRef<HTMLElement>();
    Object.assign(areaRef, { current: area });
    const onClose = vi.fn();
    const peek: CardPeekOpening = { sequence: 1, slug: card.slug, from: "elsewhere", restored: true };
    const view = render(
      <TooltipProvider>
        <DndContext>
          <NoteEditingSwitch.Provider value={true}>
            <CardPeek block={card} opening={peek} exit="return" areaRef={areaRef} onClose={onClose} onReopen={vi.fn()}>
              {() => (
                <Detail
                  block={card}
                  vaultPath="/vault"
                  thumbsRootPath="/thumbs"
                  tags={[]}
                  sizedBy="frame"
                  onClose={onClose}
                  onNavigate={vi.fn()}
                  onToggleTag={vi.fn()}
                  onCreateAndAssign={vi.fn()}
                  onTagsChanged={vi.fn()}
                  onRequestRename={vi.fn()}
                  onRequestDelete={vi.fn()}
                  onOpenRelatedNote={vi.fn()}
                />
              )}
            </CardPeek>
          </NoteEditingSwitch.Provider>
        </DndContext>
      </TooltipProvider>,
    );
    return { ...view, onClose };
  }

  it("a first Escape in the text does not close the window; the next one does", async () => {
    const { container, onClose } = inWindow();
    const content = await waitFor(() => {
      const found = container.querySelector<HTMLElement>(".cm-content");
      if (!found || !EditorView.findFromDOM(found)) throw new Error("no editor yet");
      return found;
    });
    act(() => EditorView.findFromDOM(content)!.focus());
    expect(document.activeElement).toBe(content);

    key({ key: "Escape", keyCode: 27 }, content);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(root());
    fireEvent.keyUp(window, { key: "Escape" });

    key({ key: "Escape", keyCode: 27 });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(window, { key: "Escape" });
  });
});

describe("the open card, whichever its view (SPEC_KEYBOARD.md, М9)", () => {
  it("ArrowRight on another row goes back to the card's root: it opens nothing and closes nothing", async () => {
    const { onOpen, onClose, feed } = await open();
    act(() => root().focus());
    key({ key: "ArrowLeft" });
    key({ key: "ArrowUp" });
    expect(focusedRow()).toBe("tag:alpha");
    key({ key: "ArrowRight" });
    expect(focusedRow()).toBeNull();
    expect(document.activeElement).toBe(root());
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(feed.take).not.toHaveBeenCalled();
  });

  it("⌘⌥↑↓ waits for a new feed still on its way", async () => {
    const notYet = { take: vi.fn(() => false), release: vi.fn() };
    const { update } = await open({ feed: notYet });
    act(() => root().focus());
    key({ key: "ArrowLeft" });
    act(() => { handle.current!.moveWithRoute("tag:alpha"); });
    update({ currentRowKey: "tag:alpha", cardOpen: false });
    expect(notYet.take).toHaveBeenCalledTimes(1);
    const ready = { take: vi.fn(() => true), release: vi.fn() };
    update({ feed: ready });
    expect(ready.take).toHaveBeenCalledTimes(1);
  });

  it("Enter on Everything's row does nothing, and the focus stays", async () => {
    const { onOpen, onClose } = await open({ currentRowKey: "all" });
    act(() => root().focus());
    key({ key: "ArrowLeft" });
    expect(focusedRow()).toBe("all");
    key({ key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(connections).toEqual([]);
    expect(focusedRow()).toBe("all");
  });

  it("opens a hidden sidebar for the visit, keeps it through Enter, and hides it on ArrowRight", async () => {
    await open({ sidebarHidden: true });
    expect(sidebar.shown).toBe(false);
    act(() => root().focus());
    key({ key: "ArrowLeft" });
    expect(sidebar.shown).toBe(true);
    expect(focusedRow()).toBe("tag:beta");
    key({ key: "Enter" });
    expect(sidebar.shown).toBe(true);
    expect(focusedRow()).toBe("tag:beta");
    key({ key: "ArrowRight" });
    expect(sidebar.shown).toBe(false);
    expect(document.activeElement).toBe(root());
  });

  it("hides it on Escape, with the focus on the card's root", async () => {
    const { onClose } = await open({ sidebarHidden: true });
    act(() => root().focus());
    key({ key: "ArrowLeft" });
    key({ key: "Escape" });
    expect(sidebar.shown).toBe(false);
    expect(document.activeElement).toBe(root());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("hides it when ArrowRight goes back from another row", async () => {
    const { feed } = await open({ sidebarHidden: true });
    act(() => root().focus());
    key({ key: "ArrowLeft" });
    key({ key: "ArrowUp" });
    key({ key: "ArrowRight" });
    expect(sidebar.shown).toBe(false);
    expect(document.activeElement).toBe(root());
    expect(feed.take).not.toHaveBeenCalled();
  });

  it("leaves an open sidebar open when ArrowRight goes back from another row", async () => {
    await open();
    act(() => root().focus());
    key({ key: "ArrowLeft" });
    key({ key: "ArrowUp" });
    key({ key: "ArrowRight" });
    expect(sidebar.shown).toBe(true);
    expect(focusedRow()).toBeNull();
    expect(document.activeElement).toBe(root());
  });

  it("⌘⌥↑↓ still goes to the collection: the card goes with the route, and the new feed takes the focus", async () => {
    const { update, feed } = await open();
    act(() => root().focus());
    key({ key: "ArrowLeft" });
    act(() => { handle.current!.moveWithRoute("tag:alpha"); });
    expect(focusedRow()).toBeNull();
    update({ currentRowKey: "tag:alpha", cardOpen: false });
    expect(feed.take).toHaveBeenCalledTimes(1);
  });

  it("the pointer ends the mode, the sidebar and the card's DOM focus staying", async () => {
    const { feed } = await open({ sidebarHidden: true });
    act(() => root().focus());
    key({ key: "ArrowLeft" });
    const move = new MouseEvent("pointermove", { bubbles: true, clientX: 10, clientY: 10 });
    Object.defineProperty(move, "movementX", { value: 5 });
    Object.defineProperty(move, "movementY", { value: 5 });
    act(() => { document.body.dispatchEvent(move); });
    expect(focusedRow()).toBeNull();
    expect(sidebar.shown).toBe(true);
    expect(feed.release).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(root());
  });

  it("the card closing under the focus hands it to the feed", async () => {
    const { update, feed } = await open();
    act(() => root().focus());
    key({ key: "ArrowLeft" });
    update({ cardOpen: false });
    expect(focusedRow()).toBeNull();
    expect(feed.take).toHaveBeenCalledTimes(1);
  });

  it("a field keeps the arrow: an input stands for anything else editable", async () => {
    const { container } = await open();
    const field = document.createElement("input");
    container.append(field);
    act(() => field.focus());
    key({ key: "ArrowLeft" }, field);
    expect(focusedRow()).toBeNull();
  });

  it.each([
    ["a menu", (holder: HTMLElement) => { holder.setAttribute("role", "menu"); holder.tabIndex = -1; }],
    ["a dialog", (holder: HTMLElement) => { holder.setAttribute("role", "dialog"); holder.tabIndex = -1; }],
    ["an alert dialog", (holder: HTMLElement) => { holder.setAttribute("role", "alertdialog"); holder.tabIndex = -1; }],
    ["the image preview", (holder: HTMLElement) => { holder.setAttribute("data-image-preview-overlay", ""); holder.tabIndex = -1; }],
  ])("%s keeps the keyboard", async (_name, make) => {
    const { container } = await open();
    const holder = document.createElement("div");
    make(holder);
    container.append(holder);
    act(() => holder.focus());
    key({ key: "ArrowLeft" }, holder);
    expect(focusedRow()).toBeNull();
  });

  it("the image preview holds it even with the focus elsewhere, and a player in focus seeks with it", async () => {
    const { container } = await open();
    act(() => root().focus());
    const preview = document.createElement("div");
    preview.setAttribute("data-image-preview-overlay", "");
    container.append(preview);
    key({ key: "ArrowLeft" });
    expect(focusedRow()).toBeNull();
    preview.remove();

    const player = document.createElement("video");
    player.tabIndex = 0;
    container.append(player);
    act(() => player.focus());
    key({ key: "ArrowLeft" }, player);
    expect(focusedRow()).toBeNull();
  });
});
