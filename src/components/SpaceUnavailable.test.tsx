import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpaceUnavailable } from "./SpaceUnavailable";
import type { SpaceEntry } from "@/types";

const commandMocks = vi.hoisted(() => ({
  listSpaces: vi.fn<() => Promise<SpaceEntry[]>>(),
  selectVault: vi.fn<(path: string) => Promise<void>>(),
  forgetUnavailableVault: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/lib/commands", () => commandMocks);
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

describe("SpaceUnavailable (SPEC_VAULT_LIFECYCLE.md, П12, П25)", () => {
  beforeEach(() => {
    commandMocks.listSpaces.mockResolvedValue([
      { path: "/spaces/Mine", name: "Mine", available: false, current: true },
      { path: "/spaces/NSFV", name: "NSFV", available: true, current: false },
      { path: "/spaces/Old", name: "Old", available: false, current: false },
    ]);
    commandMocks.selectVault.mockResolvedValue(undefined);
  });

  it("lists the other spaces and opens an available one with one click", async () => {
    const onReopened = vi.fn();
    render(<SpaceUnavailable path="/spaces/Mine" onReopened={onReopened} onForgotten={vi.fn()} />);
    const open = await screen.findByRole("button", { name: "Open NSFV" });
    expect(document.querySelector('[data-space-unavailable-other="unavailable"]')).toHaveTextContent("Old");
    expect(screen.queryByRole("button", { name: "Open Old" })).not.toBeInTheDocument();
    // The unavailable space itself is not offered as another space.
    expect(screen.queryByRole("button", { name: "Open Mine" })).not.toBeInTheDocument();
    fireEvent.click(open);
    await waitFor(() => expect(onReopened).toHaveBeenCalledWith("/spaces/NSFV"));
    expect(commandMocks.selectVault).toHaveBeenCalledWith("/spaces/NSFV");
  });

  it("starts a new space instead of looking for the missing folder", () => {
    const onCreateNew = vi.fn();
    render(
      <SpaceUnavailable path="/spaces/Mine" onReopened={vi.fn()} onForgotten={vi.fn()} onCreateNew={onCreateNew} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create new space" }));
    expect(onCreateNew).toHaveBeenCalledOnce();
  });
});
