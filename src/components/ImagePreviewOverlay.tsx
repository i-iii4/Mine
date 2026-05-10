import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Copy, Minus, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { copyMediaAssetToClipboard } from "@/lib/commands";
import { cn } from "@/lib/utils";

export type ImagePreviewRequest = {
  src: string;
  mediaRef: string;
};

const IMAGE_PREVIEW_MIN_SCALE = 0.5;
const IMAGE_PREVIEW_MAX_SCALE = 4;
const IMAGE_PREVIEW_WHEEL_SCALE_STEP = 0.0024;
const IMAGE_PREVIEW_BUTTON_SCALE_STEP = 0.2;
const IMAGE_PREVIEW_TOGGLE_SCALE = 1.5;
const IMAGE_PREVIEW_CONTROLS_HIDE_MS = 3000;
const IMAGE_PREVIEW_DRAG_THRESHOLD_PX = 3;
const IMAGE_PREVIEW_MIN_VISIBLE_EDGE_PX = 48;

type ImagePreviewTransform = {
  scale: number;
  x: number;
  y: number;
};

type ImagePreviewDrag = {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
};

function clampImagePreviewScale(value: number) {
  return Math.min(IMAGE_PREVIEW_MAX_SCALE, Math.max(IMAGE_PREVIEW_MIN_SCALE, value));
}

function clampImagePreviewOffset(value: number, min: number, max: number) {
  if (min > max) {
    return (min + max) / 2;
  }
  return Math.min(max, Math.max(min, value));
}

function constrainImagePreviewTransform(
  transform: ImagePreviewTransform,
  stage: HTMLDivElement | null,
  image: HTMLImageElement | null,
): ImagePreviewTransform {
  const scale = clampImagePreviewScale(transform.scale);
  if (!stage || !image) {
    return { ...transform, scale };
  }
  const stageRect = stage.getBoundingClientRect();
  const stageWidth = stageRect.width;
  const stageHeight = stageRect.height;
  const imageWidth = image.offsetWidth;
  const imageHeight = image.offsetHeight;
  if (stageWidth <= 0 || stageHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    return { ...transform, scale };
  }

  const visualWidth = imageWidth * scale;
  const visualHeight = imageHeight * scale;
  const visibleEdgeX = Math.min(IMAGE_PREVIEW_MIN_VISIBLE_EDGE_PX, visualWidth, stageWidth);
  const visibleEdgeY = Math.min(IMAGE_PREVIEW_MIN_VISIBLE_EDGE_PX, visualHeight, stageHeight);
  const centerX = image.offsetLeft + imageWidth / 2;
  const centerY = image.offsetTop + imageHeight / 2;
  const minX = visibleEdgeX - centerX - visualWidth / 2;
  const maxX = stageWidth - visibleEdgeX - centerX + visualWidth / 2;
  const minY = visibleEdgeY - centerY - visualHeight / 2;
  const maxY = stageHeight - visibleEdgeY - centerY + visualHeight / 2;

  return {
    scale,
    x: clampImagePreviewOffset(transform.x, minX, maxX),
    y: clampImagePreviewOffset(transform.y, minY, maxY),
  };
}

export function ImagePreviewOverlay({
  preview,
  onClose,
}: {
  preview: ImagePreviewRequest | null;
  onClose: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const transformRef = useRef<ImagePreviewTransform>({ scale: 1, x: 0, y: 0 });
  const frameRef = useRef<number | null>(null);
  const activeDragRef = useRef<ImagePreviewDrag | null>(null);
  const suppressNextClickRef = useRef(false);
  const controlsHoverRef = useRef(false);
  const controlsHideTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [zoomLabel, setZoomLabel] = useState("100%");
  const [copyError, setCopyError] = useState<string | null>(null);

  const clearControlsHideTimer = useCallback(() => {
    if (controlsHideTimerRef.current !== null) {
      window.clearTimeout(controlsHideTimerRef.current);
      controlsHideTimerRef.current = null;
    }
  }, []);

  const scheduleControlsHide = useCallback(() => {
    clearControlsHideTimer();
    controlsHideTimerRef.current = window.setTimeout(() => {
      if (!controlsHoverRef.current) {
        setControlsVisible(false);
      }
      controlsHideTimerRef.current = null;
    }, IMAGE_PREVIEW_CONTROLS_HIDE_MS);
  }, [clearControlsHideTimer]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    scheduleControlsHide();
  }, [scheduleControlsHide]);

  const applyTransform = useCallback((nextTransform: ImagePreviewTransform, animated = false) => {
    transformRef.current = constrainImagePreviewTransform(
      nextTransform,
      stageRef.current,
      imageRef.current,
    );
    const image = imageRef.current;
    if (image) {
      image.style.transition = animated
        ? "transform 160ms cubic-bezier(0.22, 1, 0.36, 1)"
        : "none";
    }
    if (frameRef.current !== null) {
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const { scale, x, y } = transformRef.current;
      const currentImage = imageRef.current;
      if (currentImage) {
        currentImage.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
        currentImage.dataset.detailImagePreviewScale = scale.toFixed(3);
        currentImage.dataset.detailImagePreviewTranslateX = x.toFixed(3);
        currentImage.dataset.detailImagePreviewTranslateY = y.toFixed(3);
      }
      setZoomLabel(`${Math.round(scale * 100)}%`);
    });
  }, []);

  const getImageLayoutCenter = useCallback(() => {
    const stage = stageRef.current;
    const image = imageRef.current;
    if (!stage || !image) {
      return null;
    }
    const stageRect = stage.getBoundingClientRect();
    return {
      x: stageRect.left + image.offsetLeft + image.offsetWidth / 2,
      y: stageRect.top + image.offsetTop + image.offsetHeight / 2,
    };
  }, []);

  const getStageCenter = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) {
      return null;
    }
    const stageRect = stage.getBoundingClientRect();
    return {
      x: stageRect.left + stageRect.width / 2,
      y: stageRect.top + stageRect.height / 2,
    };
  }, []);

  const applyScaleAtPoint = useCallback((scale: number, clientX: number, clientY: number, animated = false) => {
    const current = transformRef.current;
    const nextScale = clampImagePreviewScale(scale);
    if (Math.abs(nextScale - current.scale) < 0.0001) {
      return;
    }
    const center = getImageLayoutCenter();
    if (!center) {
      applyTransform({ ...current, scale: nextScale }, animated);
      return;
    }
    const pointX = clientX - center.x;
    const pointY = clientY - center.y;
    const scaleRatio = nextScale / current.scale;
    applyTransform(
      {
        scale: nextScale,
        x: pointX - (pointX - current.x) * scaleRatio,
        y: pointY - (pointY - current.y) * scaleRatio,
      },
      animated,
    );
  }, [applyTransform, getImageLayoutCenter]);

  const applyScaleAtStageCenter = useCallback((scale: number, animated = false) => {
    const center = getStageCenter() ?? getImageLayoutCenter();
    if (!center) {
      applyTransform({ ...transformRef.current, scale }, animated);
      return;
    }
    applyScaleAtPoint(scale, center.x, center.y, animated);
  }, [applyScaleAtPoint, applyTransform, getImageLayoutCenter, getStageCenter]);

  useEffect(() => {
    if (!preview) {
      return;
    }
    transformRef.current = { scale: 1, x: 0, y: 0 };
    activeDragRef.current = null;
    suppressNextClickRef.current = false;
    setZoomLabel("100%");
    setControlsVisible(true);
    setCopyError(null);
    controlsHoverRef.current = false;
    applyTransform({ scale: 1, x: 0, y: 0 });
    scheduleControlsHide();
    overlayRef.current?.focus({ preventScroll: true });
    return () => {
      clearControlsHideTimer();
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [applyTransform, clearControlsHideTimer, preview, scheduleControlsHide]);

  useEffect(() => {
    if (!preview) {
      return;
    }
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [onClose, preview]);

  const stepScale = useCallback((direction: -1 | 1) => {
    applyScaleAtStageCenter(
      transformRef.current.scale + direction * IMAGE_PREVIEW_BUTTON_SCALE_STEP,
      true,
    );
    showControls();
  }, [applyScaleAtStageCenter, showControls]);

  const toggleImageScale = useCallback((clientX: number, clientY: number) => {
    applyScaleAtPoint(
      Math.abs(transformRef.current.scale - 1) < 0.001 ? IMAGE_PREVIEW_TOGGLE_SCALE : 1,
      clientX,
      clientY,
      true,
    );
    showControls();
  }, [applyScaleAtPoint, showControls]);

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const nextScale = transformRef.current.scale * Math.exp(-event.deltaY * IMAGE_PREVIEW_WHEEL_SCALE_STEP);
    applyScaleAtPoint(nextScale, event.clientX, event.clientY);
    showControls();
  }, [applyScaleAtPoint, showControls]);

  const handleImageClick = useCallback((event: ReactMouseEvent<HTMLImageElement>) => {
    event.stopPropagation();
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    toggleImageScale(event.clientX, event.clientY);
  }, [toggleImageScale]);

  const handleImagePointerDown = useCallback((event: ReactPointerEvent<HTMLImageElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    showControls();
    activeDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [showControls]);

  const handleImagePointerMove = useCallback((event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = activeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    showControls();
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    const movedDistance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    if (movedDistance >= IMAGE_PREVIEW_DRAG_THRESHOLD_PX) {
      drag.moved = true;
    }
    if (dx === 0 && dy === 0) {
      return;
    }
    const current = transformRef.current;
    applyTransform({ ...current, x: current.x + dx, y: current.y + dy });
  }, [applyTransform, showControls]);

  const finishImageDrag = useCallback((event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = activeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.stopPropagation();
    if (drag.moved) {
      suppressNextClickRef.current = true;
    }
    activeDragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  const copyImage = useCallback(() => {
    if (!preview) {
      return;
    }
    setCopyError(null);
    showControls();
    void copyMediaAssetToClipboard(preview.mediaRef)
      .catch((error) => setCopyError(error instanceof Error ? error.message : String(error)));
  }, [preview, showControls]);

  if (!preview) {
    return null;
  }

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      className="image-preview-secondary-plane fixed inset-x-0 bottom-0 top-8 z-[70] overflow-hidden text-black"
      role="dialog"
      aria-modal="false"
      aria-label="Image preview"
      data-image-preview-overlay
      onClick={onClose}
      onPointerMove={showControls}
      onWheel={handleWheel}
    >
      <div
        ref={stageRef}
        className="relative z-10 flex h-full w-full items-center justify-center overflow-hidden p-8 pb-20"
        data-image-preview-stage
      >
        <img
          ref={imageRef}
          src={preview.src}
          alt=""
          className="max-h-[calc(100vh-8rem)] max-w-[calc(100vw-4rem)] origin-center cursor-grab select-none object-contain will-change-transform active:cursor-grabbing"
          draggable={false}
          data-image-preview-image
          data-detail-image-preview-scale="1.000"
          data-detail-image-preview-translate-x="0.000"
          data-detail-image-preview-translate-y="0.000"
          style={{ transform: "translate3d(0px, 0px, 0) scale(1)", touchAction: "none" }}
          onClick={handleImageClick}
          onDragStart={(event) => event.preventDefault()}
          onLoad={() => applyTransform(transformRef.current)}
          onPointerDown={handleImagePointerDown}
          onPointerMove={handleImagePointerMove}
          onPointerUp={finishImageDrag}
          onPointerCancel={finishImageDrag}
        />
      </div>
      <div
        className={cn(
          "absolute bottom-6 left-1/2 z-20 flex h-8 -translate-x-1/2 items-center gap-1 rounded-1 border border-border bg-accent/90 px-1 backdrop-blur-sm backdrop-saturate-150 transition-opacity duration-500",
          controlsVisible ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        data-image-preview-controls
        data-visible={controlsVisible ? "true" : "false"}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerEnter={() => {
          controlsHoverRef.current = true;
          setControlsVisible(true);
          clearControlsHideTimer();
        }}
        onPointerLeave={() => {
          controlsHoverRef.current = false;
          scheduleControlsHide();
        }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Zoom out"
          data-image-preview-zoom-out
          onClick={() => stepScale(-1)}
          className="text-muted-foreground hover:text-foreground"
        >
          <Minus className="size-4" />
        </Button>
        <span
          className="min-w-[5ch] text-center font-mono text-sm text-muted-foreground"
          data-image-preview-zoom-label
        >
          {zoomLabel}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Zoom in"
          data-image-preview-zoom-in
          onClick={() => stepScale(1)}
          className="text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-4" />
        </Button>
        <div className="h-6 w-px bg-border" />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Copy media"
          data-image-preview-copy
          onClick={copyImage}
          className="text-muted-foreground hover:text-foreground"
        >
          <Copy className="size-4" />
        </Button>
        <div className="h-6 w-px bg-border" />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close image preview"
          data-image-preview-close
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </Button>
        {copyError && (
          <span className="sr-only" data-image-preview-copy-error>
            {copyError}
          </span>
        )}
      </div>
    </div>
  );
}
