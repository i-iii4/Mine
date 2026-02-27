import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { VaultPicker } from "./VaultPicker";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

const mockInvoke = vi.mocked(invoke);
const mockOpen = vi.mocked(open);

describe("VaultPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders heading and button", () => {
    render(<VaultPicker onVaultSelected={vi.fn()} />);
    expect(screen.getByText("Local Arena")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Select Vault" }),
    ).toBeInTheDocument();
  });

  it("renders description text", () => {
    render(<VaultPicker onVaultSelected={vi.fn()} />);
    expect(
      screen.getByText(/Choose a folder for your vault/),
    ).toBeInTheDocument();
  });

  it("does nothing when dialog cancelled", async () => {
    const onSelected = vi.fn();
    mockOpen.mockResolvedValue(null as never);
    render(<VaultPicker onVaultSelected={onSelected} />);
    fireEvent.click(screen.getByRole("button", { name: "Select Vault" }));
    await waitFor(() => {
      expect(mockOpen).toHaveBeenCalled();
    });
    expect(onSelected).not.toHaveBeenCalled();
  });

  it("shows scan result after selecting vault", async () => {
    mockOpen.mockResolvedValue("/test/vault" as never);
    mockInvoke.mockResolvedValue({ indexed: 42, errors: 0 });
    render(<VaultPicker onVaultSelected={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Select Vault" }));
    await waitFor(() => {
      expect(screen.getByText("42")).toBeInTheDocument();
    });
  });

  it("shows error on scan failure", async () => {
    mockOpen.mockResolvedValue("/test/vault" as never);
    mockInvoke.mockRejectedValue(new Error("DB error"));
    render(<VaultPicker onVaultSelected={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Select Vault" }));
    await waitFor(() => {
      expect(screen.getByText(/DB error/)).toBeInTheDocument();
    });
  });
});
