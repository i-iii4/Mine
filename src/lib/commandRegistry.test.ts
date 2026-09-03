import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_COMMANDS,
  allCommands,
  commandById,
  commandsForContext,
  setCommandOverrides,
} from "./commandRegistry";

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("command registry", () => {
  beforeEach(() => setCommandOverrides({}));

  it("keeps ids unique", () => {
    const ids = DEFAULT_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps combos unique within each context plus global", () => {
    // Contexts are mutually exclusive surfaces, so the same combo may mean
    // different things in feed and element — but inside one surface, and
    // against the always-active global set, a combo must mean one thing.
    for (const context of ["feed", "element", "selection"] as const) {
      const active = [...commandsForContext("global"), ...commandsForContext(context)]
        .filter((command) => command.binding);
      const combos = active.map((command) => command.combo);
      const duplicates = combos.filter((combo, index) => combos.indexOf(combo) !== index);
      // ⇥ in an element intentionally shadows the global view toggle: an open
      // element captures Tab for its own mode switch.
      expect(duplicates.filter((combo) => combo !== "⇥")).toEqual([]);
    }
  });

  it("derives the label and the match from one record", () => {
    const newCollection = commandById("new-collection");
    expect(newCollection.combo).toBe("⇧⌘N");
    expect(newCollection.matches!(keydown({ code: "KeyN", metaKey: true, shiftKey: true }))).toBe(true);
    expect(newCollection.matches!(keydown({ code: "KeyN", metaKey: true }))).toBe(false);
  });

  it("keeps Tab bare: a modified Tab is not the view toggle", () => {
    const toggleView = commandById("toggle-view");
    expect(toggleView.matches!(keydown({ key: "Tab" }))).toBe(true);
    expect(toggleView.matches!(keydown({ key: "Tab", shiftKey: true }))).toBe(false);
  });

  it("exposes the macOS Delete key as the fixed selection delete command", () => {
    const deleteSelection = commandById("delete-selection");
    expect(deleteSelection.combo).toBe("⌫");
    expect(deleteSelection.fixed).toBe("structural");
    expect(deleteSelection.matches!(keydown({ key: "Backspace" }))).toBe(true);
    expect(deleteSelection.matches!(keydown({ key: "Backspace", metaKey: true }))).toBe(false);
  });

  it("separates the find pair by shift", () => {
    const elements = commandById("find-elements");
    const collections = commandById("find-collections");
    expect(elements.matches!(keydown({ code: "KeyF", metaKey: true }))).toBe(true);
    expect(elements.matches!(keydown({ code: "KeyF", metaKey: true, shiftKey: true }))).toBe(false);
    expect(collections.matches!(keydown({ code: "KeyF", metaKey: true, shiftKey: true }))).toBe(true);
  });

  it("matches a letter through its physical key, not the printed one", () => {
    // With ⌥ held, or on a non-Latin layout, `key` is not the letter on the cap.
    const menu = commandById("element-menu");
    expect(menu.matches!(keydown({ code: "KeyK", key: "л", metaKey: true }))).toBe(true);
  });

  it("applies an override and reports the command as rebound", () => {
    expect(commandById("find-elements").rebound).toBe(false);

    setCommandOverrides({ "find-elements": { key: "e", meta: true, shift: true } });
    const rebound = commandById("find-elements");

    expect(rebound.combo).toBe("⇧⌘E");
    expect(rebound.rebound).toBe(true);
    expect(rebound.matches!(keydown({ code: "KeyE", metaKey: true, shiftKey: true }))).toBe(true);
    expect(rebound.matches!(keydown({ code: "KeyF", metaKey: true }))).toBe(false);
  });

  it("refuses to rebind what the interface is built on", () => {
    // Structural keys and the system's own ⌘, ignore overrides outright: an
    // override that silently did nothing would be worse than none.
    setCommandOverrides({
      "toggle-view": { key: "j", meta: true },
      settings: { key: "j", meta: true },
    });

    expect(commandById("toggle-view").combo).toBe("⇥");
    expect(commandById("settings").combo).toBe("⌘,");
    expect(commandById("toggle-view").rebound).toBe(false);
  });

  it("marks every command that cannot be rebound with a reason", () => {
    for (const command of allCommands()) {
      if (command.fixed) {
        expect(["structural", "system"]).toContain(command.fixed);
      } else {
        expect(command.binding, `${command.id} is bindable but has no binding`).toBeDefined();
      }
    }
  });

  it("shows a gesture as a hint and never matches it", () => {
    const navigate = commandById("navigate");
    expect(navigate.combo).toBe("↕ ↔");
    expect(navigate.matches).toBeUndefined();
  });

  it("throws on an unknown id instead of returning undefined", () => {
    expect(() => commandById("no-such-command")).toThrow("no-such-command");
  });
});
