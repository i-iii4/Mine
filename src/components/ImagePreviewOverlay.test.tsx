import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImagePreviewOverlay, visibleImagePreviewTransform, type ImagePreviewRequest } from "./ImagePreviewOverlay";
import { copyMediaAssetToClipboard } from "@/lib/commands";
import { peekPoseAt, peekPoseKeyframes, PEEK_POSE_REST, PEEK_POSE_RISE_FROM, PEEK_POSE_SUNK } from "@/lib/cardPeek";
import { MOTION_EASE } from "@/lib/motion";
import { setMotionLevel } from "@/test/motionLevel";

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

/** The dialogs' animation ended on `element`. jsdom has no AnimationEvent:
 *  React hears the event under the name it found, whichever that is. */
function finishAnimation(element: Element) {
  fireEvent.animationEnd(element);
  fireEvent(element, new Event("webkitAnimationEnd", { bubbles: true }));
}

describe("ImagePreviewOverlay", () => {
  beforeEach(() => {
    copyMediaAssetToClipboardMock.mockReset();
    copyMediaAssetToClipboardMock.mockResolvedValue(undefined);
  });

  it("keeps the viewer controls on screen without pointer movement (user decision 16.10.2026)", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(
        <ImagePreviewOverlay
          preview={{ src: "asset://localhost/photo.jpg", mediaRef: "photo.jpg" }}
          onClose={vi.fn()}
        />,
      );
      const controls = container.querySelector("[data-image-preview-controls]")!;
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(controls).not.toHaveClass("opacity-0");
      expect(controls).not.toHaveClass("pointer-events-none");
      expect(controls).not.toHaveAttribute("data-visible");
    } finally {
      vi.useRealTimers();
    }
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
    // The shared modal scrim over the whole page of the tab (16.10.2026), its
    // own layer so the motion's opacity leaves the picture alone (05.11.2026).
    expect(overlay).toHaveClass("fixed", "inset-0", "z-[70]");
    expect(container.querySelector("[data-image-preview-scrim]")).toHaveClass(
      "modal-scrim",
      "image-preview-secondary-plane",
      "absolute",
      "inset-0",
    );
    expect(overlay).not.toHaveClass("bg-white");
    expect(overlay).toHaveAttribute("aria-modal", "false");

    const controls = container.querySelector("[data-image-preview-controls]");
    // A floating layer that reads on the shared scrim in either theme,
    // without a shadow (user decision 16.10.2026).
    expect(controls).toHaveClass("bottom-6", "bg-popover", "border-border");
    expect(controls!.className).not.toMatch(/(^|\s)shadow-/);
    expect(controls).not.toHaveClass("bg-accent/90");
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
    expect(image).toHaveClass("image-preview-primary-media");
    // No shadow at all on the previewed image (user decision 16.10.2026).
    expect(image!.className).not.toMatch(/(^|\s)shadow-/);
    // At 100 % the picture keeps no layer of its own at rest (05.11.2026).
    expect((image as HTMLElement).style.transform).not.toContain("3d");
    expect(image!.className).not.toContain("will-change");
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

    const collapseButton = screen.getByLabelText("Collapse image preview");
    expect(collapseButton).toHaveAttribute("data-image-preview-collapse");
    fireEvent.click(collapseButton);
    // No source: it leaves as a dialog, gone when the exit has played.
    expect(onClose).not.toHaveBeenCalled();
    expect(stage).toHaveClass("animate-out", "fade-out-0", "zoom-out-95", "duration-200");
    finishAnimation(stage!);
    expect(onClose).toHaveBeenCalled();
  });

  const gallery = {
    src: "asset://localhost/b.jpg",
    mediaRef: "b.jpg",
    siblings: [
      { src: "asset://localhost/a.jpg", mediaRef: "a.jpg" },
      { src: "asset://localhost/b.jpg", mediaRef: "b.jpg" },
      { src: "asset://localhost/c.jpg", mediaRef: "c.jpg" },
    ],
  };

  function shownSrc(container: HTMLElement) {
    return container.querySelector("img")?.getAttribute("src");
  }

  it("reads the transform the image shows from its computed matrix", () => {
    expect(visibleImagePreviewTransform("matrix(1.25, 0, 0, 1.25, 12, -8)")).toEqual({ scale: 1.25, x: 12, y: -8 });
    expect(visibleImagePreviewTransform("none")).toBeNull();
  });

  it("continues a gesture from where the zoom animation is on screen (А5.1)", async () => {
    const { container } = render(
      <ImagePreviewOverlay preview={{ src: "asset://localhost/photo.jpg", mediaRef: "photo.jpg" }} onClose={vi.fn()} />,
    );
    const stage = container.querySelector("[data-image-preview-stage]");
    const image = container.querySelector("[data-image-preview-image]") as HTMLElement;
    setElementBox(stage!, { left: 0, top: 0, width: 800, height: 600 });
    setImageLayout(image, { offsetLeft: 300, offsetTop: 200, offsetWidth: 200, offsetHeight: 100 });

    // An animated zoom to 150% starts; mid-way the image shows 120%.
    fireEvent.click(image, { clientX: 400, clientY: 250 });
    const computed = vi.spyOn(window, "getComputedStyle").mockReturnValue({
      transform: "matrix(1.2, 0, 0, 1.2, 0, 0)",
    } as CSSStyleDeclaration);
    try {
      fireEvent.pointerDown(image, { pointerId: 1, button: 0, clientX: 400, clientY: 250 });
      fireEvent.pointerMove(image, { pointerId: 1, clientX: 410, clientY: 250 });
      fireEvent.pointerUp(image, { pointerId: 1, clientX: 410, clientY: 250 });
    } finally {
      computed.mockRestore();
    }
    // The drag moved the image from its visible place at its visible scale,
    // not from the end of the animation.
    await waitFor(() => {
      expect(image).toHaveAttribute("data-detail-image-preview-scale", "1.200");
      expect(readImageNumber(image, "data-detail-image-preview-translate-x")).toBeCloseTo(10, 3);
    });
    expect(image.style.transition).toBe("none");
  });

  it.each([["full", "160ms"], ["minimal", "150ms"]] as const)(
    "glides a zoom button's press at %s over %s, and zooms at once when a key presses it (SPEC_MOTION_LEVELS.md, К3)",
    (level, duration) => {
      setMotionLevel(level);
      const { container } = render(
        <ImagePreviewOverlay preview={{ src: "asset://localhost/photo.jpg", mediaRef: "photo.jpg" }} onClose={vi.fn()} />,
      );
      const image = container.querySelector<HTMLElement>("[data-image-preview-image]")!;
      fireEvent.click(screen.getByLabelText("Zoom in"), { detail: 1 });
      expect(image.style.transition).toBe(`transform ${duration} cubic-bezier(0.22, 1, 0.36, 1)`);
      fireEvent.click(screen.getByLabelText("Zoom in"), { detail: 0 });
      expect(image.style.transition).toBe("none");
    },
  );

  it("zooms at once at Off (К3)", () => {
    setMotionLevel("off");
    const { container } = render(
      <ImagePreviewOverlay preview={{ src: "asset://localhost/photo.jpg", mediaRef: "photo.jpg" }} onClose={vi.fn()} />,
    );
    const image = container.querySelector<HTMLElement>("[data-image-preview-image]")!;
    fireEvent.click(screen.getByLabelText("Zoom in"), { detail: 1 });
    expect(image.style.transition).toBe("none");
  });

  it("times the zoom animation from its first frame, not from the command (Б5.5)", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const runFrames = () => {
      act(() => {
        for (const frame of frames.splice(0)) frame(now);
      });
    };
    try {
      const { container } = render(
        <ImagePreviewOverlay preview={{ src: "asset://localhost/photo.jpg", mediaRef: "photo.jpg" }} onClose={vi.fn()} />,
      );
      const stage = container.querySelector("[data-image-preview-stage]");
      const image = container.querySelector("[data-image-preview-image]") as HTMLElement;
      setElementBox(stage!, { left: 0, top: 0, width: 800, height: 600 });
      setImageLayout(image, { offsetLeft: 300, offsetTop: 200, offsetWidth: 200, offsetHeight: 100 });
      runFrames();

      // The zoom to 150% is commanded at 0 ms; its frame comes 100 ms late,
      // so the image moves from 100 ms to 260 ms.
      fireEvent.click(image, { clientX: 400, clientY: 250 });
      now = 100;
      runFrames();
      expect(image).toHaveAttribute("data-detail-image-preview-scale", "1.500");

      // At 170 ms the image is still on its way, at 140%.
      now = 170;
      const computed = vi.spyOn(window, "getComputedStyle").mockReturnValue({
        transform: "matrix(1.4, 0, 0, 1.4, 0, 0)",
      } as CSSStyleDeclaration);
      try {
        fireEvent.pointerDown(image, { pointerId: 1, button: 0, clientX: 400, clientY: 250 });
        fireEvent.pointerMove(image, { pointerId: 1, clientX: 410, clientY: 250 });
        fireEvent.pointerUp(image, { pointerId: 1, clientX: 410, clientY: 250 });
      } finally {
        computed.mockRestore();
      }
      runFrames();

      // The drag continued from what was on screen, not from the end point.
      expect(image).toHaveAttribute("data-detail-image-preview-scale", "1.400");
      expect(readImageNumber(image, "data-detail-image-preview-translate-x")).toBeCloseTo(10, 3);
      expect(image.style.transition).toBe("none");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("steps through a card's images with the arrow keys, starting at the clicked one", () => {
    const { container } = render(
      <ImagePreviewOverlay preview={gallery} onClose={vi.fn()} />,
    );

    expect(shownSrc(container)).toBe("asset://localhost/b.jpg");
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(shownSrc(container)).toBe("asset://localhost/c.jpg");
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(shownSrc(container)).toBe("asset://localhost/b.jpg");
  });

  it("wraps around at both ends", () => {
    const { container } = render(
      <ImagePreviewOverlay preview={gallery} onClose={vi.fn()} />,
    );

    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(shownSrc(container)).toBe("asset://localhost/a.jpg");
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(shownSrc(container)).toBe("asset://localhost/c.jpg");
  });

  it("copies whatever is on screen after stepping, not the image it opened with", async () => {
    render(<ImagePreviewOverlay preview={gallery} onClose={vi.fn()} />);

    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.click(screen.getByLabelText("Copy media"));

    await waitFor(() => {
      expect(copyMediaAssetToClipboardMock).toHaveBeenCalledWith("c.jpg");
    });
  });

  it("leaves the arrow keys alone when the card holds a single image", () => {
    // Card-to-card navigation lives on the same keys, so a lone image must not
    // claim them just because the viewer happens to be open.
    const onClose = vi.fn();
    render(
      <ImagePreviewOverlay
        preview={{ src: "asset://localhost/only.jpg", mediaRef: "only.jpg" }}
        onClose={onClose}
      />,
    );

    const event = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true, bubbles: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  // SPEC_MEDIA_ASSET_ACTIONS.md, «Картинка страницы у ссылки».
  it("shows a picture that is no media asset without Copy Media, its zoom and close kept", () => {
    const onClose = vi.fn();
    const { container } = render(
      <ImagePreviewOverlay
        preview={{ src: "asset://localhost//thumbs/link.jpg", mediaRef: null }}
        onClose={onClose}
      />,
    );
    expect(container.querySelector("[data-image-preview-image]")).toHaveAttribute("src", "asset://localhost//thumbs/link.jpg");
    expect(screen.queryByLabelText("Copy media")).toBeNull();
    expect(screen.getByLabelText("Zoom in")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Collapse image preview"));
    finishAnimation(container.querySelector("[data-image-preview-stage]")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(copyMediaAssetToClipboardMock).not.toHaveBeenCalled();
  });

  // SPEC_DEEP_AUDIT.md, Е6.8.
  it("shows no broken-image icon for a picture whose file will not load", () => {
    const { container } = render(
      <ImagePreviewOverlay
        preview={{ src: "asset://localhost/gone.jpg", mediaRef: "gone.jpg" }}
        onClose={vi.fn()}
      />,
    );
    fireEvent.error(container.querySelector("[data-image-preview-image]") as HTMLImageElement);
    expect(container.querySelector("[data-image-preview-image]")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Image preview" })).toBeInTheDocument();
  });
});

// SPEC_MEDIA_ASSET_ACTIONS.md, «Движение просмотра изображения».
describe("ImagePreviewOverlay motion", () => {
  type Box = { left: number; top: number; width: number; height: number };
  const FRAME_MS = 1000 / 60;
  /** More than the spring's 367 ms stop and the frames after it. */
  const WHOLE_MOTION_FRAMES = 30;
  const LAID: Box = { left: 200, top: 100, width: 800, height: 600 };
  const SOURCE: Box = { left: 40, top: 500, width: 200, height: 150 };

  let now = 0;
  let pending = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;

  /** Runs one display frame: everything asked for before it. */
  function frame(count = 1) {
    for (let index = 0; index < count; index += 1) {
      now += FRAME_MS;
      const due = [...pending.values()];
      pending = new Map();
      act(() => {
        for (const callback of due) callback(now);
      });
    }
  }

  /** Runs a closing to the frame the source shows under the picture again. */
  function frameUntilSourceShows(source: HTMLElement) {
    for (let index = 0; index < WHOLE_MOTION_FRAMES && source.style.visibility === "hidden"; index += 1) {
      frame();
    }
    expect(source.style.visibility).toBe("");
  }

  function sourceFrame(box: Box = SOURCE, fit = "contain") {
    const element = document.createElement("div");
    const picture = document.createElement("img");
    picture.src = "asset://localhost/source.jpg";
    picture.style.objectFit = fit;
    Object.defineProperty(picture, "naturalWidth", { configurable: true, value: 800 });
    Object.defineProperty(picture, "naturalHeight", { configurable: true, value: 600 });
    element.append(picture);
    document.body.append(element);
    setElementBox(element, box);
    setElementBox(picture, box);
    return { element, picture };
  }

  /** Renders the preview with a picture of known size at `LAID`. */
  function open(request: Partial<ImagePreviewRequest>, onClose = vi.fn()) {
    const preview: ImagePreviewRequest = {
      src: "asset://localhost/photo.jpg",
      mediaRef: "photo.jpg",
      openedBy: "pointer",
      ...request,
    };
    const result = render(<ImagePreviewOverlay preview={preview} onClose={onClose} />);
    const image = result.container.querySelector<HTMLImageElement>("[data-image-preview-image]")!;
    const stage = result.container.querySelector<HTMLElement>("[data-image-preview-stage]")!;
    setElementBox(image, LAID);
    setElementBox(stage, { left: 0, top: 0, width: 1200, height: 800 });
    setImageLayout(image, { offsetLeft: LAID.left, offsetTop: LAID.top, offsetWidth: LAID.width, offsetHeight: LAID.height });
    return {
      ...result,
      image,
      stage,
      overlay: result.container.querySelector<HTMLElement>("[data-image-preview-overlay]")!,
      scrim: result.container.querySelector<HTMLElement>("[data-image-preview-scrim]")!,
      controls: result.container.querySelector<HTMLElement>("[data-image-preview-controls]")!,
      onClose,
    };
  }

  /** The picture's box on screen, from what the motion wrote on it. */
  function shownBox(image: HTMLElement): Box {
    const transform = image.style.transform;
    if (transform === "none" || transform === "") return LAID;
    const move = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\) scale\(([\d.]+)\)/.exec(transform)!;
    const [x, y, scale] = [Number(move[1]), Number(move[2]), Number(move[3])];
    const width = LAID.width * scale;
    const height = LAID.height * scale;
    return {
      left: LAID.left + LAID.width / 2 + x - width / 2,
      top: LAID.top + LAID.height / 2 + y - height / 2,
      width,
      height,
    };
  }

  function expectBox(actual: Box, expected: Box, digits = 2) {
    expect(actual.left).toBeCloseTo(expected.left, digits);
    expect(actual.top).toBeCloseTo(expected.top, digits);
    expect(actual.width).toBeCloseTo(expected.width, digits);
    expect(actual.height).toBeCloseTo(expected.height, digits);
  }

  beforeEach(() => {
    now = 0;
    pending = new Map();
    nextFrame = 1;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      pending.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      pending.delete(id);
    });
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(600);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("shows nothing until the motion starts, and the first frame stands exactly on the source", () => {
    const { element } = sourceFrame();
    const { image, scrim, controls } = open({ source: element });
    // Before anything is painted: nothing on screen has changed.
    expect(scrim.style.opacity).toBe("0");
    expect(controls.style.opacity).toBe("0");
    expect(image.style.visibility).toBe("hidden");

    frame();
    expect(image.style.visibility).toBe("");
    expect(scrim.style.opacity).toBe("0");
    expect(controls.style.opacity).toBe("0");
    expectBox(shownBox(image), SOURCE);
    expect(image.style.clipPath).toBe("inset(0px 0px 0px 0px round 0px)");
    // Under a picture that lies on it, the source is still there this frame.
    expect(element.style.visibility).toBe("");
    frame();
    expect(element.style.visibility).toBe("hidden");
  });

  it("opens the crop continuously out of a source that covers with the picture", () => {
    const box = { left: 40, top: 400, width: 200, height: 200 };
    const { element } = sourceFrame(box, "cover");
    const { image } = open({ source: element });
    frame();
    // The whole picture, 4:3, covers the 200 px square, centred.
    expectBox(shownBox(image), { left: 40 - (800 / 3 - 200) / 2, top: 400, width: 800 / 3, height: 200 });
    const crops: number[] = [];
    for (let index = 0; index < 22; index += 1) {
      const inset = /inset\(([\d.]+)px ([\d.]+)px ([\d.]+)px ([\d.]+)px/.exec(image.style.clipPath);
      if (inset) crops.push(Number(inset[2]));
      frame();
    }
    expect(crops[0]).toBeCloseTo((800 - 600) / 2, 1);
    for (let index = 1; index < crops.length; index += 1) {
      expect(crops[index]!).toBeLessThanOrEqual(crops[index - 1]! + 1e-6);
    }
    expect(crops.at(-1)).toBeCloseTo(0, 1);
  });

  it("lands on the preview's place on the spring, the scrim with it and the toolbar in the second half", () => {
    const { element } = sourceFrame();
    const { image, scrim, controls } = open({ source: element });
    frame();
    let previousLeft = shownBox(image).left;
    let previousScrim = 0;
    let elapsed = 0;
    let landedAt = 0;
    for (let index = 0; index < WHOLE_MOTION_FRAMES; index += 1) {
      frame();
      elapsed += FRAME_MS;
      if (image.style.clipPath === "") break;
      const scrimShare = Number(scrim.style.opacity);
      expect(scrimShare).toBeGreaterThanOrEqual(previousScrim);
      previousScrim = scrimShare;
      // Critically damped: it never passes its place.
      const left = shownBox(image).left;
      expect(left).toBeGreaterThanOrEqual(previousLeft - 1e-6);
      expect(left).toBeLessThanOrEqual(LAID.left + 1e-3);
      previousLeft = left;
      if (elapsed < 183) expect(controls.style.opacity).toBe("0");
      if (elapsed > 190 && Number(scrim.style.opacity) < 1) expect(Number(controls.style.opacity)).toBeGreaterThan(0);
      if (scrimShare === 1 && landedAt === 0) landedAt = elapsed;
    }
    expect(Math.abs(landedAt - 367)).toBeLessThanOrEqual(2 * FRAME_MS);
    // At rest: nothing of the motion stays on it, and the frame after, no layer.
    expect(image.style.transform).toBe("none");
    expect(scrim.style.opacity).toBe("");
    expect(controls.style.opacity).toBe("");
    expect(image.style.willChange).toBe("transform");
    frame();
    expect(image.style.willChange).toBe("");
    expect(pending.size).toBe(0);
  });

  it("closes the same way back: toolbar in the first third, last frame on the source, the source shown before it goes", () => {
    const { element } = sourceFrame();
    const { image, scrim, controls, onClose } = open({ source: element });
    frame(WHOLE_MOTION_FRAMES);
    expect(element.style.visibility).toBe("hidden");

    fireEvent.click(screen.getByLabelText("Collapse image preview"));
    expect(onClose).not.toHaveBeenCalled();
    expect(shownBox(image).left).toBeCloseTo(LAID.left, 2);
    let elapsed = 0;
    for (let index = 0; index < WHOLE_MOTION_FRAMES && element.style.visibility === "hidden"; index += 1) {
      frame();
      elapsed += FRAME_MS;
      if (elapsed > 125) expect(controls.style.opacity).toBe("0");
    }
    // The source shows under the picture lying exactly on it, and the scrim is gone.
    expectBox(shownBox(image), SOURCE);
    expect(scrim.style.opacity).toBe("0");
    expect(onClose).not.toHaveBeenCalled();
    frame();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns to the source wherever it stands at the moment of closing", () => {
    const { element, picture } = sourceFrame();
    const { image } = open({ source: element });
    frame(WHOLE_MOTION_FRAMES);
    const moved = { left: 300, top: 40, width: 200, height: 150 };
    setElementBox(picture, moved);
    setElementBox(element, moved);
    fireEvent.click(screen.getByLabelText("Collapse image preview"));
    frameUntilSourceShows(element);
    expectBox(shownBox(image), moved);
  });

  it("starts a closing from the zoom and the pan the preview shows", () => {
    const { element } = sourceFrame();
    const { image } = open({ source: element });
    frame(WHOLE_MOTION_FRAMES);
    fireEvent.click(screen.getByLabelText("Zoom in"));
    frame();
    const zoomed = image.getAttribute("data-detail-image-preview-scale");
    expect(zoomed).toBe("1.200");
    fireEvent.click(screen.getByLabelText("Collapse image preview"));
    const start = shownBox(image);
    expect(start.width).toBeCloseTo(LAID.width * 1.2, 1);
    frame();
    // The first step is a small one, not a jump back to 100 %.
    expect(shownBox(image).width).toBeGreaterThan(LAID.width * 1.1);
    frameUntilSourceShows(element);
    expectBox(shownBox(image), SOURCE);
  });

  it("turns back mid-way from where it stands, keeping its speed", () => {
    const { element } = sourceFrame();
    const { image, overlay, onClose } = open({ source: element });
    frame();
    const widths: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      frame();
      widths.push(shownBox(image).width);
    }
    const speedAtTurn = widths[2]! - widths[1]!;
    expect(speedAtTurn).toBeGreaterThan(0);

    fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
    // The picture did not move at the press.
    expect(shownBox(image).width).toBeCloseTo(widths[2]!, 6);
    const back: number[] = [widths[2]!];
    for (let index = 0; index < 12; index += 1) {
      frame();
      back.push(shownBox(image).width);
    }
    // It brakes first: still growing, by less than before, with no break in speed.
    expect(back[1]! - back[0]!).toBeGreaterThan(0);
    expect(back[1]! - back[0]!).toBeLessThan(speedAtTurn);
    for (let index = 1; index < back.length - 1; index += 1) {
      const change = (back[index + 1]! - back[index]!) - (back[index]! - back[index - 1]!);
      expect(Math.abs(change)).toBeLessThan(Math.abs(speedAtTurn));
    }
    frame(WHOLE_MOTION_FRAMES);
    expect(onClose).toHaveBeenCalledTimes(1);
    expectBox(shownBox(image), SOURCE);
  });

  it("opens at once from the keyboard and closes at once by Escape", () => {
    const { element } = sourceFrame();
    const { image, scrim, controls, onClose } = open({ source: element, openedBy: "keyboard" });
    // Standing in the frame of the key press, nothing asked for later.
    expect(scrim.style.opacity).toBe("");
    expect(controls.style.opacity).toBe("");
    expect(image.style.visibility).toBe("");
    expect(image.style.clipPath).toBe("");
    expect(element.style.visibility).toBe("");
    frame();
    expect(image.style.clipPath).toBe("");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(pending.size).toBe(0);
  });

  it("fades in place on closing by the button after a keyboard opening, no way back to the source", () => {
    const { element } = sourceFrame();
    const { image, scrim, onClose } = open({ source: element, openedBy: "keyboard" });
    frame();
    fireEvent.click(screen.getByLabelText("Collapse image preview"));
    frame(5);
    expect(Number(image.style.opacity)).toBeLessThan(1);
    expect(Number(scrim.style.opacity)).toBeCloseTo(Number(image.style.opacity), 6);
    expect(image.style.clipPath).toBe("");
    expect(shownBox(image)).toEqual(LAID);
    frame(WHOLE_MOTION_FRAMES);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes at once by Escape mid-way, the source shown again", () => {
    const { element } = sourceFrame();
    const { onClose } = open({ source: element });
    frame(6);
    expect(element.style.visibility).toBe("hidden");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(element.style.visibility).toBe("");
    expect(pending.size).toBe(0);
  });

  it("opens and closes at once at Off, with no wait for the original and no way to the source (ОУ9)", () => {
    setMotionLevel("off");
    const { element } = sourceFrame();
    const { image, scrim, controls, stage, onClose } = open({ source: element });
    // In the frame of the press: nothing waits, nothing is hidden.
    for (const part of [scrim, controls, stage]) expect(part.style.opacity).toBe("");
    expect(image.style.visibility).toBe("");
    expect(element.style.visibility).toBe("");
    fireEvent.click(screen.getByLabelText("Collapse image preview"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(element.style.visibility).toBe("");
  });

  describe("in Minimal (SPEC_MOTION_LEVELS.md, ОУ9)", () => {
    interface Heard {
      element: Element;
      keyframes: Keyframe[];
      timing: KeyframeAnimationOptions;
      animation: { currentTime: number; startTime: number | null; onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn> };
    }
    let heard: Heard[] = [];
    const timing = (duration: number) => ({ duration, easing: MOTION_EASE, fill: "forwards" });

    beforeEach(() => {
      setMotionLevel("minimal");
      heard = [];
      Object.defineProperty(HTMLElement.prototype, "animate", {
        configurable: true,
        value(this: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
          const animation = { currentTime: 0, startTime: null, onfinish: null as (() => void) | null, cancel: vi.fn() };
          heard.push({ element: this, keyframes, timing: options, animation });
          return animation;
        },
      });
    });

    afterEach(() => {
      delete (HTMLElement.prototype as { animate?: unknown }).animate;
    });

    const finish = (motion: Heard) => act(() => {
      motion.animation.currentTime = Number(motion.timing.duration);
      motion.animation.onfinish?.();
    });

    it("rises the stage and the buttons, each about its own centre, with the scrim, the source left on the page", () => {
      const { element } = sourceFrame();
      const { stage, controls, scrim } = open({ source: element });
      // Unseen while the original decodes, 100 ms at most.
      expect(stage.style.opacity).toBe("0");
      frame(7);
      expect(heard.map(({ element: part, keyframes, timing: heardTiming }) => ({ part, keyframes, heardTiming }))).toEqual([
        { part: stage, keyframes: [peekPoseKeyframes(PEEK_POSE_RISE_FROM).window, peekPoseKeyframes(PEEK_POSE_REST).window], heardTiming: timing(150) },
        { part: controls, keyframes: [peekPoseKeyframes(PEEK_POSE_RISE_FROM).window, peekPoseKeyframes(PEEK_POSE_REST).window], heardTiming: timing(150) },
        { part: scrim, keyframes: [{ opacity: 0 }, { opacity: 1 }], heardTiming: timing(150) },
      ]);
      for (const part of [scrim, controls, stage]) expect(part.style.opacity).toBe("");
      // Nothing flies: the source stays where it stands.
      expect(element.style.visibility).toBe("");
      finish(heard[0]!);
      expect(heard[0]!.animation.cancel).toHaveBeenCalled();
    });

    it("sinks the stage from where it stands on the button in 100 ms, the zoomed picture with its zoom, and goes the frame after", () => {
      const { element } = sourceFrame();
      const { image, onClose } = open({ source: element });
      frame(7);
      heard[0]!.animation.currentTime = 50;
      const midway = peekPoseAt({ from: PEEK_POSE_RISE_FROM, to: PEEK_POSE_REST, duration: 150 }, 50);
      fireEvent.click(screen.getByLabelText("Collapse image preview"));
      const [stageLeaving, , scrimLeaving] = heard.slice(3);
      expect(stageLeaving!.keyframes).toEqual([peekPoseKeyframes(midway).window, peekPoseKeyframes(PEEK_POSE_SUNK).window]);
      expect(stageLeaving!.timing).toEqual(timing(100));
      expect(scrimLeaving!.keyframes).toEqual([{ opacity: midway.opacity }, { opacity: 0 }]);
      expect(image.style.clipPath).toBe("");
      finish(stageLeaving!);
      expect(onClose).not.toHaveBeenCalled();
      frame();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("turns the leaving back in 150 ms when zoom takes it over, and the viewer stays", () => {
      const { element } = sourceFrame();
      const { overlay, onClose } = open({ source: element });
      frame(7);
      finish(heard[0]!);
      fireEvent.click(screen.getByLabelText("Collapse image preview"));
      heard[3]!.animation.currentTime = 40;
      const midway = peekPoseAt({ from: PEEK_POSE_REST, to: PEEK_POSE_SUNK, duration: 100 }, 40);
      fireEvent.wheel(overlay, { deltaY: -40, clientX: 600, clientY: 400 });
      expect(overlay).not.toHaveClass("pointer-events-none");
      const back = heard.at(-3)!;
      expect(back.keyframes).toEqual([peekPoseKeyframes(midway).window, peekPoseKeyframes(PEEK_POSE_REST).window]);
      expect(back.timing).toEqual(timing(150));
      finish(back);
      frame(3);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("opens at once by a key and closes at once by Escape", () => {
      const { element } = sourceFrame();
      const { stage, onClose } = open({ source: element, openedBy: "keyboard" });
      expect(stage.style.opacity).toBe("");
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(heard).toHaveLength(0);
    });
  });

  it("opens and leaves as a dialog without a source", () => {
    const { stage, scrim, controls, onClose } = open({ source: undefined });
    expect(stage).toHaveClass("animate-in", "fade-in-0", "zoom-in-95", "duration-200");
    expect(scrim).toHaveClass("animate-in", "fade-in-0");
    expect(controls).toHaveClass("animate-in", "fade-in-0");
    expect(scrim.style.opacity).toBe("");
    finishAnimation(stage);
    expect(stage).not.toHaveClass("animate-in");

    fireEvent.click(screen.getByLabelText("Collapse image preview"));
    expect(stage).toHaveClass("animate-out", "fade-out-0", "zoom-out-95", "duration-200");
    expect(scrim).toHaveClass("animate-out", "fade-out-0");
    expect(onClose).not.toHaveBeenCalled();
    finishAnimation(stage);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens as a dialog from a source off screen", () => {
    const { element } = sourceFrame({ left: 40, top: 5000, width: 200, height: 150 });
    const { stage, scrim, image } = open({ source: element });
    frame();
    expect(stage).toHaveClass("animate-in", "zoom-in-95");
    expect(scrim.style.opacity).toBe("");
    expect(image.style.visibility).toBe("");
    expect(element.style.visibility).toBe("");
  });

  it("leaves as a dialog when the source left the screen or the page, and the source shows again", () => {
    const { element, picture } = sourceFrame();
    const { stage, onClose } = open({ source: element });
    frame(WHOLE_MOTION_FRAMES);
    expect(element.style.visibility).toBe("hidden");
    setElementBox(picture, { left: 40, top: 5000, width: 200, height: 150 });
    fireEvent.click(screen.getByLabelText("Collapse image preview"));
    expect(stage).toHaveClass("animate-out", "zoom-out-95", "duration-200");
    expect(element.style.visibility).toBe("");
    finishAnimation(stage);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps zoom, pan and the buttons working during the opening, the motion landing where they say", () => {
    const { element } = sourceFrame();
    const { image, overlay } = open({ source: element });
    frame(6);

    fireEvent.click(screen.getByLabelText("Zoom in"));
    frame();
    expect(image).toHaveAttribute("data-detail-image-preview-scale", "1.200");
    expect(screen.getByText("120%")).toBeInTheDocument();
    // No transition of its own under the spring.
    expect(image.style.transition).toBe("none");

    const before = shownBox(image);
    fireEvent.pointerDown(image, { pointerId: 1, button: 0, clientX: 600, clientY: 400 });
    fireEvent.pointerMove(image, { pointerId: 1, clientX: 640, clientY: 400 });
    fireEvent.pointerUp(image, { pointerId: 1, clientX: 640, clientY: 400 });
    frame();
    expect(readImageNumber(image, "data-detail-image-preview-translate-x")).toBeGreaterThan(39);
    // No jump: the frame after the gesture is the spring's next step.
    expect(Math.abs(shownBox(image).left - before.left)).toBeLessThan(120);

    fireEvent.wheel(overlay, { deltaY: -100, clientX: 600, clientY: 400 });
    frame();
    expect(readImageNumber(image, "data-detail-image-preview-scale")).toBeGreaterThan(1.2);

    frame(WHOLE_MOTION_FRAMES);
    // It lands exactly on what the gestures asked for.
    expect(image.style.clipPath).toBe("");
    const landed = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\) scale\(([\d.]+)\)/.exec(image.style.transform)!;
    expect(Number(landed[1])).toBeCloseTo(readImageNumber(image, "data-detail-image-preview-translate-x"), 2);
    expect(Number(landed[2])).toBeCloseTo(readImageNumber(image, "data-detail-image-preview-translate-y"), 2);
    expect(Number(landed[3])).toBeCloseTo(readImageNumber(image, "data-detail-image-preview-scale"), 2);
  });

  it("turns back when zoom, pan or a zoom button take over a closing, and the viewer stays", () => {
    for (const takeOver of [
      () => fireEvent.click(screen.getByLabelText("Zoom in")),
      (image: HTMLElement) => fireEvent.pointerDown(image, { pointerId: 1, button: 0, clientX: 600, clientY: 400 }),
      (_image: HTMLElement, overlay: HTMLElement) => fireEvent.wheel(overlay, { deltaY: -40, clientX: 600, clientY: 400 }),
    ]) {
      const { element } = sourceFrame();
      const { image, overlay, onClose, scrim, unmount } = open({ source: element });
      frame(WHOLE_MOTION_FRAMES);
      fireEvent.click(screen.getByLabelText("Collapse image preview"));
      expect(overlay).toHaveClass("pointer-events-none");
      expect(image).toHaveClass("pointer-events-auto");
      frame(5);
      const shrinking = shownBox(image).width;
      expect(shrinking).toBeLessThan(LAID.width);

      takeOver(image, overlay);
      expect(overlay).not.toHaveClass("pointer-events-none");
      frame(WHOLE_MOTION_FRAMES);
      expect(onClose).not.toHaveBeenCalled();
      expect(scrim.style.opacity).toBe("");
      expect(image.style.clipPath).toBe("");
      unmount();
      element.remove();
    }
  });

  it("waits for the original at most 100 ms, then starts from what the source already draws", async () => {
    const { element } = sourceFrame();
    let finishDecode = () => undefined as void;
    const decode = vi.fn(() => new Promise<void>((resolve) => {
      finishDecode = resolve;
    }));
    Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: decode });
    try {
      const { image } = open({ source: element });
      expect(decode).toHaveBeenCalledTimes(1);
      frame(5);
      expect(image.style.visibility).toBe("hidden");
      frame(2);
      // Past 100 ms: it started, the source's picture behind the original.
      expect(image.style.visibility).toBe("");
      expect(image.style.backgroundImage).toContain("source.jpg");
      frame(WHOLE_MOTION_FRAMES);
      // At rest and still undecoded: the backing stays until it is.
      expect(image.style.clipPath).toBe("");
      expect(image.style.backgroundImage).toContain("source.jpg");
      await act(async () => {
        finishDecode();
        await Promise.resolve();
      });
      expect(image.style.backgroundImage).toBe("");
    } finally {
      Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
    }
  });

  it("asks no decoding of an original the source draws already: WebKit would blank it on the page", () => {
    const { element, picture } = sourceFrame();
    picture.src = "asset://localhost/photo.jpg";
    const decode = vi.fn(() => Promise.resolve());
    Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: decode });
    try {
      const { image } = open({ source: element });
      frame();
      expect(decode).not.toHaveBeenCalled();
      // It starts at once, and the same picture stands behind nothing.
      expect(image.style.visibility).toBe("");
      expect(image.style.backgroundImage).toBe("");
      expectBox(shownBox(image), SOURCE);
    } finally {
      Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
    }
  });

  it("starts as soon as the original is decoded", async () => {
    const { element } = sourceFrame();
    Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: () => Promise.resolve() });
    try {
      const { image } = open({ source: element });
      await act(async () => {
        await Promise.resolve();
      });
      frame();
      expect(image.style.visibility).toBe("");
      expectBox(shownBox(image), SOURCE);
    } finally {
      Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
    }
  });

  it("holds the place of an original not loaded yet, sized from the source's picture", () => {
    vi.restoreAllMocks();
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { element } = sourceFrame();
    const { image } = open({ source: element });
    image.style.maxWidth = "1000px";
    image.style.maxHeight = "600px";
    frame();
    expect(image.style.width).toBe("800px");
    expect(image.style.height).toBe("600px");
    expectBox(shownBox(image), SOURCE);
  });

  it("returns to the media now shown after the arrows", () => {
    const first = sourceFrame();
    const second = sourceFrame({ left: 700, top: 500, width: 200, height: 150 });
    const siblings = [
      { src: "asset://localhost/a.jpg", mediaRef: "a.jpg", source: first.element },
      { src: "asset://localhost/b.jpg", mediaRef: "b.jpg", source: second.element },
    ];
    const { container } = open({
      src: "asset://localhost/a.jpg",
      mediaRef: "a.jpg",
      source: first.element,
      siblings,
    });
    frame(WHOLE_MOTION_FRAMES);
    expect(first.element.style.visibility).toBe("hidden");

    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(first.element.style.visibility).toBe("");
    expect(second.element.style.visibility).toBe("hidden");
    const shownImage = container.querySelector<HTMLImageElement>("[data-image-preview-image]")!;
    expect(shownImage.getAttribute("src")).toBe("asset://localhost/b.jpg");
    setElementBox(shownImage, LAID);

    fireEvent.click(screen.getByLabelText("Collapse image preview"));
    frameUntilSourceShows(second.element);
    expectBox(shownBox(shownImage), { left: 700, top: 500, width: 200, height: 150 });
  });

  it("leaves as a dialog from the media now shown when it has no source", () => {
    const first = sourceFrame();
    const { stage } = open({
      src: "asset://localhost/a.jpg",
      mediaRef: "a.jpg",
      source: first.element,
      siblings: [
        { src: "asset://localhost/a.jpg", mediaRef: "a.jpg", source: first.element },
        { src: "asset://localhost/c.jpg", mediaRef: "c.jpg" },
      ],
    });
    frame(WHOLE_MOTION_FRAMES);
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(first.element.style.visibility).toBe("");
    fireEvent.click(screen.getByLabelText("Collapse image preview"));
    expect(stage).toHaveClass("animate-out", "zoom-out-95");
  });

  it("does not take the second press of a double click for a press of its own", () => {
    const { element } = sourceFrame();
    const { overlay, image, onClose } = open({ source: element });
    frame(4);
    // The press that opened it lands on the background on its way.
    fireEvent.click(overlay, { detail: 2 });
    expect(overlay).not.toHaveClass("pointer-events-none");
    frame(WHOLE_MOTION_FRAMES);

    fireEvent.click(overlay, { detail: 1 });
    expect(overlay).toHaveClass("pointer-events-none");
    const page = vi.fn();
    document.body.addEventListener("click", page);
    // The one that closed it: it reaches neither the picture nor the page.
    fireEvent.click(image, { detail: 2 });
    fireEvent.click(document.body, { detail: 2 });
    expect(page).not.toHaveBeenCalled();
    expect(overlay).toHaveClass("pointer-events-none");
    // A new press does reach the page under the closing viewer.
    fireEvent.click(document.body, { detail: 1 });
    expect(page).toHaveBeenCalledTimes(1);
    document.body.removeEventListener("click", page);
    frame(WHOLE_MOTION_FRAMES);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("gives everything back when it is taken off the page mid-way", () => {
    const { element } = sourceFrame();
    const { unmount } = open({ source: element });
    frame(6);
    expect(element.style.visibility).toBe("hidden");
    unmount();
    expect(element.style.visibility).toBe("");
    expect(pending.size).toBe(0);
  });
});
