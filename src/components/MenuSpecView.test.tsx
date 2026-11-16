// The one view of a menu described as data (SPEC_MENU_WINDOW.md, МО16, МО23,
// МО27): the same entries in a dropdown's surface and in a context menu's,
// every choice an action that names its entry.

import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { MenuAnswer, MenuSpec } from "@/types";
import { CONTEXT_MENU_KIT, DROPDOWN_MENU_KIT, MenuSpecView, menuSurfaceClass, type MenuDispatch, type MenuKit } from "./MenuSpecView";

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
    { kind: "submenu", id: "connect", label: "Connect", icon: "plus", content: PICKER },
    {
      kind: "submenu",
      id: "table",
      label: "Table",
      icon: null,
      content: {
        role: "action",
        entries: [
          { kind: "item", id: "table:row", label: "Add Row", icon: null, variant: "default", truncate: false },
          { kind: "separator" },
          { kind: "item", id: "table:delete", label: "Delete Table", icon: null, variant: "destructive", truncate: false },
        ],
      },
    },
    { kind: "separator" },
    { kind: "item", id: "source", label: "Source", icon: "external", variant: "default", truncate: false },
    { kind: "item", id: "disconnect", label: "Disconnect from “A very long collection name”", icon: "unlink", variant: "detach", truncate: true },
    { kind: "item", id: "delete", label: "Delete", icon: "trash", variant: "destructive", truncate: false },
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
        <MenuSpecView spec={spec} dispatch={dispatch} open={open} kit={DROPDOWN_MENU_KIT} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function InContextMenu({ spec, dispatch }: { spec: MenuSpec; dispatch: MenuDispatch }) {
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger>Card</ContextMenuTrigger>
      <ContextMenuContent>
        <MenuSpecView spec={spec} dispatch={dispatch} open kit={CONTEXT_MENU_KIT} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function renderIn(kit: MenuKit, spec: MenuSpec, dispatch: MenuDispatch) {
  if (kit === CONTEXT_MENU_KIT) {
    render(<InContextMenu spec={spec} dispatch={dispatch} />);
    fireEvent.contextMenu(screen.getByText("Card"));
  } else {
    render(<InDropdown spec={spec} dispatch={dispatch} />);
  }
}

/** The rows of the open root menu, a separator as a dash. */
function rows(): string[] {
  const menu = document.querySelector("[data-radix-menu-content]");
  return Array.from(menu?.querySelectorAll("[role='menuitem'], [role='separator']") ?? []).map((node) =>
    node.getAttribute("role") === "separator" ? "—" : (node.textContent ?? "").trim());
}

describe.each([
  ["a dropdown's surface", DROPDOWN_MENU_KIT],
  ["a context menu's surface", CONTEXT_MENU_KIT],
])("a menu described as data in %s", (_name, kit) => {
  it("draws every entry in its order, a separator between the groups", async () => {
    renderIn(kit, SPEC, answers());
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
    renderIn(kit, SPEC, dispatch);
    fireEvent.click(await screen.findByText("Source"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch).toHaveBeenCalledWith({ kind: "run", id: "source" });
  });

  it("opens a submenu beside its row, with its own entries and their ids", async () => {
    const dispatch = answers();
    renderIn(kit, SPEC, dispatch);
    const table = (await screen.findByText("Table")).closest<HTMLElement>("[role='menuitem']");
    expect(table).not.toBeNull();
    fireEvent.keyDown(table as HTMLElement, { key: "ArrowRight" });
    fireEvent.click(await screen.findByText("Delete Table"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ kind: "run", id: "table:delete" }));
  });

  it("draws a list under a search field in a submenu of the search role, and sends its changes as the widget's", async () => {
    const dispatch = answers({ kind: "membership", made: true });
    renderIn(kit, SPEC, dispatch);
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
