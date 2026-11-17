// Where a new card goes (SPEC_MEDIA_ASSET_ACTIONS.md;
// SPEC_TEXT_SELECTION_EXTRACTION.md; SPEC_MENU_WINDOW.md, МО27): the list's
// order and filter, the row to create a collection, the row a card is being
// made for, and the words of a failure.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { COLLECTION_PICKER_CONTENT_CLASS } from "./CollectionPicker";
import { NewCardCollectionPicker } from "./NewCardCollectionPicker";

type Choose = (collection: string | null, create: boolean) => Promise<string | null>;

function renderPicker(onChoose: Choose, current: string | null = null) {
  render(
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent widthRole="search" className={COLLECTION_PICKER_CONTENT_CLASS}>
        <NewCardCollectionPicker collections={["Web", "Read", "Later"]} current={current} onChoose={onChoose} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

function rows(): string[] {
  return screen.getAllByRole("menuitem").map((row) => row.textContent ?? "");
}

describe("NewCardCollectionPicker", () => {
  it("lists no collection first, then the space's collections in their order, the feed's own hoisted", () => {
    renderPicker(vi.fn<Choose>(async () => null));
    expect(rows()).toEqual(["Everything", "Web", "Read", "Later"]);
  });

  it("hoists the collection the feed stands on and keeps the rest as they were", () => {
    renderPicker(vi.fn<Choose>(async () => null), "Later");
    expect(rows()).toEqual(["Everything", "Later", "Web", "Read"]);
  });

  it("filters the rows as the query is typed, and offers to create a collection no row matches", async () => {
    const onChoose = vi.fn<Choose>(async () => null);
    renderPicker(onChoose);
    const search = screen.getByPlaceholderText("Search collections...");
    fireEvent.change(search, { target: { value: "re" } });
    expect(rows()).toEqual(["Read"]);
    fireEvent.change(search, { target: { value: "  Films " } });
    expect(rows()).toEqual(["Create “Films”"]);
    fireEvent.click(screen.getByText("Create “Films”"));
    await waitFor(() => expect(onChoose).toHaveBeenCalledWith("Films", true));
    // The card is made: the query goes, and every row is back.
    await waitFor(() => expect((search as HTMLInputElement).value).toBe(""));
    expect(rows()).toEqual(["Everything", "Web", "Read", "Later"]);
  });

  it("creates the card in no collection for Everything, and in the collection of a row", async () => {
    const onChoose = vi.fn<Choose>(async () => null);
    renderPicker(onChoose);
    fireEvent.click(screen.getByText("Everything"));
    await waitFor(() => expect(onChoose).toHaveBeenLastCalledWith(null, false));
    await waitFor(() => expect(screen.getByText("Read").closest("[role='menuitem']")?.hasAttribute("data-disabled")).toBe(false));
    fireEvent.click(screen.getByText("Read"));
    await waitFor(() => expect(onChoose).toHaveBeenLastCalledWith("Read", false));
  });

  it("says a card is being made in the row chosen, and takes no other choice until the answer", async () => {
    let answer!: (message: string | null) => void;
    const onChoose = vi.fn<Choose>(() => new Promise((resolve) => { answer = resolve; }));
    renderPicker(onChoose);
    fireEvent.click(screen.getByText("Web"));
    expect(await screen.findByText("Creating...")).toBeTruthy();
    expect(rows()).toEqual(["Everything", "Creating...", "Read", "Later"]);
    expect(screen.getAllByRole("menuitem").every((row) => row.hasAttribute("data-disabled"))).toBe(true);
    fireEvent.click(screen.getByText("Everything"));
    expect(onChoose).toHaveBeenCalledTimes(1);
    answer(null);
    await waitFor(() => expect(rows()).toEqual(["Everything", "Web", "Read", "Later"]));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says why a card could not be made, keeps the query, and forgets the words on the next try", async () => {
    const onChoose = vi.fn<Choose>()
      .mockResolvedValueOnce("The note changed. Select the text again.")
      .mockResolvedValueOnce(null);
    renderPicker(onChoose);
    const search = screen.getByPlaceholderText("Search collections...");
    fireEvent.change(search, { target: { value: "web" } });
    fireEvent.click(screen.getByText("Web"));
    expect((await screen.findByRole("alert")).textContent).toBe("The note changed. Select the text again.");
    expect((search as HTMLInputElement).value).toBe("web");
    fireEvent.click(screen.getByText("Web"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await waitFor(() => expect((search as HTMLInputElement).value).toBe(""));
  });
});
