import { describe, expect, it } from "vitest";
import { menuActionCloses, menuSpecSize } from "./menuSpec";
import {
  MEDIA_MENU_CREATE_ID,
  NEW_CARD_PICKER_ID,
  mediaAssetSpec,
  mediaMenuItemId,
  newCardPickerWidget,
  newCardSpec,
  sourceVideoMenuItemId,
  sourceVideoSpec,
} from "./openCardMenus";
import type { MenuEntry, MenuSpec } from "@/types";

const TAGS = [{ tag: "Web", count: 3 }, { tag: "Read", count: 1 }];

/** A menu's rows by what they are: an entry's id, or its kind without one. */
function rows(spec: MenuSpec): string[] {
  return spec.entries.map((entry) => ("id" in entry ? entry.id : entry.kind));
}

function entry(spec: MenuSpec, id: string): MenuEntry | undefined {
  return spec.entries.find((candidate) => "id" in candidate && candidate.id === id);
}

describe("a new card's collection", () => {
  it("lists the space's collections in their own order and names the one the feed stands on", () => {
    expect(newCardPickerWidget(TAGS, "Read")).toEqual({ kind: "new_card_picker", collections: ["Web", "Read"], current: "Read" });
    expect(newCardPickerWidget([], null)).toEqual({ kind: "new_card_picker", collections: [], current: null });
  });

  it("is the whole menu of a selected text's Create Element: a list under a search field", () => {
    const spec = newCardSpec(TAGS, null);
    expect(spec).toEqual({
      role: "search",
      entries: [{ kind: "widget", id: NEW_CARD_PICKER_ID, widget: newCardPickerWidget(TAGS, null) }],
    });
    // The picker at its tallest, with no inset of the surface's.
    expect(menuSpecSize(spec).size).toEqual({ width: 300, height: 303 });
  });
});

describe("a media file's menu", () => {
  it("groups a new card of the file, the file where it is and the file itself", () => {
    const spec = mediaAssetSpec({ tags: TAGS, currentTag: "Web", copyError: null });
    expect(spec.role).toBe("action");
    expect(rows(spec)).toEqual(["create", "separator", "reveal", "copy-path", "copy-media", "separator", "rename", "remove", "delete"]);
    expect(entry(spec, MEDIA_MENU_CREATE_ID)).toEqual({
      kind: "submenu",
      id: MEDIA_MENU_CREATE_ID,
      label: "Create Element",
      icon: "plus",
      plain: false,
      content: newCardSpec(TAGS, "Web"),
    });
    expect(entry(spec, "rename")).toMatchObject({ label: "Rename Media...", icon: null, variant: "default" });
    expect(entry(spec, "remove")).toMatchObject({ label: "Remove from Element", icon: "unlink", variant: "detach" });
    expect(entry(spec, "delete")).toMatchObject({ label: "Delete Media", icon: "trash", variant: "destructive" });
  });

  it("keeps the menu open on Copy Media alone, and says under its row why the copy failed", () => {
    const plain = mediaAssetSpec({ tags: TAGS, currentTag: null, copyError: null });
    expect(["reveal", "copy-path", "copy-media", "rename", "remove", "delete"].filter((id) => !menuActionCloses(plain, { kind: "run", id }))).toEqual(["copy-media"]);
    const failed = mediaAssetSpec({ tags: TAGS, currentTag: null, copyError: "Media file was not found." });
    expect(rows(failed)).toEqual(["create", "separator", "reveal", "copy-path", "copy-media", "note", "separator", "rename", "remove", "delete"]);
    expect(failed.entries[5]).toEqual({ kind: "note", text: "Media file was not found.", tone: "error" });
    // The note is one line of text more.
    expect(menuSpecSize(failed).size.height).toBe(menuSpecSize(plain).size.height + 28);
    // Create Element opens off the first row, the picker at its tallest.
    expect(menuSpecSize(plain)).toEqual({
      size: { width: 240, height: 10 + 7 * 32 + 2 * 9 },
      submenus: [{ row_top: 5, width: 300, height: 303 }],
    });
  });

  it("tells its items by their ids", () => {
    expect(mediaMenuItemId("copy-media")).toBe("copy-media");
    expect(mediaMenuItemId(MEDIA_MENU_CREATE_ID)).toBeNull();
    expect(mediaMenuItemId("download")).toBeNull();
  });
});

describe("an embedded video's menu", () => {
  it("holds only the actions a link supports, the deletion apart", () => {
    const spec = sourceVideoSpec({ downloading: false });
    expect(rows(spec)).toEqual(["open-original", "copy-link", "download", "separator", "delete-embed"]);
    expect(entry(spec, "download")).toMatchObject({ label: "Download Media", disabled: false, stays_open: false });
    expect(entry(spec, "delete-embed")).toMatchObject({ label: "Delete Embed", icon: "trash", variant: "destructive" });
    expect(menuSpecSize(spec).size).toEqual({ width: 240, height: 10 + 4 * 32 + 9 });
  });

  it("does not offer Download Media while a download runs, and offers the rest", () => {
    const spec = sourceVideoSpec({ downloading: true });
    expect(spec.entries.filter((candidate) => candidate.kind === "item" && candidate.disabled).map((candidate) => ("id" in candidate ? candidate.id : ""))).toEqual(["download"]);
    // The same rows either way: the menu keeps its size while it is open.
    expect(menuSpecSize(spec)).toEqual(menuSpecSize(sourceVideoSpec({ downloading: false })));
  });

  it("tells its items by their ids", () => {
    expect(sourceVideoMenuItemId("delete-embed")).toBe("delete-embed");
    expect(sourceVideoMenuItemId("delete")).toBeNull();
  });
});
