import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { VaultPicker } from "./VaultPicker";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

const mockInvoke = vi.mocked(invoke);
const mockOpen = vi.mocked(open);

/// Route invokes by command name.
function mockCommands(overrides: Record<string, unknown>) {
  mockInvoke.mockImplementation((command: string) => {
    if (command in overrides) {
      const value = overrides[command];
      return value instanceof Error
        ? Promise.reject(value)
        : Promise.resolve(value);
    }
    return Promise.resolve(undefined);
  });
}

describe("VaultPicker (SPEC_ONBOARDING.md, О9 to О12)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers the way back only when opened from another screen (А6.7)", () => {
    const { unmount } = render(<VaultPicker onVaultSelected={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    unmount();
    const onBack = vi.fn();
    render(<VaultPicker onVaultSelected={vi.fn()} onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("says one thing in the interface's own size, aligned to the start", () => {
    const { container } = render(<VaultPicker onVaultSelected={vi.fn()} />);
    const lines = container.querySelectorAll("p");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent("Mine keeps your cards as files in a folder.");
    expect(lines[0]).toHaveClass("text-sm", "text-foreground");
    expect(container.querySelector(".text-center, .items-center.flex-col")).toBeNull();
  });

  it("does nothing when the dialog is cancelled", async () => {
    const onSelected = vi.fn();
    mockOpen.mockResolvedValue(null as never);
    render(<VaultPicker onVaultSelected={onSelected} />);

    fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));

    await waitFor(() => expect(mockOpen).toHaveBeenCalled());
    expect(onSelected).not.toHaveBeenCalled();
  });

  it("opens the chosen folder at once, with no confirmation step", async () => {
    const onSelected = vi.fn();
    mockOpen.mockResolvedValue("/test/Documents" as never);
    mockCommands({ selection_generation: 7, select_vault: { indexed: 0, errors: 0 } });
    render(<VaultPicker onVaultSelected={onSelected} />);

    fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));

    // The system dialog is the decision; the first index shows what the
    // folder holds and offers another one (О12, О13).
    await waitFor(() => expect(onSelected).toHaveBeenCalledWith("/test/Documents"));
    // The choice carries its place in the page's order (SPEC_TABS.md, В10).
    expect(mockInvoke).toHaveBeenCalledWith("select_vault", {
      path: "/test/Documents",
      stamp: { generation: expect.any(Number), sequence: expect.any(Number) },
    });
    expect(
      mockInvoke.mock.calls.map(([command]) => command).filter((command) => command !== "selection_generation"),
    ).toEqual(["select_vault"]);
  });

  it("shows an error when opening fails", async () => {
    mockOpen.mockResolvedValue("/test/vault" as never);
    mockCommands({ select_vault: new Error("DB error") });
    render(<VaultPicker onVaultSelected={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));

    await waitFor(() => expect(screen.getByText(/DB error/)).toBeInTheDocument());
  });
});
