import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScreenshotPreview } from "./ScreenshotPreview";

describe("ScreenshotPreview", () => {
  it("keeps the action row rigid while only the image box is elastic", () => {
    const { container } = render(
      <ScreenshotPreview
        dataUrl="data:image/png;base64,x"
        onRetake={vi.fn()}
        onCrop={vi.fn()}
        cropSupported
      />,
    );

    // The image box is the section's only elastic element: it may compress
    // and lets object-contain scale the screenshot down.
    const imageBox = container.querySelector("img")?.parentElement as HTMLElement;
    expect(imageBox).toHaveClass("shrink");
    expect(imageBox).toHaveClass("overflow-hidden");
    expect(imageBox).toHaveClass("min-h-24");

    // Crop Area and Retake must never shrink away — that was the v1 bug the
    // elastic model exists to prevent.
    const actionRow = screen.getByRole("button", { name: /Crop Area/ })
      .parentElement as HTMLElement;
    expect(actionRow).toHaveClass("shrink-0");
    expect(screen.getByRole("button", { name: /Retake/ })).toBeInTheDocument();
  });
});
