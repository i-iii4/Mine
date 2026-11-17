import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { SPACE_LIST_ID, VaultSwitcher, spaceMenuSpec } from "./VaultSwitcher";
import { MENU_MODE_STORAGE_KEY } from "@/lib/menuMode";
import { MENU_PANEL_TO_SOURCE_EVENT } from "@/lib/menuPanelProtocol";
import { resetMenuPanelSourceForTests } from "@/lib/menuPanelSource";
import { MOTION_LEVELS, MOTION_MENU_BLINK_MS } from "@/lib/motion";
import { MENU_BLINK_ATTRIBUTE, setMenuBlinkMsForTests } from "@/lib/menuBlink";
import { setMotionLevel } from "@/test/motionLevel";
import type { MenuSpec, MenuWidgetAction, SpaceEntry } from "@/types";

it.each(["pointer", "keyboard"])("refreshes externally added spaces when opened by %s", async (input) => {
  commandMocks.listKnownVaults.mockResolvedValue(["/tmp/Mine"]);
  commandMocks.listSpaces.mockResolvedValue([]);
  render(<VaultSwitcher currentPath="/tmp/Mine" onVaultSelected={vi.fn()} surface="topChrome" />);
  await waitFor(() => expect(commandMocks.listKnownVaults).toHaveBeenCalled());
  commandMocks.listKnownVaults.mockResolvedValue(["/tmp/Mine", "/tmp/From clipper"]);
  const trigger = screen.getByRole("button", { name: "Switch space: Mine" });
  if (input === "pointer") fireEvent.click(trigger);
  else fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(await screen.findByRole("menuitem", { name: "From clipper" })).toBeInTheDocument();
});

const commandMocks = vi.hoisted(() => ({
  listKnownVaults: vi.fn<() => Promise<string[]>>(),
  selectVault: vi.fn<(path: string) => Promise<void>>(),
  forgetKnownVault: vi.fn<(path: string) => Promise<string[]>>(),
  listSpaces: vi.fn<() => Promise<SpaceEntry[]>>(),
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
  listSpaces: commandMocks.listSpaces,
  recordStartupMilestone: () => Promise.resolve(),
}));

describe("VaultSwitcher", () => {
  beforeEach(() => {
    commandMocks.listKnownVaults.mockResolvedValue([]);
    commandMocks.listSpaces.mockResolvedValue([]);
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
    expect(trigger).toHaveClass("max-w-[min(50%,200px)]");
    expect(trigger).not.toHaveClass("max-w-[200px]");
    // First in the tab page's row: the label lands on the chrome edge inset
    // (SPEC_TABS.md, В43).
    expect(trigger).toHaveClass("pl-[var(--top-collection-pad-x)]", "pr-[var(--top-collection-pad-x)]");
    expect(trigger).toHaveClass("font-mono");
    expect(trigger).toHaveClass("text-sm");
    expect(trigger).toHaveClass("text-muted-foreground");
    expect(trigger).not.toHaveClass("text-base");
    expect(trigger).not.toHaveClass("hover:bg-component-fill-hover");
    expect(trigger).not.toHaveClass("focus-visible:outline-1");
    const pill = screen.getByText("Mine").parentElement as HTMLElement;
    // The dropdown chevron sits inside the pill, right after the name.
    expect(pill.querySelector("[data-menu-chevron]")).not.toBeNull();
    expect(pill).toHaveClass("rounded-1");
    expect(pill).toHaveClass("pl-2", "pr-1");
    expect(pill).toHaveClass("text-muted-foreground");
    expect(pill).toHaveClass("group-hover:state-active");
    expect(pill).toHaveClass("group-hover:text-foreground");
    expect(pill).toHaveClass("group-data-[state=open]:state-active");
    expect(pill).toHaveClass("group-data-[state=open]:text-foreground");
    expect(pill).not.toHaveClass("group-hover:bg-component-fill-hover");
    expect(pill).not.toHaveClass("group-focus-visible:bg-component-fill-hover");
  });

  // The switcher stands in the top row only beside the open sidebar: a
  // collapsed sidebar has none there (DESIGN_SYSTEM.md, «Одно название в
  // ряду»; user's decision of 11.11.2026), so it has one cap and one padding.
  it("keeps one cap and its outer padding toward the search separator, the filter row narrowing its name", async () => {
    render(
      <VaultSwitcher
        currentPath="/Users/test/Mine"
        onVaultSelected={vi.fn()}
        surface="topChrome"
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const trigger = screen.getByRole("button", { name: /Switch space: Mine/ });
    expect(trigger).toHaveClass("pl-[var(--top-collection-pad-x)]", "pr-[var(--top-collection-pad-x)]");
    expect(trigger).not.toHaveClass("pr-0");
    expect(trigger).toHaveClass("max-w-[min(50%,200px)]");
    expect(trigger).not.toHaveClass("max-w-[200px]");
    expect(trigger).toHaveAttribute("data-row-fit-name", "");
  });

  it("lists a space whose folder is gone as unavailable instead of dropping it", async () => {
    commandMocks.listKnownVaults.mockResolvedValue(["/spaces/Mine!"]);
    commandMocks.listSpaces.mockResolvedValue([
      { vault_id: "vault-Mine!", path: "/spaces/Mine!", name: "Mine!", available: true, current: true },
      { vault_id: "vault-NSFV", path: "/spaces/NSFV", name: "NSFV", available: false, current: false },
    ]);
    render(<VaultSwitcher currentPath="/spaces/Mine!" onVaultSelected={vi.fn()} surface="topChrome" />);
    fireEvent.click(screen.getByRole("button", { name: /Switch space: Mine!/ }));
    await waitFor(() => {
      expect(document.querySelector('[data-vault-switcher-unavailable="/spaces/NSFV"]')).toHaveTextContent("NSFV");
    });
    // Not a destination: no menu item switches to it.
    expect(screen.queryByRole("menuitem", { name: "NSFV" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Forget NSFV" })).toBeInTheDocument();
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

  it("lists spaces in the order set in Settings, not by name (А6.10)", async () => {
    commandMocks.listKnownVaults.mockResolvedValue([
      "/tmp/Mine",
      "/tmp/Zebra",
      "/tmp/Alpha",
      "/tmp/Middle",
    ]);
    render(<VaultSwitcher currentPath="/tmp/Mine" onVaultSelected={vi.fn()} surface="topChrome" />);
    await waitFor(() => expect(commandMocks.listKnownVaults).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Switch space: Mine" }));
    await screen.findByRole("menuitem", { name: "Zebra" });

    const names = screen.getAllByRole("menuitem")
      .map((item) => item.textContent?.trim() ?? "")
      .filter((name) => ["Zebra", "Alpha", "Middle"].includes(name));
    expect(names).toEqual(["Zebra", "Alpha", "Middle"]);
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

  // DESIGN_SYSTEM.md, «Ширина» (11.10.2026): a list under a search field has
  // the search width, and the query never changes it.
  it("gives the space list the search width, the same while it is filtered", async () => {
    commandMocks.listKnownVaults.mockResolvedValue(["/tmp/Mine", "/tmp/Журнал", "/tmp/Фотоальбомы"]);

    render(<VaultSwitcher currentPath="/tmp/Mine" onVaultSelected={vi.fn()} surface="topChrome" />);
    await waitFor(() => expect(commandMocks.listKnownVaults).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Switch space: Mine/ }));
    const search = await screen.findByRole("textbox", { name: "Search spaces" });
    const menu = document.querySelector<HTMLElement>("[data-vault-switcher-menu]");
    expect(menu).toHaveAttribute("data-floating-menu", "search");

    fireEvent.change(search, { target: { value: "Фото" } });
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Журнал" })).not.toBeInTheDocument());
    expect(menu).toHaveAttribute("data-floating-menu", "search");
    expect(menu?.style.width).toBe("");
    expect(menu?.style.minWidth).toBe("");
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
    // DESIGN_SYSTEM.md, «Тексты окон»: the folder stays, and the open tabs
    // of the space are the one thing that changes.
    expect(dialog).toHaveAccessibleDescription(
      "The folder and its files stay where they are. Open tabs of this space switch to choosing a space. You can add it back with Add space.",
    );
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

  // Buttons that come up under the pointer answer as Отклик: in on
  // --motion-enter, out on --motion-exit, the response curve
  // (SPEC_MOTION_LEVELS.md, В2; user's decision of 12.11.2026; was 120 ms).
  it("fades the row actions in and out on Отклик's tokens", async () => {
    await openSwitcherWithSpaces();
    const actions = screen.getByRole("button", { name: "Reveal Тест in Finder" }).closest("[data-vault-switcher-row-actions]");
    expect(actions).toHaveClass("transition-opacity", "ease-(--motion-ease)");
    expect(actions?.className).toMatch(/duration-\(--motion-(enter|exit)\)/);
    expect(actions?.className).not.toMatch(/duration-\[|data-motion/);
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

  describe("a space in a new tab (SPEC_TABS.md, В52)", () => {
    const MINE = "/spaces/Mine";
    const TEST = "/spaces/Тест";
    const LEGACY = "/spaces/Old";

    async function openTabSwitcher(onOpenInNewTab?: (vaultId: string) => void) {
      const onVaultSelected = vi.fn();
      commandMocks.selectVault.mockClear();
      commandMocks.listSpaces.mockClear();
      commandMocks.listKnownVaults.mockResolvedValue([MINE, TEST, LEGACY]);
      commandMocks.listSpaces.mockResolvedValue([
        { vault_id: "mine-id", path: MINE, name: "Mine", available: true, current: true },
        { vault_id: "test-id", path: TEST, name: "Тест", available: true, current: false },
        // Known only by its path until it is opened once (В29).
        { vault_id: null, path: LEGACY, name: "Old", available: true, current: false },
      ]);
      render(
        <VaultSwitcher
          currentPath={MINE}
          onVaultSelected={onVaultSelected}
          onOpenInNewTab={onOpenInNewTab}
          surface="topChrome"
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Switch space: Mine" }));
      await screen.findByRole("menuitem", { name: "Тест" });
      await waitFor(() => expect(commandMocks.listSpaces).toHaveBeenCalled());
      return { onVaultSelected };
    }

    it("opens a space in a new tab on ⌘-click and leaves this tab's space alone", async () => {
      const onOpenInNewTab = vi.fn();
      const { onVaultSelected } = await openTabSwitcher(onOpenInNewTab);

      fireEvent.click(screen.getByRole("menuitem", { name: "Тест" }), { metaKey: true });

      await waitFor(() => expect(onOpenInNewTab).toHaveBeenCalledWith("test-id"));
      expect(commandMocks.selectVault).not.toHaveBeenCalled();
      expect(onVaultSelected).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByRole("menuitem", { name: "Тест" })).not.toBeInTheDocument();
      });
    });

    it("keeps a plain choice in this tab", async () => {
      const onOpenInNewTab = vi.fn();
      const { onVaultSelected } = await openTabSwitcher(onOpenInNewTab);

      fireEvent.click(screen.getByRole("menuitem", { name: "Тест" }));

      await waitFor(() => expect(onVaultSelected).toHaveBeenCalledWith(TEST));
      expect(commandMocks.selectVault).toHaveBeenCalledWith(TEST);
      expect(onOpenInNewTab).not.toHaveBeenCalled();
    });

    it("offers Open in New Tab on each space, disabled for a space without an identity", async () => {
      const onOpenInNewTab = vi.fn();
      await openTabSwitcher(onOpenInNewTab);

      const legacy = await screen.findByRole("button", { name: "Open Old in New Tab" });
      await waitFor(() => expect(legacy).toBeDisabled());
      fireEvent.click(screen.getByRole("button", { name: "Open Тест in New Tab" }));

      expect(onOpenInNewTab).toHaveBeenCalledWith("test-id");
      expect(onOpenInNewTab).toHaveBeenCalledTimes(1);
      expect(commandMocks.selectVault).not.toHaveBeenCalled();
    });

    it("opens the active space in a new tab with ⌘Return", async () => {
      const onOpenInNewTab = vi.fn();
      await openTabSwitcher(onOpenInNewTab);
      const search = screen.getByRole("textbox", { name: "Search spaces" });

      fireEvent.keyDown(search, { key: "ArrowDown" });
      fireEvent.keyDown(search, { key: "Enter", metaKey: true });

      await waitFor(() => expect(onOpenInNewTab).toHaveBeenCalledWith("test-id"));
      expect(commandMocks.selectVault).not.toHaveBeenCalled();
    });

    // One tooltip per button, the one written for it; the button's
    // `aria-label` names the space for assistive technology and is not shown
    // as a second tooltip (user's decision of 15.11.2026).
    it.each([
      ["Open Тест in New Tab", "Open in New Tab"],
      ["Reveal Тест in Finder", "Reveal in Finder"],
      ["Remove Тест from the list", "Remove from the list — files stay on disk"],
    ])("shows one tooltip on %s: %s", async (label, text) => {
      await openTabSwitcher(vi.fn());
      const button = screen.getByRole("button", { name: label });
      await waitFor(() => expect(button).toBeEnabled());
      fireEvent.pointerMove(button);
      expect(await screen.findByRole("tooltip")).toHaveTextContent(text);
      // Past any second delay: still the one tooltip, its own text.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 700));
      });
      const tooltips = screen.getAllByRole("tooltip");
      expect(tooltips).toHaveLength(1);
      expect(tooltips[0]).toHaveTextContent(text);
      expect(document.querySelectorAll("[data-slot='tooltip-content']")).toHaveLength(1);
      expect(button).toHaveAttribute("aria-label", label);
    });

    // The next tooltip stands at once, with no appearance, and the one before
    // goes in that frame (SPEC_MOTION_LEVELS.md, М3; user's decision of
    // 15.11.2026): one tooltip at a time, each button's one.
    it("puts Remove from the list's tooltip at once in Reveal in Finder's place", async () => {
      // jsdom runs no animation: the names Radix waits for, as global.css and
      // tw-animate-css give them (src/components/ui/tooltip.test.tsx).
      const animations = document.createElement("style");
      animations.textContent = `
        [data-slot="tooltip-content"] { animation-name: enter; }
        [data-slot="tooltip-content"][data-state="closed"] { animation-name: exit; }
        [data-slot="tooltip-content"][data-state="instant-open"]:not([data-tooltip-message]) { animation-name: none; }
      `;
      document.head.append(animations);
      onTestFinished(() => animations.remove());
      await openTabSwitcher(vi.fn());
      const reveal = screen.getByRole("button", { name: "Reveal Тест in Finder" });
      const remove = screen.getByRole("button", { name: "Remove Тест from the list" });
      const contents = () => Array.from(document.querySelectorAll<HTMLElement>("[data-slot='tooltip-content']"));
      const seen = () => contents().filter((content) => !content.hasAttribute("data-tooltip-replaced"));
      fireEvent.pointerMove(reveal, { clientX: 40, clientY: 12 });
      expect(await screen.findByRole("tooltip")).toHaveTextContent("Reveal in Finder");
      fireEvent.pointerLeave(reveal, { clientX: 54, clientY: 12 });
      fireEvent.pointerMove(reveal.closest("[data-vault-switcher-row-actions]")!, { clientX: 54, clientY: 12 });
      await act(async () => undefined);
      fireEvent.pointerMove(remove, { clientX: 68, clientY: 12 });
      await act(async () => {
        for (let index = 0; index < 3; index += 1) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      expect(seen()).toHaveLength(1);
      expect(seen()[0]).toHaveAttribute("data-state", "instant-open");
      expect(seen()[0]).toHaveTextContent("Remove from the list — files stay on disk");
      expect(getComputedStyle(seen()[0]!).animationName).toBe("none");
    });

    it("has no new tab on a page that is not a tab: ⌘-click switches as before", async () => {
      const { onVaultSelected } = await openTabSwitcher(undefined);

      expect(screen.queryByRole("button", { name: "Open Тест in New Tab" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("menuitem", { name: "Тест" }), { metaKey: true });

      await waitFor(() => expect(onVaultSelected).toHaveBeenCalledWith(TEST));
    });
  });

  // The menu opens 4px under the trigger's plate and flush with its left
  // edge, not with the row-tall box round it (DESIGN_SYSTEM.md, «Отступ от
  // кнопки»; a copied 12 against an 8px inset opened it 4px adrift,
  // 07.10.2026). The wrapper measures it; this trigger brings the plate.
  it("opens its menu off the trigger's plate in the top chrome", async () => {
    commandMocks.listKnownVaults.mockResolvedValue(["/tmp/Mine", "/tmp/Тест"]);
    commandMocks.listSpaces.mockResolvedValue([]);
    // jsdom lays nothing out: floating-ui would read a 0×0 viewport.
    const root = document.documentElement;
    Object.defineProperty(root, "clientWidth", { configurable: true, value: 1024 });
    Object.defineProperty(root, "clientHeight", { configurable: true, value: 768 });
    const original = HTMLElement.prototype.getBoundingClientRect;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      // A 40px row; the plate stands 8px in from the trigger's left edge.
      const box = this.hasAttribute("data-chrome-plate")
        ? { left: 8, right: 88, top: 8, bottom: 32 }
        : this.hasAttribute("data-vault-switcher")
          ? { left: 0, right: 96, top: 0, bottom: 40 }
          : null;
      if (!box) return original.call(this);
      return { ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => ({}) } as DOMRect;
    });
    try {
      render(<VaultSwitcher currentPath="/tmp/Mine" onVaultSelected={vi.fn()} surface="topChrome" />);
      await waitFor(() => expect(commandMocks.listKnownVaults).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: /Switch space: Mine/ }));
      await waitFor(() => {
        const wrapper = document.querySelector<HTMLElement>("[data-radix-popper-content-wrapper]");
        expect(wrapper?.style.transform).toBe("translate(8px, 36px)");
      });
    } finally {
      rect.mockRestore();
      Reflect.deleteProperty(root, "clientWidth");
      Reflect.deleteProperty(root, "clientHeight");
    }
  });

  // A chosen row of the space menu blinks as an item of any other menu does
  // (src/lib/menuBlink.ts; user's decision of 15.11.2026): its highlight out
  // for the first half of 150 ms and back for the second, then the menu
  // closes and the command runs, once, on every level, by a press and by
  // Enter in the field alike.
  describe("the blink of a chosen row (user's decision of 15.11.2026)", () => {
    const MINE = "/spaces/Mine";
    const TEST = "/spaces/Тест";
    const OTHER = "/spaces/Other";
    const HALF = MOTION_MENU_BLINK_MS / 2;
    const FRAME_MS = 1000 / 60;

    beforeEach(() => {
      setMenuBlinkMsForTests(MOTION_MENU_BLINK_MS);
      commandMocks.selectVault.mockClear();
      vi.mocked(openDialog).mockReset();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Opens the menu on real time, then holds the clock: the blink is timed
     *  from here on by the test. */
    async function openBlinkSwitcher(onOpenInNewTab?: (vaultId: string) => void) {
      const onVaultSelected = vi.fn();
      commandMocks.listKnownVaults.mockResolvedValue([MINE, TEST, OTHER]);
      commandMocks.listSpaces.mockResolvedValue([
        { vault_id: "mine-id", path: MINE, name: "Mine", available: true, current: true },
        { vault_id: "test-id", path: TEST, name: "Тест", available: true, current: false },
        { vault_id: "other-id", path: OTHER, name: "Other", available: true, current: false },
      ]);
      render(
        <VaultSwitcher
          currentPath={MINE}
          onVaultSelected={onVaultSelected}
          onOpenInNewTab={onOpenInNewTab}
          surface="topChrome"
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Switch space: Mine" }));
      await screen.findByRole("menuitem", { name: "Тест" });
      // The spaces' identities have come: ⌘ opens a new tab (В52).
      if (onOpenInNewTab) {
        await waitFor(() => expect(screen.getByRole("button", { name: "Open Тест in New Tab" })).toBeEnabled());
      }
      vi.useFakeTimers();
      return { onVaultSelected, search: screen.getByRole("textbox", { name: "Search spaces" }) };
    }

    const row = (name: string) => screen.getByRole("menuitem", { name });
    const menu = () => document.querySelector("[data-vault-switcher-menu]");
    const lit = (name: string) => row(name).getAttribute("data-search-menu-action-active") === "true";

    /** A choice as the menu hears it: a press on the row, or Enter in the
     *  field on the row the arrows reached (`steps` down from the top). */
    function choose(search: HTMLElement, name: string, how: "pointer" | "Enter", steps: number, metaKey = false) {
      if (how === "pointer") {
        fireEvent.click(row(name), { metaKey });
        return;
      }
      // Each key its own event: the field reads the row the last arrow lit.
      for (let step = 0; step < steps; step++) fireEvent.keyDown(search, { key: "ArrowDown" });
      expect(lit(name)).toBe(true);
      fireEvent.keyDown(search, { key: "Enter", metaKey });
    }

    async function advance(ms: number) {
      await act(async () => {
        vi.advanceTimersByTime(ms);
      });
    }

    for (const level of MOTION_LEVELS) {
      for (const how of ["pointer", "Enter"] as const) {
        it(`${level}: a space chosen by ${how} blinks, then the menu closes and the space switches once`, async () => {
          setMotionLevel(level);
          const { onVaultSelected, search } = await openBlinkSwitcher();
          choose(search, "Тест", how, 1);
          // The highlight is out for the first half, the menu still open.
          expect(row("Тест")).toHaveAttribute(MENU_BLINK_ATTRIBUTE);
          expect(commandMocks.selectVault).not.toHaveBeenCalled();
          // The pointer crossing another row does not take the highlight.
          fireEvent.pointerMove(row("Other"));
          await advance(HALF);
          // Back for the second half, on the chosen row and on no other.
          expect(row("Тест")).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
          expect(lit("Тест")).toBe(true);
          expect(lit("Other")).toBe(false);
          expect(commandMocks.selectVault).not.toHaveBeenCalled();
          expect(menu()).not.toBeNull();
          await advance(HALF);
          expect(menu()).toBeNull();
          expect(commandMocks.selectVault).toHaveBeenCalledTimes(1);
          expect(commandMocks.selectVault).toHaveBeenCalledWith(TEST);
          expect(onVaultSelected).toHaveBeenCalledTimes(1);
          expect(onVaultSelected).toHaveBeenCalledWith(TEST);
        });
      }
    }

    for (const how of ["pointer", "Enter"] as const) {
      it(`opens the space in a new tab once after the blink, chosen by ⌘ and ${how}`, async () => {
        const onOpenInNewTab = vi.fn();
        const { search } = await openBlinkSwitcher(onOpenInNewTab);
        choose(search, "Тест", how, 1, true);
        expect(row("Тест")).toHaveAttribute(MENU_BLINK_ATTRIBUTE);
        await advance(HALF);
        expect(onOpenInNewTab).not.toHaveBeenCalled();
        await advance(HALF);
        expect(onOpenInNewTab).toHaveBeenCalledTimes(1);
        expect(onOpenInNewTab).toHaveBeenCalledWith("test-id");
        expect(commandMocks.selectVault).not.toHaveBeenCalled();
        expect(menu()).toBeNull();
      });
    }

    // Two spaces, then Reveal in Finder (3 steps), then Add space (4 steps).
    for (const how of ["pointer", "Enter"] as const) {
      it(`blinks Reveal in Finder chosen by ${how}, then reveals the current space once`, async () => {
        const { search } = await openBlinkSwitcher();
        choose(search, "Reveal in Finder", how, 3);
        expect(row("Reveal in Finder")).toHaveAttribute(MENU_BLINK_ATTRIBUTE);
        await advance(HALF);
        expect(row("Reveal in Finder")).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
        expect(lit("Reveal in Finder")).toBe(true);
        expect(revealItemInDir).not.toHaveBeenCalled();
        await advance(HALF);
        expect(menu()).toBeNull();
        expect(revealItemInDir).toHaveBeenCalledTimes(1);
        expect(revealItemInDir).toHaveBeenCalledWith(MINE);
      });

      it(`blinks Add space chosen by ${how}, then closes the menu and asks for a folder once`, async () => {
        const { search } = await openBlinkSwitcher();
        choose(search, "Add space", how, 4);
        expect(row("Add space")).toHaveAttribute(MENU_BLINK_ATTRIBUTE);
        await advance(HALF);
        expect(row("Add space")).not.toHaveAttribute(MENU_BLINK_ATTRIBUTE);
        expect(lit("Add space")).toBe(true);
        expect(openDialog).not.toHaveBeenCalled();
        await advance(HALF);
        expect(menu()).toBeNull();
        expect(openDialog).toHaveBeenCalledTimes(1);
      });
    }

    it("switches once for a double click and for Enter pressed again during the blink", async () => {
      const { search } = await openBlinkSwitcher();
      choose(search, "Тест", "pointer", 0);
      choose(search, "Тест", "pointer", 0);
      choose(search, "Other", "pointer", 0);
      act(() => {
        fireEvent.keyDown(search, { key: "Enter" });
      });
      await advance(HALF);
      act(() => {
        fireEvent.keyDown(search, { key: "Enter" });
      });
      await advance(HALF);
      expect(commandMocks.selectVault).toHaveBeenCalledTimes(1);
      expect(commandMocks.selectVault).toHaveBeenCalledWith(TEST);
      await advance(MOTION_MENU_BLINK_MS);
      expect(commandMocks.selectVault).toHaveBeenCalledTimes(1);
    });

    it("keeps the query and the list as they were chosen from during the blink", async () => {
      const { search } = await openBlinkSwitcher();
      choose(search, "Тест", "Enter", 1);
      act(() => {
        fireEvent.change(search, { target: { value: "Oth" } });
      });
      expect(search).toHaveValue("");
      expect(row("Тест")).toBeInTheDocument();
      await advance(MOTION_MENU_BLINK_MS);
      expect(commandMocks.selectVault).toHaveBeenCalledWith(TEST);
    });

    it("runs nothing when Escape closes the menu during the blink", async () => {
      const { search } = await openBlinkSwitcher();
      choose(search, "Тест", "pointer", 0);
      act(() => {
        fireEvent.keyDown(search, { key: "Escape" });
      });
      expect(menu()).toBeNull();
      await advance(MOTION_MENU_BLINK_MS * 2);
      expect(commandMocks.selectVault).not.toHaveBeenCalled();
    });

    // The field's Escape (SPEC_KEYBOARD.md, «Ввод текста в меню»): with a
    // query typed the first one clears it and keeps the menu open with the
    // caret in the field; the next one, or one with no query, closes the
    // menu. Radix hears Escape on the document before the field does.
    it("clears a typed query on the first Escape and closes the menu on the second", async () => {
      const { search } = await openBlinkSwitcher();
      fireEvent.change(search, { target: { value: "Oth" } });
      expect(screen.queryByRole("menuitem", { name: "Тест" })).toBeNull();
      fireEvent.keyDown(search, { key: "Escape" });
      expect(menu()).not.toBeNull();
      expect(search).toHaveValue("");
      expect(row("Тест")).toBeInTheDocument();
      // The caret goes back in the next frame (restoreSearchFocus).
      await advance(FRAME_MS);
      expect(search).toHaveFocus();
      fireEvent.keyDown(search, { key: "Escape" });
      expect(menu()).toBeNull();
    });

    it("closes at once on Escape with no query", async () => {
      const { search } = await openBlinkSwitcher();
      fireEvent.keyDown(search, { key: "Escape" });
      expect(menu()).toBeNull();
    });

    it("closes and drops the command on Escape during the blink, a query typed", async () => {
      const { search } = await openBlinkSwitcher();
      fireEvent.change(search, { target: { value: "Тес" } });
      choose(search, "Тест", "Enter", 1);
      fireEvent.keyDown(search, { key: "Escape" });
      expect(menu()).toBeNull();
      await advance(MOTION_MENU_BLINK_MS * 2);
      expect(commandMocks.selectVault).not.toHaveBeenCalled();
    });

    it("runs nothing when the menu closes another way during the blink", async () => {
      const { search } = await openBlinkSwitcher();
      choose(search, "Тест", "pointer", 0);
      // A press outside the menu closes it.
      fireEvent.pointerDown(document.body);
      expect(menu()).toBeNull();
      await advance(MOTION_MENU_BLINK_MS * 2);
      expect(commandMocks.selectVault).not.toHaveBeenCalled();
    });
  });
});

/// SPEC_MENU_WINDOW.md, Г1: with the menu mode Window the space menu opens
/// in the menu panel, the list of spaces as its one widget, and what the
/// list asks comes back to the switcher's own handlers.
describe("the space menu in the menu panel", () => {
  const MINE = "/spaces/Mine";
  const TEST = "/spaces/Тест";
  const LEGACY = "/spaces/Old";
  const GONE = "/spaces/Gone";

  function opens() {
    return vi.mocked(invoke).mock.calls.filter(([command]) => command === "menu_panel_open")
      .map(([, args]) => (args as { request: { opener: unknown; spec: MenuSpec; size: unknown; by_key: boolean } }).request);
  }

  function invokes(name: string) {
    return vi.mocked(invoke).mock.calls.filter(([command]) => command === name).map(([, args]) => args);
  }

  let asked = 0;
  function ask(action: MenuWidgetAction) {
    asked += 1;
    const request = asked;
    act(() => {
      const payload = { menu: 1, seq: request, body: { kind: "action", request, action: { kind: "widget", id: SPACE_LIST_ID, action } } };
      window.dispatchEvent(new CustomEvent(MENU_PANEL_TO_SOURCE_EVENT, { detail: { event: MENU_PANEL_TO_SOURCE_EVENT, payload } }));
    });
  }

  async function openInPanel(onOpenInNewTab?: (vaultId: string) => void) {
    const onVaultSelected = vi.fn();
    commandMocks.listKnownVaults.mockResolvedValue([MINE, TEST, LEGACY]);
    commandMocks.listSpaces.mockResolvedValue([
      { vault_id: "mine-id", path: MINE, name: "Mine", available: true, current: true },
      { vault_id: "test-id", path: TEST, name: "Тест", available: true, current: false },
      { vault_id: null, path: LEGACY, name: "Old", available: true, current: false },
      { vault_id: "gone-id", path: GONE, name: "Gone", available: false, current: false },
    ]);
    render(<VaultSwitcher currentPath={MINE} onVaultSelected={onVaultSelected} onOpenInNewTab={onOpenInNewTab} surface="topChrome" />);
    // The lists are read on mount: the menu opens with them.
    await waitFor(() => expect(commandMocks.listSpaces).toHaveBeenCalled());
    await act(async () => {});
    const trigger = screen.getByRole("button", { name: "Switch space: Mine" });
    fireEvent.click(trigger);
    return { onVaultSelected, trigger };
  }

  beforeEach(() => {
    asked = 0;
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(command === "menu_panel_close" ? { closed: true, key_returned: true } : null));
    window.localStorage.setItem(MENU_MODE_STORAGE_KEY, "window");
    resetMenuPanelSourceForTests(true);
    commandMocks.selectVault.mockReset();
    commandMocks.selectVault.mockResolvedValue(undefined);
    commandMocks.listSpaces.mockClear();
    commandMocks.forgetKnownVault.mockReset();
    commandMocks.forgetKnownVault.mockResolvedValue([]);
    revealItemInDir.mockReset();
    revealItemInDir.mockResolvedValue(undefined);
    vi.mocked(openDialog).mockReset();
  });

  afterEach(() => {
    window.localStorage.removeItem(MENU_MODE_STORAGE_KEY);
    resetMenuPanelSourceForTests();
  });

  it("asks the panel for the list of spaces off the trigger's plate, under it and to its left edge", async () => {
    const { trigger } = await openInPanel(vi.fn());
    expect(opens()).toHaveLength(1);
    expect(opens()[0]?.opener).toEqual({ kind: "plate" });
    expect(opens()[0]?.spec).toEqual(spaceMenuSpec(
      // The space on screen is no destination; a space never opened has no
      // identity and cannot open in a new tab.
      [{ path: TEST, name: "Тест", tab: true }, { path: LEGACY, name: "Old", tab: false }],
      [{ path: GONE, name: "Gone", tab: false }],
      true,
    ));
    // The list at its tallest: the field, eight rows, the pinned actions.
    expect(opens()[0]?.size).toEqual({ width: 300, height: 380 });
    await waitFor(() => expect(trigger.getAttribute("data-state")).toBe("open"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the space the panel chose in a new tab, and takes its menu away", async () => {
    const onOpenInNewTab = vi.fn();
    await openInPanel(onOpenInNewTab);
    ask({ kind: "switch_space", path: TEST, new_tab: true });
    await act(async () => {});
    expect(onOpenInNewTab).toHaveBeenCalledExactlyOnceWith("test-id");
    expect(commandMocks.selectVault).not.toHaveBeenCalled();
    expect(invokes("menu_panel_close")).toEqual([expect.objectContaining({ menu: 1, reason: "source" })]);
  });

  it("opens no tab for a space with no identity", async () => {
    const onOpenInNewTab = vi.fn();
    await openInPanel(onOpenInNewTab);
    ask({ kind: "switch_space", path: LEGACY, new_tab: true });
    await act(async () => {});
    expect(onOpenInNewTab).not.toHaveBeenCalled();
    expect(commandMocks.selectVault).not.toHaveBeenCalled();
  });

  it("goes to the space the panel chose in this tab", async () => {
    const onOpenInNewTab = vi.fn();
    const { onVaultSelected } = await openInPanel(onOpenInNewTab);
    ask({ kind: "switch_space", path: TEST, new_tab: false });
    await waitFor(() => expect(commandMocks.selectVault).toHaveBeenCalledExactlyOnceWith(TEST));
    await waitFor(() => expect(onVaultSelected).toHaveBeenCalledExactlyOnceWith(TEST));
    expect(onOpenInNewTab).not.toHaveBeenCalled();
  });

  it("shows a space's folder and keeps the menu, and takes the menu away for the pinned actions", async () => {
    await openInPanel();
    ask({ kind: "reveal_space", path: TEST });
    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith(TEST));
    expect(invokes("menu_panel_close")).toEqual([]);

    ask({ kind: "reveal_current_space" });
    await waitFor(() => expect(revealItemInDir).toHaveBeenLastCalledWith(MINE));
    expect(invokes("menu_panel_close")).toEqual([expect.objectContaining({ menu: 1, reason: "source" })]);
  });

  it("asks for a folder on Add space, and asks before taking a space off the list", async () => {
    vi.mocked(openDialog).mockResolvedValue(null);
    await openInPanel();
    ask({ kind: "forget_space", path: TEST });
    const dialog = await screen.findByRole("alertdialog");
    expect(commandMocks.forgetKnownVault).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(commandMocks.forgetKnownVault).toHaveBeenCalledWith(TEST));

    ask({ kind: "add_space" });
    await waitFor(() => expect(openDialog).toHaveBeenCalledTimes(1));
  });

  it("sends the panel the list anew when the spaces change under the open menu", async () => {
    await openInPanel();
    await waitFor(() => expect(opens()).toHaveLength(1));
    // A space is taken off the list under the open menu: the panel hears
    // the list without it.
    commandMocks.forgetKnownVault.mockResolvedValue([MINE, TEST]);
    ask({ kind: "forget_space", path: LEGACY });
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      const last = (invokes("menu_panel_update").at(-1) as { spec: MenuSpec } | undefined)?.spec.entries[0];
      expect(last?.kind === "widget" && last.widget.kind === "space_list" && last.widget.spaces.map((space) => space.name)).toEqual(["Тест"]);
    });
  });
});
