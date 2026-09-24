import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getCommandOverrides, setCommandOverrides } from "@/lib/commandRegistry";
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

  it("omits fixed structural and system gestures", () => {
    render(<ShortcutsSection />);
    expect(row("navigate")).toBeNull();
    expect(row("settings")).toBeNull();
    expect(screen.queryByText(/Escape cancels recording/)).not.toBeInTheDocument();
  });

  it("captures a chord, previews it and saves only on confirmation", async () => {
    render(<ShortcutsSection />);

    fireEvent.click(within(row("find-elements")).getByRole("button", {
      name: "Change shortcut for Find elements",
    }));
    const capture = within(row("find-elements")).getByRole("button", {
      name: "Enter new shortcut for Find elements",
    });
    expect(capture).toHaveFocus();

    fireEvent.keyDown(capture, { key: "e", code: "KeyE", metaKey: true, altKey: true });
    expect(saveMock).not.toHaveBeenCalled();
    expect(capture).toHaveTextContent("⌥⌘E");
    fireEvent.click(within(row("find-elements")).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith({
        "find-elements": { key: "e", meta: true, shift: false, alt: true, ctrl: false },
      });
    });
    expect(within(row("find-elements")).getByText("⌥⌘E")).toBeInTheDocument();
  });

  it("refuses a chord another command already answers, and says which", async () => {
    render(<ShortcutsSection />);

    fireEvent.click(within(row("copy-path")).getByRole("button", {
      name: "Change shortcut for Copy path",
    }));
    fireEvent.keyDown(within(row("copy-path")).getByRole("button", {
      name: "Enter new shortcut for Copy path",
    }), { key: "k", code: "KeyK", metaKey: true });
    fireEvent.click(within(row("copy-path")).getByRole("button", { name: "Save" }));

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
    fireEvent.keyDown(within(row("copy-path")).getByRole("button", {
      name: "Enter new shortcut for Copy path",
    }), { key: "j", code: "KeyJ" });
    fireEvent.click(within(row("copy-path")).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(row("copy-path").querySelector("[data-shortcut-error]"))
        .toHaveTextContent("swallow typing");
    });
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("closes the editor on Escape without binding it", async () => {
    render(<ShortcutsSection />);

    fireEvent.click(within(row("copy-path")).getByRole("button", {
      name: "Change shortcut for Copy path",
    }));
    fireEvent.keyDown(within(row("copy-path")).getByRole("button", {
      name: "Enter new shortcut for Copy path",
    }), { key: "Escape" });

    await waitFor(() => {
      expect(within(row("copy-path")).getByText("⌘L")).toBeInTheDocument();
    });
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("filters commands and leaves no empty groups", () => {
    render(<ShortcutsSection />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search shortcuts" }), {
      target: { value: "Copy path" },
    });
    expect(row("copy-path")).toBeInTheDocument();
    expect(row("find-elements")).toBeNull();
    expect(document.querySelectorAll("[data-shortcuts-group]")).toHaveLength(1);
  });

  it("keeps the old binding when saving fails", async () => {
    saveMock.mockRejectedValueOnce(new Error("disk unavailable"));
    render(<ShortcutsSection />);
    fireEvent.click(within(row("find-elements")).getByRole("button", {
      name: "Change shortcut for Find elements",
    }));
    fireEvent.keyDown(within(row("find-elements")).getByRole("button", {
      name: "Enter new shortcut for Find elements",
    }), { key: "e", code: "KeyE", metaKey: true });
    fireEvent.click(within(row("find-elements")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(row("find-elements")).getByRole("alert"))
      .toHaveTextContent("Could not save"));
    expect(getCommandOverrides()).toEqual({});
    expect(within(row("find-elements")).getByText("⌘F")).toBeInTheDocument();
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
