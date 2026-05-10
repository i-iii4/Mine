import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ImagePreviewOverlay } from "./ImagePreviewOverlay";
import { copyMediaAssetToClipboard } from "@/lib/commands";

vi.mock("@/lib/commands", () => ({
  copyMediaAssetToClipboard: vi.fn(),
}));

const copyMediaAssetToClipboardMock = vi.mocked(copyMediaAssetToClipboard);

function setElementBox(
  element: Element,
  box: { left: number; top: number; width: number; height: number },
) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      ...box,
      x: box.left,
      y: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      toJSON: () => box,
    }),
  });
}

function setImageLayout(
  image: Element,
  layout: { offsetLeft: number; offsetTop: number; offsetWidth: number; offsetHeight: number },
) {
  Object.defineProperties(image, {
    offsetLeft: { configurable: true, value: layout.offsetLeft },
    offsetTop: { configurable: true, value: layout.offsetTop },
    offsetWidth: { configurable: true, value: layout.offsetWidth },
    offsetHeight: { configurable: true, value: layout.offsetHeight },
  });
}

function readImageNumber(image: Element, attribute: string) {
  return Number(image.getAttribute(attribute));
}

describe("ImagePreviewOverlay", () => {
  beforeEach(() => {
    copyMediaAssetToClipboardMock.mockReset();
    copyMediaAssetToClipboardMock.mockResolvedValue(undefined);
  });

  it("covers the app below the top bar and keeps zoom controls in a bottom island", async () => {
    const onClose = vi.fn();

    const { container } = render(
      <ImagePreviewOverlay
        preview={{ src: "asset://localhost/photo.jpg", mediaRef: "photo.jpg" }}
        onClose={onClose}
      />,
    );

    const overlay = screen.getByRole("dialog", { name: "Image preview" });
    expect(overlay).toHaveClass(
      "image-preview-secondary-plane",
      "fixed",
      "top-8",
      "bottom-0",
      "z-[70]",
    );
    expect(overlay).not.toHaveClass("bg-white");
    expect(overlay).toHaveAttribute("aria-modal", "false");

    const controls = container.querySelector("[data-image-preview-controls]");
    expect(controls).toHaveClass("bottom-6", "bg-accent/90");
    expect(controls).toHaveAttribute("data-visible", "true");
    expect(screen.getByText("100%")).toBeInTheDocument();

    const stage = container.querySelector("[data-image-preview-stage]");
    const image = container.querySelector("[data-image-preview-image]");
    setElementBox(stage!, { left: 0, top: 0, width: 800, height: 600 });
    setImageLayout(image!, {
      offsetLeft: 300,
      offsetTop: 200,
      offsetWidth: 200,
      offsetHeight: 100,
    });
    expect(image).toHaveAttribute("src", "asset://localhost/photo.jpg");
    expect(image).toHaveStyle({ transform: "translate3d(0px, 0px, 0) scale(1)" });
    expect(image).not.toHaveClass("cursor-ns-resize", "active:cursor-ns-resize");

    fireEvent.click(image!, { clientX: 400, clientY: 250 });
    await waitFor(() => {
      expect(image).toHaveAttribute("data-detail-image-preview-scale", "1.500");
    });
    expect(screen.getByText("150%")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Zoom in"));
    await waitFor(() => {
      expect(image).toHaveAttribute("data-detail-image-preview-scale", "1.700");
    });
    expect(screen.getByText("170%")).toBeInTheDocument();

    const translateXBeforeDrag = readImageNumber(image!, "data-detail-image-preview-translate-x");
    const translateYBeforeDrag = readImageNumber(image!, "data-detail-image-preview-translate-y");
    fireEvent.pointerDown(image!, { pointerId: 1, button: 0, clientX: 400, clientY: 250 });
    fireEvent.pointerMove(image!, { pointerId: 1, clientX: 440, clientY: 280 });
    fireEvent.pointerUp(image!, { pointerId: 1, clientX: 440, clientY: 280 });
    await waitFor(() => {
      expect(readImageNumber(image!, "data-detail-image-preview-translate-x")).toBeGreaterThan(
        translateXBeforeDrag + 39,
      );
      expect(readImageNumber(image!, "data-detail-image-preview-translate-y")).toBeGreaterThan(
        translateYBeforeDrag + 29,
      );
    });
    expect(image).toHaveAttribute("data-detail-image-preview-scale", "1.700");

    fireEvent.click(image!, { clientX: 440, clientY: 280 });
    expect(image).toHaveAttribute("data-detail-image-preview-scale", "1.700");

    const translateXBeforeWheel = readImageNumber(image!, "data-detail-image-preview-translate-x");
    fireEvent.wheel(overlay, { deltaY: -100, clientX: 700, clientY: 250 });
    await waitFor(() => {
      expect(readImageNumber(image!, "data-detail-image-preview-scale")).toBeGreaterThan(2);
      expect(readImageNumber(image!, "data-detail-image-preview-translate-x")).toBeLessThan(
        translateXBeforeWheel,
      );
    });

    const scaleAfterWheel = readImageNumber(image!, "data-detail-image-preview-scale");
    const minVisibleX = 48 - 400 - (200 * scaleAfterWheel) / 2;
    const minVisibleY = 48 - 250 - (100 * scaleAfterWheel) / 2;
    fireEvent.pointerDown(image!, { pointerId: 2, button: 0, clientX: 400, clientY: 250 });
    fireEvent.pointerMove(image!, { pointerId: 2, clientX: -5000, clientY: -5000 });
    fireEvent.pointerUp(image!, { pointerId: 2, clientX: -5000, clientY: -5000 });
    await waitFor(() => {
      expect(readImageNumber(image!, "data-detail-image-preview-translate-x")).toBeCloseTo(
        minVisibleX,
        1,
      );
      expect(readImageNumber(image!, "data-detail-image-preview-translate-y")).toBeCloseTo(
        minVisibleY,
        1,
      );
    });

    const maxVisibleX = 800 - 48 - 400 + (200 * scaleAfterWheel) / 2;
    const maxVisibleY = 600 - 48 - 250 + (100 * scaleAfterWheel) / 2;
    fireEvent.pointerDown(image!, { pointerId: 3, button: 0, clientX: 400, clientY: 250 });
    fireEvent.pointerMove(image!, { pointerId: 3, clientX: 8000, clientY: 8000 });
    fireEvent.pointerUp(image!, { pointerId: 3, clientX: 8000, clientY: 8000 });
    await waitFor(() => {
      expect(readImageNumber(image!, "data-detail-image-preview-translate-x")).toBeCloseTo(
        maxVisibleX,
        1,
      );
      expect(readImageNumber(image!, "data-detail-image-preview-translate-y")).toBeCloseTo(
        maxVisibleY,
        1,
      );
    });

    fireEvent.click(screen.getByLabelText("Copy media"));
    expect(copyMediaAssetToClipboardMock).toHaveBeenCalledWith("photo.jpg");

    fireEvent.click(screen.getByLabelText("Close image preview"));
    expect(onClose).toHaveBeenCalled();
  });
});
