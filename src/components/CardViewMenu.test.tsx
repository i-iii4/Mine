import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emit } from "@tauri-apps/api/event";
import {
  CARD_VIEW_STORAGE_KEY,
  PEEK_WIDTH_STORAGE_KEY,
  getCardView,
  getPeekWidth,
  reloadCardView,
  reloadPeekWidth,
} from "@/lib/cardView";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { displaySpec } from "@/lib/displayMenu";
import { menuSpecSize } from "@/lib/menuSpec";
import { useCardViewGroups } from "./CardViewMenu";
import { MenuSpecView } from "./MenuSpecView";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

/** The size of the group's panel now and at its largest, as the last render
 *  counted them. */
const counted = { now: 0, largest: 0 };

function CardViewPanel() {
  const cardView = useCardViewGroups();
  const spec = displaySpec(cardView.groups);
  counted.now = menuSpecSize(spec).size.height;
  counted.largest = menuSpecSize(displaySpec(cardView.largest)).size.height;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <MenuSpecView
          spec={spec}
          open
          dispatch={async (action) => {
            cardView.apply(action);
            return { kind: "done" };
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

async function openMenu() {
  const user = userEvent.setup();
  render(<CardViewPanel />);
  await user.click(screen.getByRole("button", { name: "Open" }));
  return user;
}

/// SPEC_CARD_PEEK.md, О1: «Element view» in the Display panel.
describe("the open card's view in the Display panel", () => {
  beforeEach(() => {
    vi.mocked(emit).mockClear();
  });

  afterEach(() => {
    localStorage.removeItem(CARD_VIEW_STORAGE_KEY);
    localStorage.removeItem(PEEK_WIDTH_STORAGE_KEY);
    act(() => {
      reloadCardView();
      reloadPeekWidth();
    });
  });

  it("offers Full page, checked, and Peek under its caption", async () => {
    await openMenu();
    const group = screen.getByRole("group", { name: "Element view" });
    expect(within(group).getByRole("menuitemradio", { name: "Full page" })).toHaveAttribute("aria-checked", "true");
    expect(within(group).getByRole("menuitemradio", { name: "Peek" })).toHaveAttribute("aria-checked", "false");
    // The Peek window's width is no choice while the card opens as a page (О3).
    expect(screen.queryByRole("group", { name: "Peek width" })).toBeNull();
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

  it("offers the Peek window's width once Peek is chosen, and counts the panel with it from the start", async () => {
    const user = await openMenu();
    const before = { ...counted };
    // The panel may grow by the width's caption and its two rows: the frame
    // of the menu panel is set for that from the opening.
    expect(before.largest).toBe(before.now + 28 + 2 * 32);
    await user.click(screen.getByRole("menuitemradio", { name: "Peek" }));
    const width = screen.getByRole("group", { name: "Peek width" });
    expect(within(width).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Fit element", "Fill"]);
    expect(counted.now).toBe(before.largest);
    await user.click(within(width).getByRole("menuitemradio", { name: "Fill" }));
    expect(getPeekWidth()).toBe("fill");
    expect(vi.mocked(emit)).toHaveBeenCalledWith(
      "settings-changed",
      expect.objectContaining({ key: PEEK_WIDTH_STORAGE_KEY }),
    );
  });

  it("leaves a choice of another group alone", async () => {
    let applied = true;
    function Probe() {
      const cardView = useCardViewGroups();
      applied = cardView.apply({ kind: "choose", id: "sort", value: "oldest" }) || cardView.apply({ kind: "choose", id: "card-view", value: "sideways" });
      return null;
    }
    render(<Probe />);
    expect(applied).toBe(false);
    expect(getCardView()).toBe("full");
  });
});
