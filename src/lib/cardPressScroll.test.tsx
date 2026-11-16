import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { holdScrollUnderCardPress } from "./cardPressScroll";

/** Press `node` with `button` and say whether its default was prevented. */
function press(node: Element, button = 0): boolean {
  const event = createEvent.mouseDown(node, { button, bubbles: true, cancelable: true });
  fireEvent(node, event);
  return event.defaultPrevented;
}

/// Decision of 15.11.2026 (SPEC_FRONTEND.md, «Лента не прокручивается под
/// перетаскиванием карточки»): a press on a card holds off WebKit's own scroll
/// of the box it began in, and the focus goes where the press put it.
describe("a press on a card", () => {
  it("prevents the press's default and gives the card the focus", () => {
    render(
      <>
        <input aria-label="Field" />
        <div role="button" tabIndex={0} aria-label="Card" onMouseDown={holdScrollUnderCardPress}>
          <span>Title</span>
        </div>
      </>,
    );
    screen.getByRole("textbox", { name: "Field" }).focus();
    expect(press(screen.getByText("Title"))).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Card" }));
  });

  it("leaves a control inside the card, and the other buttons, their own press", () => {
    render(
      <div role="button" tabIndex={0} aria-label="Card" onMouseDown={holdScrollUnderCardPress}>
        <button type="button">More</button>
      </div>,
    );
    expect(press(screen.getByRole("button", { name: "More" }))).toBe(false);
    expect(press(screen.getByRole("button", { name: "Card" }), 2)).toBe(false);
    expect(press(screen.getByRole("button", { name: "Card" }), 1)).toBe(false);
  });

  it("focuses a thumbnail's row, or nothing when nothing takes the focus", () => {
    render(
      <>
        <input aria-label="Field" />
        <div tabIndex={-1} data-testid="row">
          <div data-testid="thumbnail" onMouseDown={holdScrollUnderCardPress} />
        </div>
        <div data-testid="loose" onMouseDown={holdScrollUnderCardPress} />
      </>,
    );
    expect(press(screen.getByTestId("thumbnail"))).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId("row"));
    screen.getByRole("textbox", { name: "Field" }).focus();
    expect(press(screen.getByTestId("loose"))).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });
});
