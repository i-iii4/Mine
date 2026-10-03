import { describe, expect, it } from "vitest";

import { installControlCharGuard, isStrayControlInsertion } from "./controlCharGuard";

describe("control character guard (SPEC_TABS.md, В80)", () => {
  it("recognises the characters arrow keys insert by mistake", () => {
    for (const code of [0x1c, 0x1d, 0x1e, 0x1f]) {
      expect(isStrayControlInsertion("insertText", String.fromCharCode(code))).toBe(true);
    }
    expect(isStrayControlInsertion("insertText", "a")).toBe(false);
    expect(isStrayControlInsertion("insertText", null)).toBe(false);
    expect(isStrayControlInsertion("deleteContentBackward", "\u001c")).toBe(false);
  });

  it("cancels such an insertion and lets ordinary typing through", () => {
    const remove = installControlCharGuard(document);
    const field = document.createElement("input");
    document.body.append(field);

    const stray = new InputEvent("beforeinput", { inputType: "insertText", data: "\u001d", cancelable: true });
    field.dispatchEvent(stray);
    expect(stray.defaultPrevented).toBe(true);

    const letter = new InputEvent("beforeinput", { inputType: "insertText", data: "x", cancelable: true });
    field.dispatchEvent(letter);
    expect(letter.defaultPrevented).toBe(false);

    remove();
    const after = new InputEvent("beforeinput", { inputType: "insertText", data: "\u001d", cancelable: true });
    field.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    field.remove();
  });
});
