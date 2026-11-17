import { describe, expect, it } from "vitest";
import {
  GROUP_MENU_CONNECT_ID,
  GROUP_MENU_PICKER_ID,
  groupConnectSpec,
  groupMenuItemId,
  groupPickerWidget,
  groupSelectionSpec,
  type GroupMenuPicker,
} from "./groupSelectionMenu";
import type { MenuSpec } from "@/types";

const TAGS = [{ tag: "Web", count: 3 }, { tag: "Read", count: 1 }, { tag: "Later", count: 0 }];
const PICKER: GroupMenuPicker = {
  cards: ["one", "two"],
  tags: TAGS,
  lookup: new Map([["one", ["Web", "Read"]], ["two", ["Web"]]]),
};

/** A menu's rows by what they are: an entry's id, or its kind without one. */
function rows(spec: MenuSpec): string[] {
  return spec.entries.map((entry) => ("id" in entry ? entry.id : entry.kind));
}

describe("groupSelectionSpec", () => {
  it("says how many elements it acts on, then offers what acts on them all", () => {
    const spec = groupSelectionSpec({ count: 2, inCollection: true, error: null, picker: PICKER });
    expect(spec.role).toBe("action");
    expect(rows(spec)).toEqual(["caption", "separator", "connect", "disconnect", "merge", "delete"]);
    expect(spec.entries[0]).toEqual({ kind: "caption", text: "2 elements" });
    expect(spec.entries.find((entry) => "id" in entry && entry.id === "disconnect")).toMatchObject({ icon: "unlink", variant: "detach" });
    expect(spec.entries.find((entry) => "id" in entry && entry.id === "delete")).toMatchObject({ icon: "trash", variant: "destructive" });
  });

  it("offers no Disconnect off a collection, and no Merge of one element", () => {
    expect(rows(groupSelectionSpec({ count: 2, inCollection: false, error: null, picker: PICKER }))).toEqual(
      ["caption", "separator", "connect", "merge", "delete"],
    );
    const one = groupSelectionSpec({ count: 1, inCollection: true, error: null, picker: { ...PICKER, cards: ["one"] } });
    expect(rows(one)).toEqual(["caption", "separator", "connect", "disconnect", "delete"]);
    expect(one.entries[0]).toEqual({ kind: "caption", text: "1 element" });
  });

  it("says under its commands why the selection's collections could not be read", () => {
    const spec = groupSelectionSpec({ count: 2, inCollection: false, error: "The index is busy.", picker: PICKER });
    expect(spec.entries.slice(-2)).toEqual([{ kind: "separator" }, { kind: "note", text: "The index is busy.", tone: "error" }]);
  });

  it("holds Connect as a submenu with the picker of the selection's collections", () => {
    const spec = groupSelectionSpec({ count: 2, inCollection: false, error: null, picker: PICKER });
    expect(spec.entries.find((entry) => "id" in entry && entry.id === GROUP_MENU_CONNECT_ID)).toEqual({
      kind: "submenu",
      id: GROUP_MENU_CONNECT_ID,
      label: "Connect",
      icon: "plus",
      plain: false,
      content: groupConnectSpec(PICKER),
    });
    // Connect alone, the commands row's button: the picker is the whole menu.
    expect(groupConnectSpec(PICKER)).toEqual({
      role: "search",
      entries: [{ kind: "widget", id: GROUP_MENU_PICKER_ID, widget: groupPickerWidget(PICKER) }],
    });
  });

  it("ticks a collection only when every selected card is in it", () => {
    expect(groupPickerWidget(PICKER)).toEqual({
      kind: "batch_collection_picker",
      cards: ["one", "two"],
      // Web is both cards'; Read is one card's alone.
      in_all: ["Web"],
      collections: [{ name: "Web", count: 3 }, { name: "Read", count: 1 }, { name: "Later", count: 0 }],
    });
    // A card whose collections are not read yet is in none: nothing is ticked.
    expect(groupPickerWidget({ ...PICKER, lookup: new Map([["one", ["Web"]]]) })).toMatchObject({ in_all: [] });
    expect(groupPickerWidget({ ...PICKER, cards: [] })).toMatchObject({ in_all: [] });
  });

  it("tells its items by their ids", () => {
    expect(groupMenuItemId("merge")).toBe("merge");
    expect(groupMenuItemId("connect")).toBeNull();
    expect(groupMenuItemId("rename")).toBeNull();
  });
});
