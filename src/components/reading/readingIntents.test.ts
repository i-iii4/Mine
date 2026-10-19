import { actOnReadingElement, carryOutReadingIntent, clickEvent } from "./readingIntents";

describe("the reading mode carries intents out (SPEC_EDITING.md, Л11.1)", () => {
  it("does what the element lends and leaves the event its default otherwise", () => {
    const openNote = vi.fn();
    expect(actOnReadingElement({ kind: "link", to: { kind: "note", target: "Пример" } }, "click", { openNote })).toBe(true);
    expect(openNote).toHaveBeenCalledWith("Пример");
    // An address outside the note is followed by the link itself.
    expect(actOnReadingElement({ kind: "link", to: { kind: "external", href: "https://example.com" } }, "click", { openNote })).toBe(false);
    const toggleTask = vi.fn();
    expect(actOnReadingElement({ kind: "task" }, "click", { toggleTask })).toBe(true);
    expect(toggleTask).toHaveBeenCalledTimes(1);
  });

  it("refuses what only the editor has", () => {
    for (const kind of ["PlaceCaret", "SelectBlock", "RevealBlock", "EnterTableCell", "Nothing"] as const) {
      expect(carryOutReadingIntent({ kind }, {})).toBe(false);
    }
    expect(actOnReadingElement({ kind: "code" }, "click", {})).toBe(false);
  });

  it("reads ⌘ or Ctrl with a click as a command click", () => {
    expect(clickEvent({ metaKey: true, ctrlKey: false })).toBe("command-click");
    expect(clickEvent({ metaKey: false, ctrlKey: true })).toBe("command-click");
    expect(clickEvent({ metaKey: false, ctrlKey: false })).toBe("click");
  });
});
