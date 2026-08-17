// The showcase's own guard.
//
// The section exists so nobody has to reproduce a missing folder or an evicted
// file to review those screens. If it stops rendering — a renamed prop, a
// component that now needs a live vault — the states quietly disappear and the
// acceptance rule silently stops holding. See DESIGN_SYSTEM.md, «Витрина
// состояний и краёв».

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EdgeStatesSection } from "./EdgeStatesSection";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/commands", () => ({
  forgetUnavailableVault: vi.fn(),
  selectVault: vi.fn(),
}));

describe("EdgeStatesSection", () => {
  it("draws the states nobody can produce on demand", () => {
    const { container } = render(<EdgeStatesSection />);

    // Screens that need a vault in a particular condition — including the
    // locked-folder variant, whose only live trigger is a macOS refusal.
    expect(container.querySelectorAll("[data-space-unavailable]")).toHaveLength(2);
    expect(screen.getByText("No access to the folder")).toBeInTheDocument();
    expect(container.querySelector("[data-space-unavailable-open-settings]")).not.toBeNull();
    expect(container.querySelector("[data-folder-confirmation]")).not.toBeNull();
    expect(container.querySelector("[data-empty-space-onboarding]")).not.toBeNull();

    // The standing iCloud explanation, in both the "held" and "all local"
    // readings — the second is the one nobody would think to check.
    expect(container.querySelectorAll("[data-cloud-disclaimer]")).toHaveLength(2);
    expect(screen.getByText(/holding the contents of 12 files/)).toBeInTheDocument();
    expect(screen.getByText(/Every file of this space is on this Mac/)).toBeInTheDocument();

    // Every clipper variant, including the one that used to break saving in
    // silence.
    expect(container.querySelectorAll("[data-clipper-status]")).toHaveLength(4);
    expect(screen.getByText(/an older version/)).toBeInTheDocument();
    // Twice: no host installed, and no browser to install into.
    expect(screen.getAllByText("Not connected yet")).toHaveLength(2);
    expect(screen.getAllByText(/Found on this Mac: Chrome, Dia/).length).toBeGreaterThan(0);

    // Words that name a file's state rather than an app error.
    expect(
      screen.getByText("Original is in iCloud, not available offline"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Downloading from iCloud").length).toBeGreaterThan(0);
  });

  it("carries no unimplemented mocks any more", () => {
    render(<EdgeStatesSection />);

    // Every state that was once a labelled mock is production code now; a
    // label reappearing here means scope quietly slipped again.
    expect(screen.queryByText("нет в продукте")).not.toBeInTheDocument();
    expect(screen.getByText(/Indexing “Mine”/)).toBeInTheDocument();
  });
});
