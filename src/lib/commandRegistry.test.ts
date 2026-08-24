import { describe, expect, it } from "vitest";
import { COMMANDS, commandById, commandsForContext } from "./commandRegistry";

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("command registry", () => {
  it("keeps ids unique", () => {
    const ids = COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps combos unique within each context plus global", () => {
    // Contexts are mutually exclusive surfaces, so the same combo may mean
    // different things in feed and element — but inside one surface, and
    // against the always-active global set, a combo must mean one thing.
    for (const context of ["feed", "element", "selection"] as const) {
      const active = [
        ...commandsForContext("global"),
        ...commandsForContext(context),
      ].filter((command) => command.matches);
      const combos = active.map((command) => command.combo);
      const duplicates = combos.filter((combo, index) => combos.indexOf(combo) !== index);
      // ⇥ in an element intentionally shadows the global view toggle: an open
      // element captures Tab for its own mode switch.
      // ↵/esc/⌘K pairs across feed and selection never coexist with global
      // duplicates.
      expect(duplicates.filter((combo) => combo !== "⇥")).toEqual([]);
    }
  });

  it("matches its own chord exactly, not a superset", () => {
    const newCollection = commandById("new-collection");
    expect(newCollection.matches!(keydown({ key: "N", metaKey: true, shiftKey: true }))).toBe(true);
    expect(newCollection.matches!(keydown({ key: "N", metaKey: true }))).toBe(false);
    expect(newCollection.matches!(keydown({ key: "N", metaKey: true, shiftKey: true, altKey: true }))).toBe(false);
  });

  it("keeps Tab bare: a modified Tab is not the view toggle", () => {
    const toggleView = commandById("toggle-view");
    expect(toggleView.matches!(keydown({ key: "Tab" }))).toBe(true);
    expect(toggleView.matches!(keydown({ key: "Tab", shiftKey: true }))).toBe(false);
    expect(toggleView.matches!(keydown({ key: "Tab", metaKey: true }))).toBe(false);
  });

  it("separates the find pair by shift", () => {
    const elements = commandById("find-elements");
    const collections = commandById("find-collections");
    const plain = keydown({ key: "f", metaKey: true });
    const shifted = keydown({ key: "F", metaKey: true, shiftKey: true });
    expect(elements.matches!(plain)).toBe(true);
    expect(elements.matches!(shifted)).toBe(false);
    expect(collections.matches!(shifted)).toBe(true);
    expect(collections.matches!(plain)).toBe(false);
  });

  it("throws on an unknown id instead of returning undefined", () => {
    expect(() => commandById("no-such-command")).toThrow("no-such-command");
  });
});
