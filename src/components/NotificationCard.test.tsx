// The one look of a notice: its text stays inside the card, its title is a
// line of the interface, and its corner keeps clear of the bottom bar.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NotificationAnchor, NotificationCard } from "./NotificationCard";
import { MODAL_ERROR_CLASS } from "@/components/ui/modal-window";
import {
  NOTIFICATION_BOTTOM_VAR,
  NOTIFICATION_GAP_OVER_BAR_PX,
  notificationBottomOverBar,
  publishNotificationBottom,
} from "@/lib/notificationPlacement";

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

  // Decision of 14.10.2026: a refused Trash says where to allow access on a
  // second line; the notice and a window's error keep that line.
  it("keeps a line break the error carries, in a notice and in a window", () => {
    const text = "Could not move “Card.md” to the Trash. Nothing was deleted.\nAllow Mine to access iCloud Drive in System Settings, Privacy & Security, Files and Folders.";
    render(
      <NotificationCard title="Could not delete the element">
        <p data-testid="message">{text}</p>
      </NotificationCard>,
    );
    const message = screen.getByTestId("message");
    expect(message.textContent).toBe(text);
    expect(message.parentElement).toHaveClass("whitespace-pre-line");
    expect(MODAL_ERROR_CLASS.split(" ")).toContain("whitespace-pre-line");
  });

  it("offers closing only to a notice that is closed for good", () => {
    const { rerender } = render(<NotificationCard title="Work">{null}</NotificationCard>);
    expect(screen.queryByRole("button")).toBeNull();

    rerender(<NotificationCard title="Advice" onClose={vi.fn()}>{null}</NotificationCard>);
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });
});

describe("NotificationAnchor", () => {
  // Decision of 14.10.2026: 16 px over the bar's top edge, as the page
  // publishes it; without a bar, the feed's inset from the window's edge.
  it("stands on the cards' right edge, over the bar or on the window inset without one", () => {
    const { container } = render(<NotificationAnchor>{null}</NotificationAnchor>);
    const anchor = container.querySelector("[data-notification-anchor]");
    expect(anchor).toHaveClass(
      "fixed",
      "right-[var(--edge-rhythm,32px)]",
      "bottom-[var(--notification-bottom,var(--edge-rhythm,32px))]",
    );
  });
});

describe("publishNotificationBottom", () => {
  function barAt(top: number): HTMLElement {
    const bar = document.createElement("div");
    bar.getBoundingClientRect = () => ({ top, bottom: top + 40, left: 0, right: 800, width: 800, height: 40, x: 0, y: top, toJSON: () => ({}) });
    return bar;
  }

  it("puts the corner 16 px above the bar's top edge, frame line under the bar included", () => {
    const target = document.createElement("div");
    // A window 768 px high; the bar's top edge at 727: 40 px of bar and the
    // 1 px frame line under it.
    publishNotificationBottom(target, barAt(727), 768);
    expect(target.style.getPropertyValue(NOTIFICATION_BOTTOM_VAR)).toBe("57px");
    expect(notificationBottomOverBar(727, 768)).toBe(41 + NOTIFICATION_GAP_OVER_BAR_PX);
  });

  // The development pages place their notices as the tab page does.
  it("is how the development pages with a bottom bar place their notices", () => {
    for (const page of ["../dev/CloudOpenPage.tsx", "../dev/OnboardingPage.tsx"]) {
      const source = readFileSync(resolve(__dirname, page), "utf8");
      expect(source, page).toContain("publishNotificationBottom(");
      expect(source, page).not.toContain("--bottom-bar-height");
    }
  });

  it("leaves the window inset when there is no bar", () => {
    const target = document.createElement("div");
    publishNotificationBottom(target, barAt(700), 768);
    publishNotificationBottom(target, null, 768);
    expect(target.style.getPropertyValue(NOTIFICATION_BOTTOM_VAR)).toBe("");
  });
});
