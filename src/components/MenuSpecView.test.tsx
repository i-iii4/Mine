// The one view of a menu described as data (SPEC_MENU_WINDOW.md, МО16, МО23,
// МО27): its entries in a dropdown's surface, every choice an action that
// names its entry.

import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { displayChoice, displaySpec } from "@/lib/displayMenu";
import { menuItem } from "@/lib/menuSpec";
import { mediaAssetSpec, newCardSpec, sourceVideoSpec } from "@/lib/openCardMenus";
import type { MenuAnswer, MenuSpec } from "@/types";
import { MenuSpecView, menuSurfaceClass, type MenuDispatch } from "./MenuSpecView";

const PICKER: MenuSpec = {
  role: "search",
  entries: [{
    kind: "widget",
    id: "connect.picker",
    widget: {
      kind: "collection_picker",
      card: "card",
      selected: ["Web"],
      collections: [{ name: "Web", count: 3 }, { name: "Read", count: 1 }],
      current: null,
    },
  }],
};

const SPEC: MenuSpec = {
  role: "action",
  entries: [
    { kind: "submenu", id: "connect", label: "Connect", icon: "plus", plain: false, content: PICKER },
    {
      kind: "submenu",
      id: "table",
      label: "Table",
      icon: null,
      plain: false,
      content: {
        role: "action",
        entries: [
          { kind: "item", id: "table:row", label: "Add Row", icon: null, variant: "default", truncate: false, disabled: false, stays_open: false, plain: false, detail: null },
          { kind: "separator" },
          { kind: "item", id: "table:delete", label: "Delete Table", icon: null, variant: "destructive", truncate: false, disabled: false, stays_open: false, plain: false, detail: null },
        ],
      },
    },
    { kind: "separator" },
    { kind: "item", id: "source", label: "Source", icon: "external", variant: "default", truncate: false, disabled: false, stays_open: false, plain: false, detail: null },
    { kind: "item", id: "disconnect", label: "Disconnect from “A very long collection name”", icon: "unlink", variant: "detach", truncate: true, disabled: false, stays_open: false, plain: false, detail: null },
    { kind: "item", id: "delete", label: "Delete", icon: "trash", variant: "destructive", truncate: false, disabled: false, stays_open: false, plain: false, detail: null },
  ],
};

function answers(answer: MenuAnswer | null = { kind: "done" }) {
  return vi.fn<MenuDispatch>(async () => answer);
}

function InDropdown({ spec, dispatch }: { spec: MenuSpec; dispatch: MenuDispatch }) {
  const [open, setOpen] = useState(true);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent widthRole={spec.role} className={menuSurfaceClass(spec.role)}>
        <MenuSpecView spec={spec} dispatch={dispatch} open={open} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function renderMenu(spec: MenuSpec, dispatch: MenuDispatch) {
  render(<InDropdown spec={spec} dispatch={dispatch} />);
}

/** The rows of the open root menu, a separator as a dash. */
function rows(): string[] {
  const menu = document.querySelector("[data-radix-menu-content]");
  return Array.from(menu?.querySelectorAll("[role='menuitem'], [role='separator']") ?? []).map((node) =>
    node.getAttribute("role") === "separator" ? "—" : (node.textContent ?? "").trim());
}

describe("a menu described as data", () => {
  it("draws every entry in its order, a separator between the groups", async () => {
    renderMenu(SPEC, answers());
    await screen.findByText("Source");
    expect(rows()).toEqual(["Connect", "Table", "—", "Source", "Disconnect from “A very long collection name”", "Delete"]);
    // What detaches and what deletes read so, and a long label is cut.
    expect(screen.getByText("Delete").closest("[role='menuitem']")?.getAttribute("data-variant")).toBe("destructive");
    const disconnect = screen.getByText("Disconnect from “A very long collection name”");
    expect(disconnect.className).toContain("truncate");
    expect(disconnect.closest("[role='menuitem']")?.getAttribute("data-variant")).toBe("detach");
  });

  it("sends the choice of an item as an action that names it", async () => {
    const dispatch = answers();
    renderMenu(SPEC, dispatch);
    fireEvent.click(await screen.findByText("Source"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch).toHaveBeenCalledWith({ kind: "run", id: "source" });
  });

  it("opens a submenu beside its row, with its own entries and their ids", async () => {
    const dispatch = answers();
    renderMenu(SPEC, dispatch);
    const table = (await screen.findByText("Table")).closest<HTMLElement>("[role='menuitem']");
    expect(table).not.toBeNull();
    fireEvent.keyDown(table as HTMLElement, { key: "ArrowRight" });
    fireEvent.click(await screen.findByText("Delete Table"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ kind: "run", id: "table:delete" }));
  });

  it("draws a list under a search field in a submenu of the search role, and sends its changes as the widget's", async () => {
    const dispatch = answers({ kind: "membership", made: true });
    renderMenu(SPEC, dispatch);
    const connect = (await screen.findByText("Connect")).closest<HTMLElement>("[role='menuitem']");
    fireEvent.keyDown(connect as HTMLElement, { key: "ArrowRight" });
    const field = await screen.findByPlaceholderText("Search collections...");
    const surface = field.closest("[data-floating-menu]");
    expect(surface?.getAttribute("data-floating-menu")).toBe("search");
    expect(surface?.className).toContain("p-0");
    // Web is the card's: the press disconnects it. Read is not: it connects.
    fireEvent.click(screen.getByText("Web"));
    fireEvent.click(screen.getByText("Read"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { kind: "widget", id: "connect.picker", action: { kind: "toggle_collection", collection: "Web", connected: true } },
      { kind: "widget", id: "connect.picker", action: { kind: "toggle_collection", collection: "Read", connected: false } },
    ]);
  });
});

describe("a list under a search field as the whole menu", () => {
  it("fills its surface, asks about a typed name once, and creates it", async () => {
    const dispatch = vi.fn<MenuDispatch>(async (action) =>
      action.kind === "widget" && action.action.kind === "check_collection_name" ? { kind: "name_refusal", reason: null } : { kind: "done" });
    render(<InDropdown spec={PICKER} dispatch={dispatch} />);
    const field = await screen.findByPlaceholderText("Search collections...");
    expect(field.closest("[data-floating-menu]")?.getAttribute("data-floating-menu")).toBe("search");
    fireEvent.change(field, { target: { value: "New" } });
    fireEvent.click(await screen.findByText(/Create/));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ kind: "widget", id: "connect.picker", action: { kind: "create_collection", name: "New" } }));
    // The name was asked about once: the picker's check keeps its identity
    // from one drawing of the menu to the next.
    const checks = dispatch.mock.calls.filter(([action]) => action.kind === "widget" && action.action.kind === "check_collection_name");
    expect(checks).toEqual([[{ kind: "widget", id: "connect.picker", action: { kind: "check_collection_name", name: "New" } }]]);
  });

  it("shows why a typed name is refused, as the page the menu came from says", async () => {
    const dispatch = vi.fn<MenuDispatch>(async () => ({ kind: "name_refusal", reason: "A collection name cannot contain “/”." }));
    render(<InDropdown spec={PICKER} dispatch={dispatch} />);
    fireEvent.change(await screen.findByPlaceholderText("Search collections..."), { target: { value: "a/b" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("A collection name cannot contain “/”.");
    expect(screen.queryByText(/Create/)).toBeNull();
  });

  it("takes a change back when the menu closed before its answer came", async () => {
    // No answer: the choice was not made (the menu panel closed first).
    render(<InDropdown spec={PICKER} dispatch={answers(null)} />);
    const row = (await screen.findByText("Read")).closest("[data-collection-picker-row]");
    fireEvent.click(screen.getByText("Read"));
    await waitFor(() => expect(row?.textContent).not.toContain("Connected"));
  });
});

describe("a selection's menu", () => {
  const GROUP: MenuSpec = {
    role: "action",
    entries: [
      { kind: "caption", text: "2 elements" },
      { kind: "separator" },
      {
        kind: "submenu",
        id: "connect",
        label: "Connect",
        icon: "plus",
        plain: false,
        content: {
          role: "search",
          entries: [{
            kind: "widget",
            id: "connect.picker",
            widget: {
              kind: "batch_collection_picker",
              cards: ["one", "two"],
              in_all: ["Web"],
              collections: [{ name: "Web", count: 3 }, { name: "Read", count: 1 }],
            },
          }],
        },
      },
      { kind: "item", id: "delete", label: "Delete", icon: "trash", variant: "destructive", truncate: false, disabled: false, stays_open: false, plain: false, detail: null },
      { kind: "separator" },
      { kind: "note", text: "The collections could not be read.", tone: "error" },
    ],
  };

  it("says what it acts on in a caption and why it could not read in a note, neither a row to choose", async () => {
    render(<InDropdown spec={GROUP} dispatch={answers()} />);
    const caption = await screen.findByText("2 elements");
    expect(caption.hasAttribute("data-menu-caption")).toBe(true);
    expect(caption.getAttribute("role")).toBeNull();
    const note = screen.getByText("The collections could not be read.");
    expect(note.getAttribute("data-menu-note")).toBe("error");
    expect(note.className).toContain("text-destructive");
    expect(rows()).toEqual(["—", "Connect", "Delete", "—"]);
  });

  it("ticks what every selected card is in, and connects or disconnects them all", async () => {
    const dispatch = answers({ kind: "membership", made: true });
    render(<InDropdown spec={GROUP} dispatch={dispatch} />);
    const connect = (await screen.findByText("Connect")).closest<HTMLElement>("[role='menuitem']");
    fireEvent.keyDown(connect as HTMLElement, { key: "ArrowRight" });
    await screen.findByPlaceholderText("Search collections...");
    // Web is every card's: the press disconnects them all. Read is not: the
    // press connects them all.
    fireEvent.click(screen.getByText("Web"));
    fireEvent.click(screen.getByText("Read"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { kind: "widget", id: "connect.picker", action: { kind: "connect_cards", collection: "Web", connected: false } },
      { kind: "widget", id: "connect.picker", action: { kind: "connect_cards", collection: "Read", connected: true } },
    ]);
  });
});

describe("an open card's menus", () => {
  const TAGS = [{ tag: "Web", count: 3 }, { tag: "Read", count: 1 }];

  it("dims a command that cannot be chosen now, and sends no choice of it", async () => {
    const dispatch = answers();
    renderMenu(sourceVideoSpec({ downloading: true }), dispatch);
    const download = (await screen.findByText("Download Media")).closest<HTMLElement>("[role='menuitem']");
    expect(download?.hasAttribute("data-disabled")).toBe(true);
    expect(download?.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(download as HTMLElement);
    fireEvent.click(screen.getByText("Copy Link"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch).toHaveBeenCalledWith({ kind: "run", id: "copy-link" });
  });

  it("keeps the menu open on a command whose result shows in it, sent at once", async () => {
    const dispatch = answers();
    renderMenu(mediaAssetSpec({ tags: TAGS, currentTag: null, copyError: null }), dispatch);
    fireEvent.click(await screen.findByText("Copy Media"));
    // No blink before it: the choice has left already.
    expect(dispatch).toHaveBeenCalledWith({ kind: "run", id: "copy-media" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.getByText("Copy Media")).toBeTruthy();
    expect(screen.getByText("Reveal in Finder")).toBeTruthy();
  });

  it("lists where a new card goes, the feed's collection first, and creates the card on a choice", async () => {
    const dispatch = answers();
    renderMenu(newCardSpec(TAGS, "Read"), dispatch);
    await screen.findByPlaceholderText("Search collections...");
    expect(screen.getAllByRole("menuitem").map((row) => row.textContent)).toEqual(["Everything", "Read", "Web"]);
    fireEvent.click(screen.getByText("Everything"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({
      kind: "widget",
      id: "create.picker",
      action: { kind: "create_card", collection: null, new_collection: false },
    }));
    fireEvent.click(screen.getByText("Web"));
    await waitFor(() => expect(dispatch).toHaveBeenLastCalledWith({
      kind: "widget",
      id: "create.picker",
      action: { kind: "create_card", collection: "Web", new_collection: false },
    }));
    // The menu stays: the page the menu came from decides when it goes.
    expect(screen.getByPlaceholderText("Search collections...")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers to create a collection no row matches, and says why a card could not be made", async () => {
    const dispatch = answers({ kind: "failed", message: "The note changed. Select the text again." });
    renderMenu(newCardSpec(TAGS, null), dispatch);
    const search = await screen.findByPlaceholderText("Search collections...");
    fireEvent.change(search, { target: { value: "Later" } });
    fireEvent.click(await screen.findByText("Create “Later”"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({
      kind: "widget",
      id: "create.picker",
      action: { kind: "create_card", collection: "Later", new_collection: true },
    }));
    expect((await screen.findByRole("alert")).textContent).toBe("The note changed. Select the text again.");
    // The query stays for another try.
    expect((search as HTMLInputElement).value).toBe("Later");
  });
});

describe("the chrome's menus", () => {
  const PANEL: MenuSpec = displaySpec([
    displayChoice("sort", "Sort", "newest", [{ value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }]),
    [
      { kind: "caption", text: "Links" },
      { kind: "checkbox", id: "links.wikilinks", label: "Wikilinks", checked: true },
      { kind: "checkbox", id: "links.related", label: "Related notes", checked: false },
    ],
  ]);

  function captionOf(group: Element): string | null {
    return document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent ?? null;
  }

  it("draws a choice as a group named by its caption, the chosen value ticked in the leading slot", async () => {
    renderMenu(PANEL, answers());
    const newest = await screen.findByRole("menuitemradio", { name: "Newest first" });
    const oldest = screen.getByRole("menuitemradio", { name: "Oldest first" });
    expect([newest.getAttribute("aria-checked"), oldest.getAttribute("aria-checked")]).toEqual(["true", "false"]);
    expect(newest.querySelector("[data-card-menu-icon-slot] svg")).not.toBeNull();
    expect(oldest.querySelector("[data-card-menu-icon-slot] svg")).toBeNull();
    const group = newest.closest("[role='group']") as HTMLElement;
    expect(captionOf(group)).toBe("Sort");
    expect(Array.from(group.querySelectorAll("[role='menuitemradio']"))).toEqual([newest, oldest]);
  });

  it("draws switches that stand together as one group named by their caption", async () => {
    renderMenu(PANEL, answers());
    const wikilinks = await screen.findByRole("menuitemcheckbox", { name: "Wikilinks" });
    const related = screen.getByRole("menuitemcheckbox", { name: "Related notes" });
    expect([wikilinks.getAttribute("aria-checked"), related.getAttribute("aria-checked")]).toEqual(["true", "false"]);
    const group = wikilinks.closest("[role='group']") as HTMLElement;
    expect(captionOf(group)).toBe("Links");
    expect(Array.from(group.querySelectorAll("[role='menuitemcheckbox']"))).toEqual([wikilinks, related]);
    expect(screen.getAllByRole("group")).toHaveLength(2);
  });

  it("sends a choice and a switch as actions that name them, and keeps the menu open", async () => {
    const dispatch = answers();
    renderMenu(PANEL, dispatch);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Oldest first" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Wikilinks" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Related notes" }));
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { kind: "choose", id: "sort", value: "oldest" },
      { kind: "check", id: "links.wikilinks", checked: false },
      { kind: "check", id: "links.related", checked: true },
    ]);
    // The description says what is chosen: nothing moves until a new one comes.
    expect(screen.getByRole("menuitemradio", { name: "Newest first" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("closes on a choice where the menu is there for the one choice", async () => {
    const dispatch = answers();
    const select: MenuSpec = {
      role: "action",
      entries: [{ kind: "radio", id: "space", value: "mine", options: [{ value: "mine", label: "Mine" }, { value: "archive", label: "Archive" }], closes: true }],
    };
    renderMenu(select, dispatch);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Archive" }));
    expect(dispatch).toHaveBeenCalledWith({ kind: "choose", id: "space", value: "archive" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("draws a command's second line under its label, and a submenu's row with no slot when plain", async () => {
    const spec: MenuSpec = {
      role: "action",
      entries: [
        menuItem("remove", "Remove Space", { icon: "unlink", variant: "detach", detail: "Files stay on disk" }),
        { kind: "submenu", id: "menus", label: "Menus", icon: null, plain: true, content: { role: "action", entries: [menuItem("web", "Web", { plain: true })] } },
      ],
    };
    renderMenu(spec, answers());
    const remove = await screen.findByRole("menuitem", { name: /Remove Space/ });
    expect(remove.querySelector("[data-card-menu-icon-slot] svg")).not.toBeNull();
    const detail = remove.querySelector("[data-menu-detail]");
    expect(detail?.textContent).toBe("Files stay on disk");
    expect(detail?.className).toContain("text-muted-foreground");
    expect(remove.textContent).toBe("Remove SpaceFiles stay on disk");
    const menus = screen.getByText("Menus").closest<HTMLElement>("[role='menuitem']");
    expect(menus?.querySelector("[data-card-menu-icon-slot]")).toBeNull();
    expect(menus?.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("draws a row of a menu with no column of icons with no leading slot", async () => {
    const sections: MenuSpec = {
      role: "action",
      entries: [menuItem("appearance", "Appearance", { plain: true }), menuItem("reveal", "Reveal in Finder")],
    };
    renderMenu(sections, answers());
    const plain = await screen.findByRole("menuitem", { name: "Appearance" });
    expect(plain.querySelector("[data-card-menu-icon-slot]")).toBeNull();
    expect(plain.textContent).toBe("Appearance");
    expect(screen.getByRole("menuitem", { name: "Reveal in Finder" }).firstElementChild?.hasAttribute("data-card-menu-icon-slot")).toBe(true);
  });
});
