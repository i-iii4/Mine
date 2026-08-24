import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActionButton } from "./ActionButton";

describe("bottom-bar command entries", () => {
  it("offers a keystroke reference without pretending to be a control", () => {
    // Switch collection and Navigate name what the user does on the keyboard,
    // and there is no single thing a click could do — stepping has a direction.
    // Focus is different and stays a button: it opens what is focused.
    render(<ActionButton hotkey="⌘⌥ ↕" readOnly>Switch collection</ActionButton>);
    const entry = screen.getByText("Switch collection").closest("[data-action-button]");

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
    // The outline also arrives from the button variant itself, not only from
    // the group-hover classes layered on top of it.
    expect(markup).not.toContain("hover:outline");
    expect(markup).not.toMatch(/\bhover:/);
    // Reference entries wear the secondary body: outline only, no fill. The
    // fill is what makes a control read as pressable.
    expect(markup).toContain("outline-border");
    expect(markup).toContain("bg-transparent");
    expect(markup).not.toContain("bg-component-fill");
  });

  it("keeps the fill on a command that can be pressed", () => {
    // The contrast is the point: pressable entries carry a body, reference
    // entries only a border.
    render(<ActionButton hotkey="↵" onClick={() => {}}>Focus</ActionButton>);
    const entry = screen.getByText("Focus").closest("[data-action-button]");

    expect(entry?.outerHTML ?? "").toContain("bg-component-fill");
  });

  it("leaves an ordinary command interactive", () => {
    render(<ActionButton hotkey="⌘," onClick={() => {}}>Settings</ActionButton>);
    const entry = screen.getByText("Settings").closest("[data-action-button]");

    expect(entry?.getAttribute("role")).toBe("button");
    expect(entry?.getAttribute("tabindex")).toBe("0");
  });
});
