import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getStatus, getBoundStatus, choose, regrant, notify } = vi.hoisted(() => ({
  getStatus: vi.fn(), getBoundStatus: vi.fn(), choose: vi.fn(), regrant: vi.fn(), notify: vi.fn(),
}));
vi.mock("../lib/standalone", () => ({
  canPickFolderHere: () => true, getStandaloneStatus: getStatus, getBoundFolderStatus: getBoundStatus,
  chooseStandaloneFolder: choose, regrantStandaloneAccess: regrant,
  notifyStandaloneFolderChanged: notify, openDownloadPage: vi.fn(),
}));
vi.mock("./ClipperOverflowMenu", () => ({ ClipperOverflowMenu: () => null }));
import { FolderSetupPage } from "./FolderSetupPage";

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState({}, "", "/?mode=setup");
  getStatus.mockResolvedValue({ configured: false });
  notify.mockResolvedValue({ ok: true });
});

describe("extension-origin folder setup page", () => {
  it("notifies the original clip after a granted folder is stored", async () => {
    choose.mockResolvedValue({ configured: true, folderName: "Clips", permission: "granted", bindingId: "chosen" });
    render(<FolderSetupPage />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Choose folder…" })); });
    expect(choose).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(undefined);
    expect(screen.getByText("“Clips” is ready.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Return to clip" })).toBeEnabled();
  });

  it("restores only the original binding and cannot replace its folder", async () => {
    window.history.replaceState({}, "", "/?mode=setup&binding_id=original");
    getBoundStatus.mockResolvedValue({ configured: true, folderName: "Original", permission: "prompt", bindingId: "original" });
    regrant.mockResolvedValue({ configured: true, folderName: "Original", permission: "granted", bindingId: "original" });
    render(<FolderSetupPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Allow access" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Choose folder…" })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Allow access" })); });
    expect(getBoundStatus).toHaveBeenCalledWith("original");
    expect(regrant).toHaveBeenCalledWith("original");
    expect(notify).toHaveBeenCalledWith("original");
    expect(choose).not.toHaveBeenCalled();
  });
});
