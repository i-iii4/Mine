import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VaultSwitcher } from "./VaultSwitcher";

const commandMocks = vi.hoisted(() => ({
  listKnownVaults: vi.fn<() => Promise<string[]>>(),
  selectVault: vi.fn<(path: string) => Promise<void>>(),
  forgetKnownVault: vi.fn<(path: string) => Promise<string[]>>(),
}));

const revealItemInDir = vi.hoisted(() => vi.fn<(path: string) => Promise<void>>());

vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir }));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@/lib/commands", () => ({
  listKnownVaults: commandMocks.listKnownVaults,
  selectVault: commandMocks.selectVault,
  forgetKnownVault: commandMocks.forgetKnownVault,
}));

describe("VaultSwitcher", () => {
  beforeEach(() => {
    commandMocks.listKnownVaults.mockResolvedValue([]);
    commandMocks.selectVault.mockResolvedValue(undefined);
    commandMocks.forgetKnownVault.mockReset();
    commandMocks.forgetKnownVault.mockResolvedValue([]);
    revealItemInDir.mockReset();
    revealItemInDir.mockResolvedValue(undefined);
  });

  it("keeps the top-chrome layout slot transparent and puts hover state on the inner pill", async () => {
    render(
      <VaultSwitcher
        currentPath="/Users/i_iii/Library/Mobile Documents/com~apple~CloudDocs/Mine"
        onVaultSelected={vi.fn()}
        surface="topChrome"
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const trigger = screen.getByRole("button", { name: /Switch space: Mine/ });
    expect(trigger).toHaveClass("bg-transparent");
    expect(trigger).toHaveClass("max-w-[50%]");
    expect(trigger).not.toHaveClass("max-w-[159px]");
    expect(trigger).toHaveClass("px-3");
    expect(trigger).toHaveClass("font-mono");
    expect(trigger).toHaveClass("text-sm");
    expect(trigger).toHaveClass("text-muted-foreground");
    expect(trigger).not.toHaveClass("text-base");
    expect(trigger).not.toHaveClass("hover:bg-component-fill-hover");
    expect(trigger).not.toHaveClass("focus-visible:outline-1");
    expect(trigger.querySelector("svg")).toBeNull();

    const pill = screen.getByText("Mine").parentElement as HTMLElement;
    expect(pill).toHaveClass("rounded-1");
    expect(pill).toHaveClass("px-2");
    expect(pill).toHaveClass("text-muted-foreground");
    expect(pill).toHaveClass("group-hover:bg-active");
    expect(pill).toHaveClass("group-hover:text-foreground");
    expect(pill).toHaveClass("group-data-[state=open]:bg-active");
    expect(pill).toHaveClass("group-data-[state=open]:text-foreground");
    expect(pill).not.toHaveClass("group-hover:bg-component-fill-hover");
    expect(pill).not.toHaveClass("group-focus-visible:bg-component-fill-hover");
  });

  it("uses intrinsic capped width in collapsed top-chrome mode", async () => {
    render(
      <VaultSwitcher
        currentPath="/Users/i_iii/Library/Mobile Documents/com~apple~CloudDocs/Mine"
        onVaultSelected={vi.fn()}
        surface="topChrome"
        topChromeCollapsed
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const trigger = screen.getByRole("button", { name: /Switch space: Mine/ });
    expect(trigger).toHaveClass("max-w-[159px]");
    expect(trigger).not.toHaveClass("max-w-[50%]");
    expect(trigger).toHaveTextContent("Mine");
  });

  it("omits the current space and keeps space rows free of icon markers", async () => {
    commandMocks.listKnownVaults.mockResolvedValue([
      "/Users/i_iii/Library/Mobile Documents/com~apple~CloudDocs/Mine",
      "/Users/i_iii/Desktop/Тест",
    ]);

    render(
      <VaultSwitcher
        currentPath="/Users/i_iii/Library/Mobile Documents/com~apple~CloudDocs/Mine"
        onVaultSelected={vi.fn()}
        surface="topChrome"
      />,
    );

    await waitFor(() => {
      expect(commandMocks.listKnownVaults).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole("button", { name: /Switch space: Mine/ }));

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Search spaces" })).toHaveFocus();
    });
    expect(screen.queryByRole("menuitem", { name: "Mine" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Тест" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Add space" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Reveal in Finder" })).toBeInTheDocument();
    expect(document.querySelector("[data-vault-switcher-menu]")).toHaveAttribute(
      "data-vault-switcher-menu-align-offset",
      "12",
    );
    // Icons live in two places only: the per-row actions, and the pinned
    // commands below the divider. A space row is still a name and nothing else.
    const content = document.querySelector("[data-slot='dropdown-menu-content']");
    const icons = content?.querySelectorAll("svg") ?? [];
    for (const icon of icons) {
      const allowed = icon.closest("[data-vault-switcher-row-actions]")
        ?? icon.closest("[data-vault-switcher-pinned-actions]");
      expect(allowed).not.toBeNull();
    }
  });

  it("reveals the current space from the pinned action and closes the menu", async () => {
    await openSwitcherWithSpaces();

    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in Finder" }));

    // The action targets the space the switcher is pointing at, not a row.
    await waitFor(() => {
      expect(revealItemInDir).toHaveBeenCalledWith(
        "/Users/i_iii/Library/Mobile Documents/com~apple~CloudDocs/Mine",
      );
    });
    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Reveal in Finder" })).not.toBeInTheDocument();
    });
  });

  it("gives both pinned actions a leading icon and space rows an empty slot of the same width", async () => {
    await openSwitcherWithSpaces();

    for (const name of ["Reveal in Finder", "Add space"]) {
      const action = screen.getByRole("menuitem", { name });
      const slot = action.querySelector("[data-card-menu-icon-slot]");
      expect(slot).not.toBeNull();
      // Leading position: the slot is the first child, so the icon sits left of
      // the label the way ordinary menu rows are built.
      expect(action.firstElementChild).toBe(slot);
      expect(slot?.querySelector("svg")).not.toBeNull();
    }

    // One text column through the whole menu: the row keeps the slot, empty.
    const row = screen.getByRole("menuitem", { name: "Тест" });
    const rowSlot = row.querySelector("[data-card-menu-icon-slot]");
    expect(rowSlot).not.toBeNull();
    expect(rowSlot?.querySelector("svg")).toBeNull();
  });

  it("reaches the pinned actions with arrow navigation", async () => {
    await openSwitcherWithSpaces();
    const search = screen.getByRole("textbox", { name: "Search spaces" });

    // One space, then Reveal in Finder, then Add space.
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowDown" });

    expect(screen.getByRole("menuitem", { name: "Reveal in Finder" })).toHaveAttribute(
      "data-search-menu-action-active",
      "true",
    );

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Add space" })).toHaveAttribute(
      "data-search-menu-action-active",
      "true",
    );

    // Past the last action the selection stops rather than wrapping.
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Add space" })).toHaveAttribute(
      "data-search-menu-action-active",
      "true",
    );
  });

  it("filters spaces and keeps input focus while arrow navigation changes the active row", async () => {
    commandMocks.listKnownVaults.mockResolvedValue([
      "/Users/i_iii/Library/Mobile Documents/com~apple~CloudDocs/Mine",
      "/Users/i_iii/Desktop/Журнал",
      "/Users/i_iii/Desktop/Фотоальбомы",
    ]);
    const onVaultSelected = vi.fn();

    render(
      <VaultSwitcher
        currentPath="/Users/i_iii/Library/Mobile Documents/com~apple~CloudDocs/Mine"
        onVaultSelected={onVaultSelected}
        surface="topChrome"
      />,
    );

    await waitFor(() => {
      expect(commandMocks.listKnownVaults).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole("button", { name: /Switch space: Mine/ }));
    const search = await screen.findByRole("textbox", { name: "Search spaces" });
    expect(search).toHaveAttribute("autocomplete", "off");
    expect(search).toHaveAttribute("autocorrect", "off");
    expect(search).toHaveAttribute("autocapitalize", "none");
    expect(search).toHaveAttribute("spellcheck", "false");
    fireEvent.change(search, { target: { value: "фо" } });

    expect(screen.queryByRole("menuitem", { name: "Журнал" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Фотоальбомы" })).toBeInTheDocument();

    fireEvent.keyDown(search, { key: "ArrowDown" });
    await waitFor(() => {
      expect(search).toHaveFocus();
    });
    expect(search).toHaveAttribute("aria-activedescendant");
    expect(screen.getByRole("menuitem", { name: "Фотоальбомы" })).toHaveAttribute(
      "data-search-menu-action-active",
      "true",
    );

    fireEvent.keyDown(search, { key: "Enter" });

    await waitFor(() => {
      expect(commandMocks.selectVault).toHaveBeenCalledWith("/Users/i_iii/Desktop/Фотоальбомы");
    });
    expect(onVaultSelected).toHaveBeenCalledWith("/Users/i_iii/Desktop/Фотоальбомы");
  });

  async function openSwitcherWithSpaces() {
    commandMocks.listKnownVaults.mockResolvedValue([
      "/Users/i_iii/Library/Mobile Documents/com~apple~CloudDocs/Mine",
      "/Users/i_iii/Desktop/Тест",
    ]);
    render(
      <VaultSwitcher
        currentPath="/Users/i_iii/Library/Mobile Documents/com~apple~CloudDocs/Mine"
        onVaultSelected={vi.fn()}
        surface="topChrome"
      />,
    );
    await waitFor(() => expect(commandMocks.listKnownVaults).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Switch space: Mine/ }));
    await screen.findByRole("menuitem", { name: "Тест" });
  }

  it("reveals a space in Finder from its row", async () => {
    await openSwitcherWithSpaces();

    fireEvent.click(screen.getByRole("button", { name: "Reveal Тест in Finder" }));

    await waitFor(() => {
      expect(revealItemInDir).toHaveBeenCalledWith("/Users/i_iii/Desktop/Тест");
    });
  });

  it("asks before forgetting a space and says the files stay on disk", async () => {
    await openSwitcherWithSpaces();

    fireEvent.click(screen.getByRole("button", { name: "Remove Тест from the list" }));

    // The whole point of the confirmation: removal here is about the list, and
    // the wording has to rule out the reading that files are being deleted.
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/Nothing is deleted from your computer/i);
    expect(commandMocks.forgetKnownVault).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(commandMocks.forgetKnownVault).toHaveBeenCalledWith("/Users/i_iii/Desktop/Тест");
    });
  });

  it("dresses the row actions like the rest of the system", async () => {
    await openSwitcherWithSpaces();

    const reveal = screen.getByRole("button", { name: "Reveal Тест in Finder" });
    const remove = screen.getByRole("button", { name: "Remove Тест from the list" });

    // Muted at rest, filled on approach — the same contract as the search
    // field's clear button. An icon painted detach-orange at rest would read as
    // a standing warning about the space rather than an available action.
    for (const action of [reveal, remove]) {
      expect(action).toHaveClass("text-muted-foreground");
      expect(action).toHaveClass("hover:bg-component-fill-hover");
      expect(action.className).not.toMatch(/(^|\s)text-detach/);
    }
    expect(remove).toHaveClass("hover:text-detach");

    // Icon size comes from the icon-xs button contract; restating it locally is
    // what made these glyphs bigger than the same ones elsewhere.
    for (const icon of [reveal.querySelector("svg"), remove.querySelector("svg")]) {
      expect(icon?.getAttribute("class") ?? "").not.toMatch(/\bsize-\d/);
    }
  });

  it("explains the reveal action on hover", async () => {
    await openSwitcherWithSpaces();

    fireEvent.pointerMove(screen.getByRole("button", { name: "Reveal Тест in Finder" }));

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Reveal in Finder");
  });

  it("says on hover that removing a space leaves the files on disk", async () => {
    await openSwitcherWithSpaces();

    fireEvent.pointerMove(screen.getByRole("button", { name: "Remove Тест from the list" }));

    // The consequence, not the label: this action is the one users read as
    // "delete the folder", and the tooltip has to rule that out.
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Remove from the list — files stay on disk",
    );
  });

  it("forgets nothing when the confirmation is dismissed", async () => {
    await openSwitcherWithSpaces();

    fireEvent.click(screen.getByRole("button", { name: "Remove Тест from the list" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(commandMocks.forgetKnownVault).not.toHaveBeenCalled();
  });
});
