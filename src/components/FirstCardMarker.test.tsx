import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FirstCardMarkerCard } from "./FirstCardMarker";

/// SPEC_ONBOARDING.md, О19; SPEC_DEEP_AUDIT.md, Е6.15: the one sentence after
/// the first saved element calls it an element, the dictionary's word, and
/// names its file.
describe("FirstCardMarkerCard", () => {
  it("says the element is a file and reveals it on the button", () => {
    const onReveal = vi.fn();
    render(<FirstCardMarkerCard fileName="Sunset.md" onReveal={onReveal} onClose={vi.fn()} />);
    expect(screen.getByText("This element is a file")).toBeInTheDocument();
    expect(screen.queryByText("This card is a file")).toBeNull();
    expect(screen.getByText(/“Sunset\.md” is already in your folder\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reveal in Finder" }));
    expect(onReveal).toHaveBeenCalledTimes(1);
  });
});
