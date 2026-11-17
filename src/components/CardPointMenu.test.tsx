// The card's right click menu on the page, on the real Radix (user's
// decision of 15.11.2026): Escape in its Connect submenu climbs one layer at
// a time. With a query the first press clears it; the next closes the
// submenu alone and gives the focus back to Connect, as the card's `···`
// menu and the selection's menu do; the next closes the menu. The menu is a
// dropdown off the point of the click (SPEC_MENU_WINDOW.md, МО68).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LightBlock } from "@/types";
import { CardPointMenu } from "./CardHoverMenu";

vi.mock("@/lib/commands", () => ({
  getBlock: vi.fn(async () => null),
}));

const BLOCK = {
  id: 1,
  slug: "card",
  card_kind: "media",
  block_type: "image",
  title: "Card",
  display_title: "Card",
  fallback_label: "Card",
  description: null,
  url: null,
  media_file: null,
  thumbnail: null,
  saved_at: "2026-09-19T00:00:00Z",
  source: null,
  width: null,
  height: null,
  author: null,
  body: "",
  preview_text: null,
  first_image: null,
  media_urls: null,
  media_dimensions: null,
  preview_manifest: null,
  feed_playback: null,
  thumb_format: null,
  thumb_mtime: 0,
  related_notes: [],
  tags: [],
} as unknown as LightBlock;

function renderMenu() {
  render(
    <CardPointMenu
      block={BLOCK}
      x={120}
      y={80}
      openRequestSequence={1}
      vaultPath="/vault"
      tags={[{ tag: "Journal", count: 1 }, { tag: "Zebra", count: 2 }]}
      onToggleTag={vi.fn()}
      onCreateAndAssign={vi.fn()}
      onRequestRename={vi.fn()}
      onRequestDelete={vi.fn()}
    />,
  );
}

const menus = () => document.querySelectorAll("[role='menu']").length;
const connect = () => screen.getByRole("menuitem", { name: "Connect" });

/** Connect opened from the keyboard, the caret in the picker's field. */
async function openConnect(): Promise<HTMLInputElement> {
  renderMenu();
  fireEvent.keyDown(connect(), { key: "ArrowRight" });
  return (await screen.findByPlaceholderText("Search collections...")) as HTMLInputElement;
}

describe("Escape in the Connect submenu of the card's right click menu", () => {
  it("clears the query, then closes the submenu alone with the focus on Connect, then the menu", async () => {
    const field = await openConnect();
    fireEvent.change(field, { target: { value: "Jo" } });
    expect(screen.queryByText("Zebra")).toBeNull();

    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("");
    expect(menus()).toBe(2);

    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(screen.queryByPlaceholderText("Search collections...")).toBeNull());
    expect(menus()).toBe(1);
    await waitFor(() => expect(connect()).toHaveFocus());

    fireEvent.keyDown(connect(), { key: "Escape" });
    await waitFor(() => expect(menus()).toBe(0));
  });

  it("closes the submenu alone on Escape with no query", async () => {
    const field = await openConnect();
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(screen.queryByPlaceholderText("Search collections...")).toBeNull());
    expect(menus()).toBe(1);
  });
});
