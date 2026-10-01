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
  listSpaces: vi.fn(() => Promise.resolve([])),
}));

describe("EdgeStatesSection", () => {
  it("draws the states nobody can produce on demand", () => {
    const { container } = render(<EdgeStatesSection />);

    // Screens that need a vault in a particular condition — including the
    // locked-folder variant, whose only live trigger is a macOS refusal.
    expect(container.querySelectorAll("[data-space-unavailable]")).toHaveLength(2);
    expect(screen.getByText("No access to the folder")).toBeInTheDocument();
    expect(container.querySelector("[data-space-unavailable-open-settings]")).not.toBeNull();
    // A chosen folder opens at once; its count and the way to another folder
    // live in the indexing notice (SPEC_ONBOARDING.md, О12, О13).
    expect(container.querySelector("[data-folder-confirmation]")).toBeNull();
    expect(container.querySelector("[data-indexing-progress]")).not.toBeNull();
    expect(container.querySelector("[data-empty-space-onboarding]")).not.toBeNull();

    // The recommendation appears at the relevant moment, not permanently in Spaces.
    expect(container.querySelector("[data-cloud-recommendation-card]")).not.toBeNull();
    expect(container.querySelector("[data-cloud-disclaimer]")).toBeNull();

    // The clipper helper repairs itself and Settings has no Extension section
    // (SPEC_ONBOARDING.md, О5, О16): no status block is drawn anywhere, and
    // the install steps show on the empty space instead.
    expect(container.querySelector("[data-clipper-status]")).toBeNull();
    expect(container.querySelector("[data-empty-space-install-step]")).not.toBeNull();

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
    expect(screen.getByRole("progressbar", { name: "Indexing “Mine”" })).toBeInTheDocument();
  });
});
