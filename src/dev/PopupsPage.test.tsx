// The page of every modal window (DESIGN_SYSTEM.md, «Окна»): one frame per
// window, and each frame shows its one window open. New collection is one
// window for every path (SPEC_DEEP_AUDIT.md, Е6.2); Remove space is the one
// shared window (Е6.9).
import { render, screen } from "@testing-library/react";
import { PopupsPage } from "./PopupsPage";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("PopupsPage", () => {
  it("lays out one frame per window, with one New collection window for every path", () => {
    window.history.replaceState(null, "", "/__popups");
    render(<PopupsPage />);

    expect(screen.getByRole("heading", { name: "Windows" })).toBeInTheDocument();
    const frame = screen.getByTitle("New collection (CreateCollectionDialog, every path)");
    expect(frame).toHaveAttribute("src", "/__popups?popup=create-collection");
    expect(screen.queryByText(/TopCollectionSwitcher/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("figure").length).toBe(document.querySelectorAll("iframe").length);
  });

  it("opens the New collection window with its name typed", async () => {
    window.history.replaceState(null, "", "/__popups?popup=create-collection");
    render(<PopupsPage />);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/collection/i);
    expect(screen.getByDisplayValue("Typography")).toBeInTheDocument();
  });

  it("opens the shared Remove space window for the space's folder", async () => {
    window.history.replaceState(null, "", "/__popups?popup=remove-space");
    render(<PopupsPage />);

    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Remove References from the list?");
  });
});
