import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { checkForUpdates, downloadUpdate, getUpdateStatus, installUpdate, restorePreviousUpdate } from "@/lib/commands";
import type { UpdateStatus } from "@/types";
import { UpdatesSection } from "./UpdatesSection";

vi.mock("@/lib/commands", () => ({
  getUpdateStatus: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), installUpdate: vi.fn(), restorePreviousUpdate: vi.fn(),
}));

function state(stage: UpdateStatus["stage"], extra: Partial<UpdateStatus> = {}): UpdateStatus {
  return { stage, version: null, notes: null, downloaded_bytes: 0, total_bytes: null,
    archive_sha256: null, error: null, activation_available: false, ...extra };
}

describe("UpdatesSection", () => {
  beforeEach(() => vi.resetAllMocks());

  it("does not check the network on mount or offer a disabled update channel", async () => {
    vi.mocked(getUpdateStatus).mockResolvedValue(state("disabled"));
    render(<UpdatesSection />);
    expect(await screen.findByText("Updates are not configured for this build.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it("keeps check, download and restart separate and explicitly initiated", async () => {
    vi.mocked(getUpdateStatus).mockResolvedValue(state("idle"));
    vi.mocked(checkForUpdates).mockResolvedValue(state("available", { version: "0.2.0" }));
    vi.mocked(downloadUpdate).mockResolvedValue(state("verified", { version: "0.2.0", activation_available: true }));
    vi.mocked(installUpdate).mockResolvedValue(state("verified", { version: "0.2.0", activation_available: true }));
    render(<UpdatesSection />);
    await screen.findByText("Check for a new version of Mine.");
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    fireEvent.click(await screen.findByRole("button", { name: "Download update" }));
    const restart = await screen.findByRole("button", { name: "Restart and install" });
    expect(installUpdate).not.toHaveBeenCalled();
    fireEvent.click(restart);
    await waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
  });

  it("never offers restart for a verified archive without safe activation", async () => {
    vi.mocked(getUpdateStatus).mockResolvedValue(state("verified", { version: "0.2.0" }));
    render(<UpdatesSection />);
    await screen.findByText("Version 0.2.0 is downloaded and verified.");
    expect(screen.queryByRole("button", { name: "Restart and install" })).not.toBeInTheDocument();
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it("shows verification failure and never claims installation succeeded", async () => {
    vi.mocked(getUpdateStatus).mockResolvedValue(state("available", { version: "0.2.0" }));
    vi.mocked(downloadUpdate).mockRejectedValue({ kind: "signature", detail: "invalid signature" });
    render(<UpdatesSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Download update" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was installed.");
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it("prevents repeated requests while one is pending", async () => {
    vi.mocked(getUpdateStatus).mockResolvedValue(state("idle"));
    vi.mocked(checkForUpdates).mockReturnValue(new Promise(() => {}));
    render(<UpdatesSection />);
    await screen.findByText("Check for a new version of Mine.");
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    fireEvent.click(screen.getByRole("button", { name: "Checking…" }));
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("shows confirmed progress events without allowing another request", async () => {
    vi.mocked(getUpdateStatus).mockResolvedValue(state("idle"));
    render(<UpdatesSection />);
    await screen.findByText("Check for a new version of Mine.");
    act(() => window.dispatchEvent(new CustomEvent("update-status", { detail: { payload:
      state("downloading", { downloaded_bytes: 25, total_bytes: 100 }),
    } })));
    const progress = screen.getByRole("progressbar", { name: "Update download" });
    expect(progress).toHaveAttribute("value", "25");
    expect(progress).toHaveAttribute("max", "100");
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
  });

  it("only restores the previous version after explicit user action", async () => {
    vi.mocked(getUpdateStatus).mockResolvedValue(state("recovery_required"));
    vi.mocked(restorePreviousUpdate).mockResolvedValue(state("restarting"));
    render(<UpdatesSection />);
    const restore = await screen.findByRole("button", { name: "Restore previous version" });
    expect(restorePreviousUpdate).not.toHaveBeenCalled();
    fireEvent.click(restore);
    await screen.findByText("Restarting Mine to finish the update.");
    expect(restorePreviousUpdate).toHaveBeenCalledTimes(1);
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["installing", "Preparing a safe restart."],
    ["restarting", "Restarting Mine to finish the update."],
    ["recovery_required", "The update needs recovery. The previous version has been retained."],
  ] as const)("does not start another update during %s", async (stage, message) => {
    vi.mocked(getUpdateStatus).mockResolvedValue(state(stage, { version: "0.2.0" }));
    render(<UpdatesSection />);
    await screen.findByText(message);
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Restart and install" })).not.toBeInTheDocument();
  });
});
