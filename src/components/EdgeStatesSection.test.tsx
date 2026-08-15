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

    // Screens that need a vault in a particular condition.
    expect(container.querySelector("[data-space-unavailable]")).not.toBeNull();
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
    expect(screen.getByText("Downloading from iCloud")).toBeInTheDocument();
  });

  it("marks the states that are drawn rather than shipped", () => {
    render(<EdgeStatesSection />);

    // A mock that reads as finished work is worse than no mock: these two are
    // specified and not implemented.
    expect(screen.getAllByText("нет в продукте")).toHaveLength(2);
  });
});
