import { describe, expect, it } from "vitest";
import { commandById } from "@/lib/commandRegistry";
import { adjacentTabDirection } from "@/lib/adjacentTab";
import { focusAfterClose, tabKeyAction } from "./tabKeyboard";

describe("tab strip keys (В49)", () => {
  it("moves focus with the arrows, round the ends", () => {
    expect(tabKeyAction("ArrowRight", 1, 4)).toEqual({ kind: "focus", index: 2 });
    expect(tabKeyAction("ArrowRight", 3, 4)).toEqual({ kind: "focus", index: 0 });
    expect(tabKeyAction("ArrowLeft", 0, 4)).toEqual({ kind: "focus", index: 3 });
  });

  it("jumps to the ends with Home and End", () => {
    expect(tabKeyAction("Home", 2, 4)).toEqual({ kind: "focus", index: 0 });
    expect(tabKeyAction("End", 0, 4)).toEqual({ kind: "focus", index: 3 });
  });

  it("shows the tab with Enter and Space", () => {
    expect(tabKeyAction("Enter", 1, 4)).toEqual({ kind: "activate" });
    expect(tabKeyAction(" ", 1, 4)).toEqual({ kind: "activate" });
  });

  it("closes the tab with Delete and Backspace", () => {
    expect(tabKeyAction("Delete", 1, 4)).toEqual({ kind: "close" });
    expect(tabKeyAction("Backspace", 1, 4)).toEqual({ kind: "close" });
  });

  it("leaves other keys alone", () => {
    expect(tabKeyAction("a", 1, 4)).toBeNull();
    expect(tabKeyAction("Tab", 1, 4)).toBeNull();
    expect(tabKeyAction("ArrowRight", 0, 0)).toBeNull();
  });

  it("hands focus to the right neighbour of a closed tab, else the left", () => {
    expect(focusAfterClose(1, 4)).toBe(2);
    expect(focusAfterClose(3, 4)).toBe(2);
    expect(focusAfterClose(0, 1)).toBeNull();
  });
});

describe("⌃Tab and ⌃⇧Tab (В55, В57)", () => {
  const press = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

  it("goes forward with ⌃Tab and back with ⌃⇧Tab", () => {
    expect(adjacentTabDirection(press({ key: "Tab", ctrlKey: true }))).toBe("forward");
    expect(adjacentTabDirection(press({ key: "Tab", ctrlKey: true, shiftKey: true }))).toBe("back");
  });

  it("ignores Tab without Control, and with ⌘ or ⌥", () => {
    expect(adjacentTabDirection(press({ key: "Tab" }))).toBeNull();
    expect(adjacentTabDirection(press({ key: "Tab", ctrlKey: true, metaKey: true }))).toBeNull();
    expect(adjacentTabDirection(press({ key: "Tab", ctrlKey: true, altKey: true }))).toBeNull();
    expect(adjacentTabDirection(press({ key: "a", ctrlKey: true }))).toBeNull();
  });

  it("leaves ⇧⌘] and ⇧⌘[ to the native menu", () => {
    expect(adjacentTabDirection(press({ key: "]", code: "BracketRight", metaKey: true, shiftKey: true }))).toBeNull();
    expect(adjacentTabDirection(press({ key: "[", code: "BracketLeft", metaKey: true, shiftKey: true }))).toBeNull();
  });

  it("answers the chords the command registry lists for the tab commands", () => {
    expect(commandById("next-tab").alternates).toEqual([{ key: "Tab", ctrl: true }]);
    expect(commandById("previous-tab").alternates).toEqual([{ key: "Tab", ctrl: true, shift: true }]);
  });
});
