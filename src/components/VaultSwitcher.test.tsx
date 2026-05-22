import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VaultSwitcher } from "./VaultSwitcher";

const commandMocks = vi.hoisted(() => ({
  listKnownVaults: vi.fn<() => Promise<string[]>>(),
  selectVault: vi.fn<() => Promise<void>>(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@/lib/commands", () => ({
  listKnownVaults: commandMocks.listKnownVaults,
  selectVault: commandMocks.selectVault,
}));

describe("VaultSwitcher", () => {
  beforeEach(() => {
    commandMocks.listKnownVaults.mockResolvedValue([]);
    commandMocks.selectVault.mockResolvedValue(undefined);
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
    expect(trigger).not.toHaveClass("hover:bg-component-fill-hover");
    expect(trigger).not.toHaveClass("focus-visible:outline-1");
    expect(trigger.querySelector("svg")).toBeNull();

    const pill = screen.getByText("Mine").parentElement as HTMLElement;
    expect(pill).toHaveClass("rounded-1");
    expect(pill).toHaveClass("px-2");
    expect(pill).toHaveClass("group-hover:bg-active");
    expect(pill).toHaveClass("group-data-[state=open]:bg-active");
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

  it("omits the current space and icon markers from the top-chrome dropdown", async () => {
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

    expect(screen.queryByRole("menuitem", { name: "Mine" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Тест" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Add space" })).toBeInTheDocument();
    expect(document.querySelector("[data-slot='dropdown-menu-content']")?.querySelector("svg")).toBeNull();
  });
});
