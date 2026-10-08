// The one look of a notice: its text stays inside the card, its title is a
// line of the interface, and its corner keeps clear of the bottom bar.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NotificationAnchor, NotificationCard } from "./NotificationCard";

describe("NotificationCard", () => {
  it("breaks a long word, such as a path in an error, inside the card", () => {
    const { container } = render(
      <NotificationCard title="Indexing failed" onClose={vi.fn()}>
        <p>/Users/someone/Library/Application Support/com.mine.app/vaults/0123456789abcdef/index.db</p>
      </NotificationCard>,
    );

    const card = container.querySelector("[data-notification-card]");
    expect(card?.className).toContain("[overflow-wrap:anywhere]");
  });

  it("sets its title like a menu item, not a heading (08.10.2026)", () => {
    render(<NotificationCard title="Preparing previews">{null}</NotificationCard>);
    const title = screen.getByText("Preparing previews");
    expect(title).toHaveClass("text-base", "text-foreground");
    expect(title).not.toHaveClass("font-semibold");
  });

  it("offers closing only to a notice that is closed for good", () => {
    const { rerender } = render(<NotificationCard title="Work">{null}</NotificationCard>);
    expect(screen.queryByRole("button")).toBeNull();

    rerender(<NotificationCard title="Advice" onClose={vi.fn()}>{null}</NotificationCard>);
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });
});

describe("NotificationAnchor", () => {
  it("stands on the cards' right edge and the feed's inset above the bottom bar", () => {
    const { container } = render(<NotificationAnchor>{null}</NotificationAnchor>);
    const anchor = container.querySelector("[data-notification-anchor]");
    expect(anchor).toHaveClass(
      "fixed",
      "right-[var(--edge-rhythm,32px)]",
      "bottom-[calc(var(--bottom-bar-height,0px)+var(--edge-rhythm,32px))]",
    );
  });
});
