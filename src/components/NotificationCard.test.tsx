// The one look of a notice: its text stays inside the card.

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { NotificationCard } from "./NotificationCard";

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
});
