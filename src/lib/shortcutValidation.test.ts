import { describe, expect, it } from "vitest";
import { validateShortcut, rejectionMessage } from "./shortcutValidation";
import { allCommands } from "./commandRegistry";

describe("validateShortcut", () => {
  const commands = allCommands();

  it("accepts a free chord", () => {
    expect(validateShortcut("find-elements", { key: "e", meta: true, alt: true }, commands)).toBeNull();
  });

  it("refuses combos macOS keeps", () => {
    const rejection = validateShortcut("find-elements", { key: "q", meta: true }, commands);
    expect(rejection?.reason).toBe("system");
    expect(rejectionMessage(rejection!)).toContain("macOS");
  });

  it("refuses every chord macOS keeps for tabs and windows", () => {
    // SPEC_TABS.md, В59, in the form the Shortcuts recorder produces.
    const chords = [
      { key: "t", meta: true },
      { key: "n", meta: true },
      { key: "w", meta: true },
      { key: "w", meta: true, shift: true },
      ...["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((key) => ({ key, meta: true })),
      { key: "[", meta: true, shift: true },
      { key: "]", meta: true, shift: true },
      { key: "{", meta: true, shift: true },
      { key: "}", meta: true, shift: true },
      { key: "Tab", ctrl: true },
      { key: "Tab", ctrl: true, shift: true },
    ];
    for (const chord of chords) {
      const recorded = { shift: false, alt: false, ctrl: false, meta: false, ...chord };
      expect(validateShortcut("find-elements", recorded, commands), JSON.stringify(chord))
        .toEqual({ reason: "system", combo: expect.any(String) });
    }
  });

  it("refuses the system chords whose modifiers come in a different order", () => {
    // Screenshots and Force Quit: the reserved list is keyed like a recorded chord.
    for (const chord of [
      { key: "3", meta: true, shift: true },
      { key: "5", meta: true, shift: true },
      { key: "Escape", meta: true, alt: true },
    ]) {
      expect(validateShortcut("find-elements", chord, commands)?.reason).toBe("system");
    }
  });

  it("keeps ⌘[ and ⌘] free of the tab chords that add shift", () => {
    expect(validateShortcut("copy-path", { key: "[", meta: true, alt: true }, commands)).toBeNull();
    expect(validateShortcut("history-back", { key: "[", meta: true }, commands)).toBeNull();
  });

  it("refuses a bare key: it would swallow typing", () => {
    const rejection = validateShortcut("find-elements", { key: "e" }, commands);
    expect(rejection?.reason).toBe("bare-key");
  });

  it("refuses a chord another command in the same surface answers", () => {
    // ⌘L already copies the path of an open element.
    const rejection = validateShortcut("copy-path", { key: "k", meta: true }, commands);
    expect(rejection?.reason).toBe("conflict");
    expect(rejectionMessage(rejection!)).toContain("Command");
  });

  it("lets mutually exclusive surfaces share a chord", () => {
    // The feed and an open element never listen at the same time, which is why
    // ⌘K already means the menu in both.
    const feedMenu = commands.find((command) => command.id === "element-menu")!;
    const elementMenu = commands.find((command) => command.id === "element-menu-open")!;
    expect(feedMenu.combo).toBe(elementMenu.combo);
    expect(validateShortcut("element-menu-open", { key: "k", meta: true }, commands)).toBeNull();
  });

  it("guards a global chord against every surface", () => {
    // Global commands are live on every surface, so they may not take a combo
    // any surface already uses.
    const rejection = validateShortcut("switch-space", { key: "k", meta: true }, commands);
    expect(rejection?.reason).toBe("conflict");
  });

  it("throws on an unknown command instead of silently passing", () => {
    expect(() => validateShortcut("nope", { key: "e", meta: true }, commands)).toThrow("nope");
  });
});
