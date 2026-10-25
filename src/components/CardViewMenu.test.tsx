import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emit } from "@tauri-apps/api/event";
import { CARD_VIEW_STORAGE_KEY, getCardView, reloadCardView } from "@/lib/cardView";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CardViewMenu } from "./CardViewMenu";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

async function openMenu() {
  const user = userEvent.setup();
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <CardViewMenu />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  await user.click(screen.getByRole("button", { name: "Open" }));
  return user;
}

/// TRIAL (SPEC_CARD_PEEK.md, О1): «Card view» in the Display panel.
describe("CardViewMenu", () => {
  afterEach(() => {
    localStorage.removeItem(CARD_VIEW_STORAGE_KEY);
    act(() => reloadCardView());
  });

  it("offers Full page, checked, and Peek under its caption", async () => {
    await openMenu();
    const group = screen.getByRole("group", { name: "Card view" });
    expect(group).toHaveAttribute("data-display-trial");
    expect(within(group).getByRole("menuitemradio", { name: "Full page" })).toHaveAttribute("aria-checked", "true");
    expect(within(group).getByRole("menuitemradio", { name: "Peek" })).toHaveAttribute("aria-checked", "false");
  });

  it("keeps Peek, stays open and tells the other tabs and windows", async () => {
    const user = await openMenu();
    await user.click(screen.getByRole("menuitemradio", { name: "Peek" }));
    expect(getCardView()).toBe("peek");
    expect(localStorage.getItem(CARD_VIEW_STORAGE_KEY)).toBe("peek");
    expect(screen.getByRole("menuitemradio", { name: "Peek" })).toHaveAttribute("aria-checked", "true");
    expect(vi.mocked(emit)).toHaveBeenCalledWith(
      "settings-changed",
      expect.objectContaining({ key: CARD_VIEW_STORAGE_KEY, value: "peek" }),
    );
  });
});
