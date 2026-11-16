import { describe, expect, it, vi } from "vitest";
import {
  CARD_MENU_CONNECT_ID,
  CARD_MENU_PICKER_ID,
  CARD_MENU_TABLE_ID,
  cardConnectSpec,
  cardMenuItemId,
  cardMenuSpec,
  cardMenuTableCommand,
  runCardMenuItem,
  type CardMenuPicker,
} from "./cardMenuEntries";
import type { MenuEntry, MenuSpec } from "@/types";

const PICKER: CardMenuPicker = { card: "card", selected: ["Web"], tags: [{ tag: "Web", count: 3 }, { tag: "Read", count: 1 }], currentTag: "Web" };

/** The ids of a menu's rows, a separator as its kind. */
function rows(spec: MenuSpec): string[] {
  return spec.entries.map((entry) => (entry.kind === "separator" ? "separator" : entry.id));
}

function entry(spec: MenuSpec, id: string): MenuEntry | undefined {
  return spec.entries.find((candidate) => candidate.kind !== "separator" && candidate.id === id);
}

describe("cardMenuSpec", () => {
  it("groups the card's collections, its link, its file and the card itself", () => {
    const spec = cardMenuSpec({ hasUrl: true, disconnectFrom: "Web", tableCommands: [], picker: PICKER });
    expect(spec.role).toBe("action");
    expect(rows(spec)).toEqual([
      "connect",
      "separator",
      "source",
      "copy-link",
      "separator",
      "reveal",
      "copy-path",
      "separator",
      "rename",
      "disconnect",
      "delete",
    ]);
  });

  it("has no link group without a link, no Disconnect off a collection, Table only with a table", () => {
    const spec = cardMenuSpec({ hasUrl: false, disconnectFrom: null, tableCommands: [], picker: PICKER });
    expect(rows(spec)).toEqual(["connect", "separator", "reveal", "copy-path", "separator", "rename", "delete"]);
    const withTable = cardMenuSpec({
      hasUrl: false,
      disconnectFrom: null,
      tableCommands: [
        { id: "row-above", label: "Add Row Above", destructive: false, separatorBefore: false },
        { id: "delete-table", label: "Delete Table", destructive: true, separatorBefore: true },
      ],
      picker: PICKER,
    });
    expect(rows(withTable)[1]).toBe(CARD_MENU_TABLE_ID);
    const table = entry(withTable, CARD_MENU_TABLE_ID);
    expect(table).toMatchObject({ kind: "submenu", label: "Table", content: { role: "action" } });
    // A command's own id inside the table's, its separator before it.
    expect(table?.kind === "submenu" && table.content.entries).toEqual([
      { kind: "item", id: "table:row-above", label: "Add Row Above", icon: null, variant: "default", truncate: false },
      { kind: "separator" },
      { kind: "item", id: "table:delete-table", label: "Delete Table", icon: null, variant: "destructive", truncate: false },
    ]);
  });

  it("names the collection Disconnect leaves, and marks what detaches and what deletes", () => {
    const spec = cardMenuSpec({ hasUrl: true, disconnectFrom: "Web", tableCommands: [], picker: PICKER });
    expect(entry(spec, "disconnect")).toMatchObject({ label: "Disconnect from “Web”", icon: "unlink", variant: "detach", truncate: true });
    expect(entry(spec, "delete")).toMatchObject({ icon: "trash", variant: "destructive" });
    expect(entry(spec, "source")).toMatchObject({ icon: "external", variant: "default" });
  });

  it("holds Connect as a submenu with the picker of the card's collections", () => {
    const spec = cardMenuSpec({ hasUrl: false, disconnectFrom: null, tableCommands: [], picker: PICKER });
    expect(entry(spec, CARD_MENU_CONNECT_ID)).toEqual({
      kind: "submenu",
      id: CARD_MENU_CONNECT_ID,
      label: "Connect",
      icon: "plus",
      content: cardConnectSpec(PICKER),
    });
    // Connect alone, the card's plus: the picker is the whole menu, a list
    // under a search field.
    expect(cardConnectSpec(PICKER)).toEqual({
      role: "search",
      entries: [{
        kind: "widget",
        id: CARD_MENU_PICKER_ID,
        widget: {
          kind: "collection_picker",
          card: "card",
          selected: ["Web"],
          collections: [{ name: "Web", count: 3 }, { name: "Read", count: 1 }],
          current: "Web",
        },
      }],
    });
  });

  it("gives every entry an id of its own, as the backend requires of a menu", () => {
    const spec = cardMenuSpec({
      hasUrl: true,
      disconnectFrom: "Web",
      tableCommands: [{ id: "delete", label: "Delete Table", destructive: true, separatorBefore: false }],
      picker: PICKER,
    });
    const ids: string[] = [];
    const collect = (entries: readonly MenuEntry[]) => {
      for (const candidate of entries) {
        if (candidate.kind === "separator") continue;
        ids.push(candidate.id);
        if (candidate.kind === "submenu") collect(candidate.content.entries);
      }
    };
    collect(spec.entries);
    // A table command called `delete` is not the card's Delete.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("table:delete");
  });

  it("tells an item of the card from a table's command by its id", () => {
    expect(cardMenuItemId("copy-path")).toBe("copy-path");
    expect(cardMenuItemId("table:row-above")).toBeNull();
    expect(cardMenuItemId("format-disk")).toBeNull();
    expect(cardMenuTableCommand("table:row-above")).toBe("row-above");
    expect(cardMenuTableCommand("delete")).toBeNull();
  });

  it("runs an item with the handlers of the tab", () => {
    const onToggleTag = vi.fn();
    const onRequestRename = vi.fn();
    const onRequestDelete = vi.fn();
    const context = {
      block: { slug: "card" },
      url: null,
      filePath: "/space/card.md",
      currentTag: "Web",
      onToggleTag,
      onRequestRename,
      onRequestDelete,
    };
    runCardMenuItem("disconnect", context);
    runCardMenuItem("rename", context);
    runCardMenuItem("delete", context);
    expect(onToggleTag).toHaveBeenCalledWith("card", "Web", true);
    expect(onRequestRename).toHaveBeenCalledWith({ slug: "card" });
    expect(onRequestDelete).toHaveBeenCalledWith("card");
  });
});
