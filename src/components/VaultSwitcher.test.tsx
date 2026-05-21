import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VaultSwitcher } from "./VaultSwitcher";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@/lib/commands", () => ({
  listKnownVaults: vi.fn(async () => []),
  selectVault: vi.fn(),
}));

describe("VaultSwitcher", () => {
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
    expect(trigger).toHaveClass("px-3");
    expect(trigger).not.toHaveClass("hover:bg-component-fill-hover");
    expect(trigger).not.toHaveClass("focus-visible:outline-1");

    const pill = screen.getByText("Mine").parentElement as HTMLElement;
    expect(pill).toHaveClass("rounded-1");
    expect(pill).toHaveClass("px-2");
    expect(pill).toHaveClass("group-hover:bg-component-fill-hover");
    expect(pill).toHaveClass("group-focus-visible:bg-component-fill-hover");
    expect(pill).toHaveClass("group-data-[state=open]:bg-component-fill-hover");
  });
});
