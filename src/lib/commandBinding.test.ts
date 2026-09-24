import { describe, expect, it } from "vitest";
import { bindingLabel, bindingMatches } from "./commandBinding";

describe("command bindings", () => {
  it("matches a shifted digit by physical key and shows both modifiers", () => {
    const binding = { key: "1", meta: true, shift: true };
    const event = new KeyboardEvent("keydown", {
      key: "!",
      code: "Digit1",
      metaKey: true,
      shiftKey: true,
    });

    expect(bindingLabel(binding)).toBe("⇧⌘1");
    expect(bindingMatches(binding, event)).toBe(true);
    expect(bindingMatches(binding, new KeyboardEvent("keydown", {
      key: "1", code: "Digit1", metaKey: true,
    }))).toBe(false);
  });
});
