import { fireEvent, render, screen } from "@testing-library/react";
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

  it("disables Retake and Crop while a capture is in flight (Б4.6)", () => {
    const onRetake = vi.fn();
    render(<ScreenshotPreview dataUrl="data:image/png;base64,x" onRetake={onRetake} onCrop={vi.fn()} cropSupported capturing />);
    const retake = screen.getByRole("button", { name: /Retake/ });
    expect(retake).toBeDisabled();
    expect(screen.getByRole("button", { name: /Crop Area/ })).toBeDisabled();
    fireEvent.click(retake);
    expect(onRetake).not.toHaveBeenCalled();
  });

  it("shows a failed capture next to the frame it keeps", () => {
    const { container } = render(
      <ScreenshotPreview dataUrl="data:image/png;base64,x" onRetake={vi.fn()} onCrop={vi.fn()} cropSupported
        error="The page is not in front of its window. Bring it forward and retake the screenshot." />,
    );
    expect(container.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,x");
    expect(screen.getByRole("alert")).toHaveTextContent("not in front");
    expect(screen.getByRole("button", { name: /Retake/ })).toBeEnabled();
  });

  it("offers Retake when the first capture failed and there is no frame yet", () => {
    const { container } = render(
      <ScreenshotPreview dataUrl={null} onRetake={vi.fn()} onCrop={vi.fn()} cropSupported error="Screenshot capture failed" />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Screenshot capture failed");
    expect(screen.getByRole("button", { name: /Retake/ })).toBeEnabled();
  });
});
