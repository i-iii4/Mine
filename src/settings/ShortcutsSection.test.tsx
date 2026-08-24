import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { setCommandOverrides } from "@/lib/commandRegistry";
import { ShortcutsSection } from "./ShortcutsSection";

const saveMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));

vi.mock("@/lib/commands", () => ({
  listShortcutOverrides: vi.fn().mockResolvedValue({}),
  saveShortcutOverrides: saveMock,
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

const row = (command: string) =>
  document.querySelector(`[data-shortcut-row="${command}"]`) as HTMLElement;

describe("ShortcutsSection", () => {
  beforeEach(() => {
    setCommandOverrides({});
    saveMock.mockClear();
  });

  it("groups commands by the surface they belong to", () => {
    render(<ShortcutsSection />);

    for (const context of ["global", "feed", "element", "selection"]) {
      expect(document.querySelector(`[data-shortcuts-group="${context}"]`)).toBeInTheDocument();
    }
    expect(within(row("find-elements")).getByText("Find elements")).toBeInTheDocument();
  });

  it("shows a structural key as a plain label with no way to change it", () => {
    // Arrows, Enter, Escape and Tab are how the interface is driven.
    render(<ShortcutsSection />);

    const navigate = row("navigate");
    expect(navigate.querySelector("[data-shortcut-fixed='structural']")).toBeInTheDocument();
    expect(within(navigate).queryByRole("button")).toBeNull();
  });

  it("keeps ⌘, as the system expects it", () => {
    render(<ShortcutsSection />);

    const settings = row("settings");
    expect(settings.querySelector("[data-shortcut-fixed='system']")).toHaveTextContent("⌘,");
    expect(within(settings).queryByRole("button")).toBeNull();
  });

  it("records a chord from a real key press and saves it", async () => {
    render(<ShortcutsSection />);

    fireEvent.click(within(row("find-elements")).getByRole("button", {
      name: "Change shortcut for Find elements",
    }));
    expect(within(row("find-elements")).getByText("Press keys…")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "e", code: "KeyE", metaKey: true, altKey: true });

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith({
        "find-elements": { key: "e", meta: true, shift: false, alt: true, ctrl: false },
      });
    });
    expect(within(row("find-elements")).getByText("changed")).toBeInTheDocument();
  });

  it("refuses a chord another command already answers, and says which", async () => {
    render(<ShortcutsSection />);

    fireEvent.click(within(row("copy-path")).getByRole("button", {
      name: "Change shortcut for Copy path",
    }));
    fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });

    await waitFor(() => {
      expect(row("copy-path").querySelector("[data-shortcut-error]")).toHaveTextContent("Command");
    });
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("refuses a bare key", async () => {
    render(<ShortcutsSection />);

    fireEvent.click(within(row("copy-path")).getByRole("button", {
      name: "Change shortcut for Copy path",
    }));
    fireEvent.keyDown(window, { key: "j", code: "KeyJ" });

    await waitFor(() => {
      expect(row("copy-path").querySelector("[data-shortcut-error]"))
        .toHaveTextContent("swallow typing");
    });
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("cancels recording on Escape without binding it", async () => {
    render(<ShortcutsSection />);

    fireEvent.click(within(row("copy-path")).getByRole("button", {
      name: "Change shortcut for Copy path",
    }));
    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(within(row("copy-path")).getByText("⌘L")).toBeInTheDocument();
    });
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("resets one command and all of them", async () => {
    setCommandOverrides({ "find-elements": { key: "e", meta: true, alt: true } });
    render(<ShortcutsSection />);

    fireEvent.click(within(row("find-elements")).getByRole("button", {
      name: "Reset shortcut for Find elements",
    }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith({}));

    saveMock.mockClear();
    setCommandOverrides({ "copy-path": { key: "p", meta: true, alt: true } });
    render(<ShortcutsSection />);
    fireEvent.click(screen.getAllByRole("button", { name: "Reset all" })[0]!);
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith({}));
  });
});
