import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const shortcut = (command: string) => within(row(command)).getByRole("button", {
  name: /^(Change|Press new) shortcut for/i,
});

describe("ShortcutsSection", () => {
  beforeEach(() => {
    setCommandOverrides({});
    saveMock.mockReset().mockResolvedValue(null);
  });

  it("groups editable commands in compact rows with the shared shortcut button style", () => {
    render(<ShortcutsSection />);
    expect(document.querySelector("[data-shortcuts-section]")).toHaveClass("max-w-[720px]");
    for (const context of ["global", "feed", "element", "selection"]) {
      expect(document.querySelector(`[data-shortcuts-group="${context}"]`)).toBeInTheDocument();
    }
    expect(row("find-elements")).toHaveClass("min-h-10", "flex");
    expect(row("find-elements")).not.toHaveClass("grid");
    expect(shortcut("find-elements")).toHaveAttribute("data-variant", "default");
    expect(shortcut("find-elements")).toHaveAttribute("data-size", "xs");
    expect(shortcut("find-elements")).toHaveClass("h-5", "bg-component-fill", "text-muted-foreground");
    expect(shortcut("find-elements")).toHaveClass("hover:outline-1", "hover:text-foreground");
    expect(shortcut("find-elements")).not.toHaveClass("hover:bg-active", "border-border");
    expect(shortcut("find-elements")).not.toHaveClass("w-28");
  });

  it("hides fixed gestures and uses the binding itself as the editor control", () => {
    render(<ShortcutsSection />);
    expect(row("navigate")).toBeNull();
    expect(row("settings")).toBeNull();
    expect(shortcut("find-elements")).toHaveTextContent("⌘F");
    expect(within(row("find-elements")).queryByText("Change")).not.toBeInTheDocument();
  });

  it("records a valid combination in the same row and saves it immediately", async () => {
    render(<ShortcutsSection />);
    fireEvent.click(shortcut("find-elements"));
    expect(shortcut("find-elements")).toHaveFocus();
    expect(shortcut("find-elements")).toHaveAttribute("aria-pressed", "true");
    expect(shortcut("find-elements")).toHaveClass("bg-active", "text-foreground");
    expect(shortcut("find-elements")).toHaveTextContent("Press keys");
    expect(row("find-elements").querySelector("[data-shortcut-editor]")).toBeNull();

    fireEvent.keyDown(shortcut("find-elements"), {
      key: "e", code: "KeyE", metaKey: true, altKey: true,
    });

    await waitFor(() => expect(saveMock).toHaveBeenCalledWith({
      "find-elements": { key: "e", meta: true, shift: false, alt: true, ctrl: false },
    }));
    await waitFor(() => expect(shortcut("find-elements")).toHaveTextContent("⌥⌘E"));
    expect(shortcut("find-elements")).toHaveFocus();
    expect(shortcut("find-elements")).toHaveAttribute("aria-pressed", "false");
  });

  it("shows the owner of a conflicting shortcut without changing either command", () => {
    render(<ShortcutsSection />);
    fireEvent.click(shortcut("copy-path"));
    fireEvent.keyDown(shortcut("copy-path"), { key: "k", code: "KeyK", metaKey: true });

    expect(within(row("copy-path")).getByRole("alert")).toHaveTextContent("Command");
    expect(shortcut("copy-path")).toHaveAttribute("aria-pressed", "true");
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("rejects bare and system keys beside the active command", () => {
    render(<ShortcutsSection />);
    fireEvent.click(shortcut("copy-path"));
    fireEvent.keyDown(shortcut("copy-path"), { key: "j", code: "KeyJ" });
    expect(within(row("copy-path")).getByRole("alert")).toHaveTextContent("Add ⌘");

    fireEvent.keyDown(shortcut("copy-path"), { key: "q", code: "KeyQ", metaKey: true });
    expect(within(row("copy-path")).getByRole("alert")).toHaveTextContent("macOS");
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("does not dispatch a recorded key to the surrounding settings surface", () => {
    const onKeyDown = vi.fn();
    render(<div onKeyDown={onKeyDown}><ShortcutsSection /></div>);
    fireEvent.click(shortcut("copy-path"));
    fireEvent.keyDown(shortcut("copy-path"), { key: "Meta", code: "MetaLeft", metaKey: true });
    fireEvent.keyDown(shortcut("copy-path"), { key: "q", code: "KeyQ", metaKey: true });
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it("cancels with Escape or on focus loss, and lets Tab navigate", () => {
    render(<ShortcutsSection />);
    fireEvent.click(shortcut("copy-path"));
    fireEvent.keyDown(shortcut("copy-path"), { key: "Escape" });
    expect(shortcut("copy-path")).toHaveTextContent("⌘L");

    fireEvent.click(shortcut("copy-path"));
    expect(fireEvent.keyDown(shortcut("copy-path"), { key: "Tab" })).toBe(true);
    fireEvent.blur(shortcut("copy-path"));
    expect(shortcut("copy-path")).toHaveAttribute("aria-pressed", "false");
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("edits only one command at a time", () => {
    render(<ShortcutsSection />);
    fireEvent.click(shortcut("find-elements"));
    fireEvent.click(shortcut("copy-path"));
    expect(shortcut("find-elements")).toHaveAttribute("aria-pressed", "false");
    expect(shortcut("copy-path")).toHaveAttribute("aria-pressed", "true");
  });

  it("filters on actual typing by command names and key names", async () => {
    const user = userEvent.setup();
    render(<ShortcutsSection />);
    const search = screen.getByRole("searchbox", { name: "Search shortcuts" });
    await user.click(search);
    await user.type(search, "Copy path");
    expect(row("copy-path")).toBeInTheDocument();
    expect(row("find-elements")).toBeNull();
    expect(document.querySelectorAll("[data-shortcuts-group]")).toHaveLength(1);

    await user.clear(search);
    await user.type(search, "cmd+f");
    expect(row("find-elements")).toBeInTheDocument();
    expect(row("copy-path")).toBeNull();

    await user.clear(search);
    await user.type(search, "⌘L");
    expect(row("copy-path")).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "find cmd");
    expect(row("find-elements")).toBeInTheDocument();
    expect(row("copy-path")).toBeNull();

    await user.clear(search);
    await user.type(search, "nothing matches");
    expect(screen.getByText("No matching commands.")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-shortcut-row]")).toHaveLength(0);
  });

  it("keeps the old binding and editing focus when persistence fails", async () => {
    saveMock.mockRejectedValueOnce(new Error("disk unavailable"));
    render(<ShortcutsSection />);
    fireEvent.click(shortcut("find-elements"));
    fireEvent.keyDown(shortcut("find-elements"), { key: "e", code: "KeyE", metaKey: true });

    await waitFor(() => expect(within(row("find-elements")).getByRole("alert"))
      .toHaveTextContent("Could not save"));
    expect(getCommandOverrides()).toEqual({});
    expect(shortcut("find-elements")).toHaveFocus();
    expect(shortcut("find-elements")).toHaveAttribute("aria-pressed", "true");
  });

  it("restores one default or all defaults without showing reset on unchanged rows", async () => {
    setCommandOverrides({ "find-elements": { key: "e", meta: true, alt: true } });
    render(<ShortcutsSection />);

    expect(within(row("copy-path")).queryByRole("button", { name: /Reset shortcut/ })).toBeNull();
    const resetButton = within(row("find-elements")).getByRole("button", {
      name: "Reset shortcut for Find elements",
    });
    expect(resetButton.parentElement).toContainElement(within(row("find-elements")).getByText("Find elements"));
    expect(resetButton).toHaveAttribute("data-variant", "secondary");
    expect(resetButton).toHaveAttribute("data-size", "xs");
    expect(screen.getByRole("button", { name: "Reset all" })).toHaveAttribute("data-size", "xs");
    fireEvent.click(resetButton);
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith({}));

    act(() => setCommandOverrides({ "copy-path": { key: "p", meta: true, alt: true } }));
    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    await waitFor(() => expect(saveMock).toHaveBeenLastCalledWith({}));
  });

  it("removes a customization when the default combination is entered again", async () => {
    setCommandOverrides({ "find-elements": { key: "e", meta: true, alt: true } });
    render(<ShortcutsSection />);
    fireEvent.click(shortcut("find-elements"));
    fireEvent.keyDown(shortcut("find-elements"), { key: "f", code: "KeyF", metaKey: true });
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith({}));
    expect(within(row("find-elements")).queryByRole("button", { name: /Reset shortcut/ })).toBeNull();
  });

  it("records the physical digit for a shifted number key", async () => {
    render(<ShortcutsSection />);
    fireEvent.click(shortcut("copy-path"));
    fireEvent.keyDown(shortcut("copy-path"), {
      key: "!", code: "Digit1", metaKey: true, shiftKey: true,
    });
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith({
      "copy-path": { key: "1", meta: true, shift: true, alt: false, ctrl: false },
    }));
  });
});
