import { describe, expect, it } from "vitest";
import { collectionRowMenuItemId, collectionRowSpec } from "./collectionRowMenu";
import { menuActionCloses, menuSpecSize } from "./menuSpec";

describe("the menu of a collection's row in the sidebar", () => {
  it("offers Rename, Reveal in Finder and Delete, each with its icon", () => {
    const spec = collectionRowSpec({ pageFound: true });
    expect(spec.role).toBe("action");
    expect(spec.entries).toMatchObject([
      { kind: "item", id: "rename", label: "Rename", icon: "pencil", variant: "default", disabled: false },
      { kind: "item", id: "reveal", label: "Reveal in Finder", icon: "folder", variant: "default", disabled: false },
      { kind: "item", id: "delete", label: "Delete", icon: "trash", variant: "destructive", disabled: false },
    ]);
    expect(menuSpecSize(spec).size).toEqual({ width: 240, height: 10 + 3 * 32 });
    expect(spec.entries.every((entry) => entry.kind === "item" && menuActionCloses(spec, { kind: "run", id: entry.id }))).toBe(true);
  });

  it("does not offer Reveal in Finder until the collection's page is found, and keeps its size meanwhile", () => {
    const waiting = collectionRowSpec({ pageFound: false });
    expect(waiting.entries.map((entry) => entry.kind === "item" && entry.disabled)).toEqual([false, true, false]);
    expect(menuSpecSize(waiting)).toEqual(menuSpecSize(collectionRowSpec({ pageFound: true })));
  });

  it("tells its items by their ids", () => {
    expect(collectionRowMenuItemId({ kind: "run", id: "reveal" })).toBe("reveal");
    expect(collectionRowMenuItemId({ kind: "run", id: "merge" })).toBeNull();
    expect(collectionRowMenuItemId({ kind: "choose", id: "rename", value: "rename" })).toBeNull();
  });
});
