import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { switchStorage } from "../../lib/feedButtonSwitch.fixtures";
import { ClipperOverflowMenu } from "./ClipperOverflowMenu";
const send = vi.hoisted(() => vi.fn().mockResolvedValue({ok:true}));
vi.mock("../lib/messaging", () => ({sendToNative: send}));

function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "More" }), { button: 0, pointerId: 1 });
}

it("passes the selected space, not the desktop's previous binding", async () => {
  render(<ClipperOverflowMenu canOpenApp vaultPath="/tmp/Моё пространство" />);
  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", {name:"Open app"}));
  await waitFor(() => expect(send).toHaveBeenCalledWith({action:"open_app",path:"/tmp/Моё пространство"}));
});

// SPEC_CLIPPER.md, «Доработки после живого просмотра», пункт 5 и Р11.
describe("the switches of the Mine buttons on X and Instagram", () => {
  let storage: ReturnType<typeof switchStorage> & { local: { set: ReturnType<typeof vi.fn> } };
  let stored: Record<string, unknown>;

  beforeEach(() => {
    stored = {};
    const base = switchStorage(stored);
    storage = { ...base, local: { ...base.local, set: vi.fn(async (values: Record<string, unknown>) => { base.set(values.mineFeedButtons); }) } };
    vi.stubGlobal("chrome", { storage });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows both on until they are turned off, and keeps the menu open on a switch", async () => {
    render(<ClipperOverflowMenu canOpenApp />);
    openMenu();
    const x = await screen.findByRole("menuitemcheckbox", { name: "Mine on X" });
    expect(x).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemcheckbox", { name: "Mine on Instagram" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(x);
    await waitFor(() => expect(storage.local.set).toHaveBeenCalledWith({ mineFeedButtons: { x: false, instagram: true } }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Mine on X" })).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Mine on Instagram" }));
    await waitFor(() => expect(storage.local.set).toHaveBeenLastCalledWith({ mineFeedButtons: { x: false, instagram: false } }));
  });

  it("shows what is stored and what another tab changes", async () => {
    stored.mineFeedButtons = { x: false, instagram: true };
    render(<ClipperOverflowMenu canOpenApp />);
    openMenu();
    await waitFor(() => expect(screen.getByRole("menuitemcheckbox", { name: "Mine on X" })).toHaveAttribute("aria-checked", "false"));
    act(() => storage.set({ x: true, instagram: false }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Mine on X" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemcheckbox", { name: "Mine on Instagram" })).toHaveAttribute("aria-checked", "false");
  });

  it("says why a switch could not be kept", async () => {
    storage.local.set.mockRejectedValueOnce(new Error("Storage is full"));
    render(<ClipperOverflowMenu canOpenApp />);
    openMenu();
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Mine on X" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Storage is full");
  });
});
