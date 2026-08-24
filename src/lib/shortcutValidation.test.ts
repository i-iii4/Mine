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
