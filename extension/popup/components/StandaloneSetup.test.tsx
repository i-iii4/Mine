import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StandaloneSetup } from "./StandaloneSetup";

vi.mock("../lib/standalone", () => ({ openDownloadPage: vi.fn(async () => ({ ok: true })) }));
vi.mock("./ClipperOverflowMenu", () => ({ ClipperOverflowMenu: () => null }));

describe("standalone setup", () => {
  it("offers the folder action directly in an overlay without claiming the app is absent", async () => {
    const choose = vi.fn(async () => ({ ok: true }));
    render(<StandaloneSetup canPickFolder={false} folderName={null} diagnosis="Helper connection rejected" onChooseFolder={choose} onRegrantAccess={choose} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => expect(choose).toHaveBeenCalledOnce());
    expect(screen.getByText("Helper connection rejected")).toBeVisible();
    expect(screen.queryByText(/click the Mine icon/)).toBeNull();
    expect(screen.queryByText(/not installed/)).toBeNull();
  });

  it("keeps recovery available after a permission API rejects", async () => {
    const regrant = vi.fn(async () => { throw new Error("Folder no longer exists"); });
    render(<StandaloneSetup canPickFolder folderName="Mine" onChooseFolder={vi.fn()} onRegrantAccess={regrant} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow access" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Folder no longer exists"));
    expect(screen.getByRole("button", { name: "Allow access" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Choose folder…" })).toBeEnabled();
  });
});
