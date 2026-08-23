import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActionButton } from "./ActionButton";

describe("bottom-bar command entries", () => {
  it("offers a keystroke reference without pretending to be a control", () => {
    // Navigate and Focus name what the user does on the keyboard. Clicking
    // them would do nothing, so they are neither focusable nor announced as
    // buttons — otherwise Tab lands on a dead stop.
    render(<ActionButton hotkey="↵" readOnly>Focus</ActionButton>);
    const entry = screen.getByText("Focus").closest("[data-action-button]");

    expect(entry).not.toBeNull();
    expect(entry?.getAttribute("role")).toBeNull();
    expect(entry?.getAttribute("tabindex")).toBeNull();
    expect(entry?.getAttribute("data-action-button-readonly")).toBe("true");
  });

  it("does not answer the pointer, since it cannot be pressed", () => {
    // A hover response promises a press. On an entry that names a keystroke
    // there is nothing to press, so the promise is false.
    render(<ActionButton hotkey="↕ ↔" readOnly>Navigate</ActionButton>);
    const entry = screen.getByText("Navigate").closest("[data-action-button]");
    const markup = entry?.outerHTML ?? "";

    expect(markup).not.toContain("hover:bg-active");
    expect(markup).not.toContain("group-hover:outline");
    expect(markup).not.toContain("group-hover:text-foreground");
  });

  it("leaves an ordinary command interactive", () => {
    render(<ActionButton hotkey="⌘," onClick={() => {}}>Settings</ActionButton>);
    const entry = screen.getByText("Settings").closest("[data-action-button]");

    expect(entry?.getAttribute("role")).toBe("button");
    expect(entry?.getAttribute("tabindex")).toBe("0");
  });
});
