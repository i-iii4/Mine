import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { VaultPicker } from "./VaultPicker";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

const mockInvoke = vi.mocked(invoke);
const mockOpen = vi.mocked(open);

const EMPTY_FOLDER = { markdown_files: 0, media_files: 0, other_files: 0 };
const BUSY_FOLDER = { markdown_files: 120, media_files: 40, other_files: 3 };

/// Route invokes by command name: the picker inspects a folder before opening
/// it, so a single blanket mock cannot express both steps.
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

describe("VaultPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("explains the product before asking for a decision", () => {
    render(<VaultPicker onVaultSelected={vi.fn()} />);
    expect(screen.getByText("Mine")).toBeInTheDocument();
    // The three things worth knowing before choosing a folder.
    expect(screen.getByText(/Every card is a file/)).toBeInTheDocument();
    expect(screen.getByText(/Every collection is an ordinary note/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is uploaded/)).toBeInTheDocument();
  });

  it("warns that macOS will ask for folder permission", () => {
    render(<VaultPicker onVaultSelected={vi.fn()} />);
    expect(screen.getByText(/macOS will ask for permission/)).toBeInTheDocument();
  });

  it("does nothing when the dialog is cancelled", async () => {
    const onSelected = vi.fn();
    mockOpen.mockResolvedValue(null as never);
    render(<VaultPicker onVaultSelected={onSelected} />);

    fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));

    await waitFor(() => expect(mockOpen).toHaveBeenCalled());
    expect(onSelected).not.toHaveBeenCalled();
  });

  it("opens an empty folder without asking twice", async () => {
    const onSelected = vi.fn();
    mockOpen.mockResolvedValue("/test/vault" as never);
    mockCommands({
      preview_vault_folder: EMPTY_FOLDER,
      select_vault: { indexed: 0, errors: 0 },
    });
    render(<VaultPicker onVaultSelected={onSelected} />);

    fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));

    // Nothing to lose, nothing to confirm.
    await waitFor(() => expect(onSelected).toHaveBeenCalledWith("/test/vault"));
  });

  it("confirms before turning a folder full of files into a space", async () => {
    const onSelected = vi.fn();
    mockOpen.mockResolvedValue("/test/Documents" as never);
    mockCommands({
      preview_vault_folder: BUSY_FOLDER,
      select_vault: { indexed: 160, errors: 0 },
    });
    render(<VaultPicker onVaultSelected={onSelected} />);

    fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));

    // Picking the wrong folder has no undo, so the counts are shown first.
    expect(await screen.findByText(/Open “Documents” as a space\?/)).toBeInTheDocument();
    expect(screen.getByText(/120 notes and 40 media files/)).toBeInTheDocument();
    expect(screen.getByText(/does not change their contents/)).toBeInTheDocument();
    expect(onSelected).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /open as space/i }));
    await waitFor(() => expect(onSelected).toHaveBeenCalledWith("/test/Documents"));
  });

  it("lets the user back out of a folder full of files", async () => {
    const onSelected = vi.fn();
    mockOpen.mockResolvedValue("/test/Documents" as never);
    mockCommands({ preview_vault_folder: BUSY_FOLDER });
    render(<VaultPicker onVaultSelected={onSelected} />);

    fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));
    fireEvent.click(await screen.findByRole("button", { name: /choose another/i }));

    expect(screen.getByRole("button", { name: /choose folder/i })).toBeInTheDocument();
    expect(onSelected).not.toHaveBeenCalled();
  });

  it("shows the scan result after opening a space", async () => {
    mockOpen.mockResolvedValue("/test/vault" as never);
    mockCommands({
      preview_vault_folder: EMPTY_FOLDER,
      select_vault: { indexed: 42, errors: 0 },
    });
    render(<VaultPicker onVaultSelected={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));

    await waitFor(() => expect(screen.getByText("42")).toBeInTheDocument());
  });

  it("shows an error when opening fails", async () => {
    mockOpen.mockResolvedValue("/test/vault" as never);
    mockCommands({
      preview_vault_folder: EMPTY_FOLDER,
      select_vault: new Error("DB error"),
    });
    render(<VaultPicker onVaultSelected={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));

    await waitFor(() => expect(screen.getByText(/DB error/)).toBeInTheDocument());
  });
});
