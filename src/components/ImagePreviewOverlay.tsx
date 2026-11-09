import { MissingAwareImage } from "./MissingAwareImage";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent as ReactAnimationEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Copy, Minimize2, Minus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  MODAL_SCRIM_ENTER_CLASS,
  MODAL_SCRIM_LEAVE_CLASS,
  MODAL_SURFACE_ENTER_CLASS,
  MODAL_SURFACE_LEAVE_CLASS,
} from "@/components/ui/modal-window";
import {
  CARD_PEEK_FRAME_STEP_MS,
  CARD_PEEK_PREPARE_MAX_MS,
  clampUnit,
  peekContentOpacity,
  peekSpringSettled,
  stepPeekSpring,
  type PeekRect,
  type PeekSpring,
} from "@/lib/cardPeek";
import { copyMediaAssetToClipboard } from "@/lib/commands";
import {
  imagePreviewClosingKind,
  imagePreviewDrawnAddress,
  imagePreviewFrame,
  imagePreviewOpeningKind,
  imagePreviewRestTransform,
  measureLaidImage,
  readImagePreviewPlace,
  type ImagePreviewOpening,
  type ImagePreviewPlace,
  type ImagePreviewTransform,
} from "@/lib/imagePreviewMotion";
import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "@/lib/motion";

export type ImagePreviewRequest = {
  src: string;
  /// The local media asset on screen, the file Copy Media copies
  /// (SPEC_MEDIA_ASSET_ACTIONS.md). `null` for a picture that is no media
  /// asset, a link's page picture: the viewer shows it without Copy Media.
  mediaRef: string | null;
  /// Every image of the card the request came from, in reading order, so the
  /// viewer can step through them. Omitted when the caller has no such set;
  /// the viewer then shows the single image and the arrow keys do nothing.
  siblings?: ImagePreviewSibling[];
  /// The media frame on the page the picture opens out of and returns to
  /// (SPEC_MEDIA_ASSET_ACTIONS.md, «Движение просмотра изображения»). Omitted
  /// when the caller has none: the viewer then opens and leaves as a dialog.
  source?: HTMLElement | null;
  /// What opened the viewer: a key stands it at once (SPEC_CARD_PEEK.md, О10).
  openedBy?: "pointer" | "keyboard";
};

export type ImagePreviewSibling = {
  src: string;
  mediaRef: string;
  /// This picture's media frame on the page, to return to when it is the one
  /// on screen at closing.
  source?: HTMLElement | null;
};

/** The picture the viewer shows: a sibling, or the requested picture, which
 *  may be no media asset. */
type ImagePreviewShown = {
  src: string;
  mediaRef: string | null;
  source?: HTMLElement | null;
};

/** The running motion of the picture, the scrim and the toolbar, on the card
 *  window's one spring: `position` 0 is the source, 1 the preview. `way` is the
 *  flight's, measured once at its start; a fade goes by opacity alone. */
type ImagePreviewMotion = {
  spring: PeekSpring;
  way: { laid: PeekRect; place: ImagePreviewPlace } | null;
  /** Ms since the motion last turned: the toolbar's share goes by time. */
  elapsed: number;
  last: number;
  frame: number | null;
  /** Frames written since its start. */
  written: number;
  toolbar: number;
  toolbarStart: number;
  /** It has stopped and only leaves the page or its layers now. */
  landing: boolean;
};

const IMAGE_PREVIEW_MIN_SCALE = 0.5;
const IMAGE_PREVIEW_MAX_SCALE = 4;
const IMAGE_PREVIEW_WHEEL_SCALE_STEP = 0.0024;
const IMAGE_PREVIEW_BUTTON_SCALE_STEP = 0.2;
const IMAGE_PREVIEW_TOGGLE_SCALE = 1.5;
const IMAGE_PREVIEW_DRAG_THRESHOLD_PX = 3;
const IMAGE_PREVIEW_MIN_VISIBLE_EDGE_PX = 48;
const IMAGE_PREVIEW_ANIMATION_MS = 160;

/**
 * The transform the image shows right now, read from its computed style
 * (`matrix(a, b, c, d, e, f)`): scale `a`, offset `e`, `f`. `null` when the
 * browser reports no matrix.
 */
export function visibleImagePreviewTransform(computed: string): ImagePreviewTransform | null {
  const match = /^matrix\(([^)]+)\)$/.exec(computed.trim());
  if (!match) return null;
  const values = match[1]!.split(",").map((value) => Number(value.trim()));
  if (values.length !== 6 || values.some((value) => !Number.isFinite(value))) return null;
  return { scale: values[0]!, x: values[4]!, y: values[5]! };
}

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

/** What the motion writes moves only by the spring: no CSS transition of its
 *  own, the 0.01 ms one "Reduce motion" gives every element included
 *  (global.css), which would show each frame's value a frame late. */
const MOVED_CLASS = "transition-none";

/** The picture's backing while it flies: what its source draws, already
 *  decoded, so an original still on its way is never an empty box
 *  (SPEC_MEDIA_ASSET_ACTIONS.md, «Движение просмотра изображения», п. 5). */
function setImageBacking(image: HTMLImageElement, address: string) {
  image.style.backgroundImage = `url("${address.replace(/"/g, "%22")}")`;
  image.style.backgroundSize = "100% 100%";
  image.style.backgroundRepeat = "no-repeat";
}

function clearImageBacking(image: HTMLImageElement) {
  image.style.backgroundImage = "";
  image.style.backgroundSize = "";
  image.style.backgroundRepeat = "";
}

export function ImagePreviewOverlay({
  preview,
  onClose,
}: {
  preview: ImagePreviewRequest | null;
  onClose: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const transformRef = useRef<ImagePreviewTransform>({ scale: 1, x: 0, y: 0 });
  const frameRef = useRef<number | null>(null);
  const activeDragRef = useRef<ImagePreviewDrag | null>(null);
  const suppressNextClickRef = useRef(false);
  const [zoomLabel, setZoomLabel] = useState("100%");
  const [copyError, setCopyError] = useState<string | null>(null);
  // Which image of the card is on screen. The request names the one that was
  // clicked; the arrow keys move within its card without reopening the viewer.
  // A step counts for the request it was taken in, so a new request shows its
  // own picture from its first render: its motion starts on that element.
  const [steppedTo, setSteppedTo] = useState<{ request: ImagePreviewRequest; mediaRef: string | null } | null>(null);
  const shownMediaRef = steppedTo && steppedTo.request === preview ? steppedTo.mediaRef : preview?.mediaRef ?? null;

  const motionRef = useRef<ImagePreviewMotion | null>(null);
  /// The frame that waits for the original before the motion starts.
  const preparationRef = useRef<number | null>(null);
  /// The frame that takes the picture's layer off after a motion.
  const layerFrameRef = useRef<number | null>(null);
  /// The source the picture stands for, hidden on the page, and what its own
  /// `visibility` was.
  const hiddenSourceRef = useRef<{ element: HTMLElement; visibility: string } | null>(null);
  /// The original is decoded: the backing may go at rest.
  const decodedRef = useRef(false);
  const openedAsRef = useRef<ImagePreviewOpening>("instant");
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  /// The viewer is on its way out: the page takes the pointer and the keys
  /// from now on, but for the picture and the toolbar, which turn it back.
  const [closing, setClosing] = useState(false);
  /// The dialogs' own entrance or exit plays (`MODAL_SURFACE_*_CLASS`).
  const [dialogMotion, setDialogMotion] = useState<"in" | "out" | null>(null);

  const gallery = useMemo<ImagePreviewShown[]>(() => {
    if (!preview) return [];
    const siblings = preview.siblings ?? [];
    return siblings.some((item) => item.mediaRef === preview.mediaRef)
      ? siblings
      : [{ src: preview.src, mediaRef: preview.mediaRef }];
  }, [preview]);

  const shown = useMemo<ImagePreviewShown | null>(() => {
    if (!preview) return null;
    return (
      gallery.find((item) => item.mediaRef === shownMediaRef)
      ?? { src: preview.src, mediaRef: preview.mediaRef }
    );
  }, [gallery, preview, shownMediaRef]);

  // The requested picture returns to the frame it was pressed in: the same
  // file may stand in the card twice.
  const shownSource = !preview || !shown
    ? null
    : (shown.mediaRef === preview.mediaRef ? preview.source : shown.source) ?? null;
  const shownSourceRef = useRef(shownSource);
  useLayoutEffect(() => {
    shownSourceRef.current = shownSource;
  }, [shownSource]);

  /// An animated zoom is commanded but its frame has not written it yet.
  const animationPendingRef = useRef(false);
  /// When the running zoom animation ends; zero when none runs. Counted from
  /// the frame that writes the transform, where the transition really starts:
  /// a late frame moves the end with it (SPEC_AUDIT_FIXES.md, Б5.5).
  const animationEndRef = useRef(0);

  /// A gesture during the zoom animation continues from where the image is
  /// on screen, not from where the animation would have ended: the jump to
  /// the end point and back read as the image escaping the hand (А5.1).
  const settleRunningAnimation = useCallback(() => {
    const image = imageRef.current;
    if (!image) return;
    const mayBeMoving = animationPendingRef.current || performance.now() < animationEndRef.current;
    if (!mayBeMoving) return;
    animationPendingRef.current = false;
    animationEndRef.current = 0;
    const shown = visibleImagePreviewTransform(getComputedStyle(image).transform);
    image.style.transition = "none";
    if (!shown) return;
    transformRef.current = shown;
    image.style.transform = `translate3d(${shown.x}px, ${shown.y}px, 0) scale(${shown.scale})`;
  }, []);

  const applyTransform = useCallback((nextTransform: ImagePreviewTransform, animated = false) => {
    transformRef.current = constrainImagePreviewTransform(
      nextTransform,
      stageRef.current,
      imageRef.current,
    );
    // Reduced motion places the image at once (SPEC_AUDIT_FIXES.md, Ф12), and
    // during a motion the next frame takes the new place from here: the
    // picture has no second animation of its own.
    const animate = animated && !prefersReducedMotion() && motionRef.current === null;
    animationPendingRef.current = animate;
    if (!animate) animationEndRef.current = 0;
    const image = imageRef.current;
    if (image) {
      image.style.transition = animate
        ? `transform ${IMAGE_PREVIEW_ANIMATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`
        : "none";
    }
    if (frameRef.current !== null) {
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      if (animationPendingRef.current) {
        animationPendingRef.current = false;
        animationEndRef.current = performance.now() + IMAGE_PREVIEW_ANIMATION_MS;
      }
      const { scale, x, y } = transformRef.current;
      const currentImage = imageRef.current;
      if (currentImage) {
        if (motionRef.current === null) {
          currentImage.style.transform = imagePreviewRestTransform({ scale, x, y });
        }
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

  useLayoutEffect(() => {
    if (!preview) {
      return;
    }
    transformRef.current = { scale: 1, x: 0, y: 0 };
    activeDragRef.current = null;
    suppressNextClickRef.current = false;
    setZoomLabel("100%");
    setCopyError(null);
    applyTransform({ scale: 1, x: 0, y: 0 });
    overlayRef.current?.focus({ preventScroll: true });
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [applyTransform, preview, shown?.mediaRef]);

  /** The picture stands for `element` on the page: its place shows nothing
   *  there, and the one it stood for before shows again. */
  const hideSource = useCallback((element: HTMLElement | null) => {
    const hidden = hiddenSourceRef.current;
    if (hidden?.element === element) return;
    if (hidden) hidden.element.style.visibility = hidden.visibility;
    hiddenSourceRef.current = null;
    if (element) {
      hiddenSourceRef.current = { element, visibility: element.style.visibility };
      element.style.visibility = "hidden";
    }
  }, []);

  /** The picture at rest gives back what only a motion needed: the size held
   *  for an original not yet loaded, and the backing once it is decoded. */
  const settleImageAtRest = useCallback(() => {
    const image = imageRef.current;
    if (!image || motionRef.current || preparationRef.current !== null) return;
    if (image.naturalWidth > 0) {
      image.style.width = "";
      image.style.height = "";
    }
    if (decodedRef.current) clearImageBacking(image);
  }, []);

  /** Everything the motion wrote comes off: the viewer stands at rest. */
  const clearMotionStyles = useCallback(() => {
    for (const element of [scrimRef.current, controlsRef.current]) {
      if (element) element.style.opacity = "";
    }
    const image = imageRef.current;
    if (!image) return;
    image.style.opacity = "";
    image.style.clipPath = "";
    image.style.visibility = "";
    image.style.transform = imagePreviewRestTransform(transformRef.current);
  }, []);

  const cancelFrames = useCallback(() => {
    if (preparationRef.current !== null) cancelAnimationFrame(preparationRef.current);
    preparationRef.current = null;
    if (layerFrameRef.current !== null) cancelAnimationFrame(layerFrameRef.current);
    layerFrameRef.current = null;
    const motion = motionRef.current;
    if (motion?.frame != null) cancelAnimationFrame(motion.frame);
    motionRef.current = null;
  }, []);

  /** The motion stops here and the viewer stands at rest in this frame. */
  const landNow = useCallback(() => {
    cancelFrames();
    clearMotionStyles();
    const image = imageRef.current;
    if (image) image.style.willChange = "";
    settleImageAtRest();
    setDialogMotion(null);
  }, [cancelFrames, clearMotionStyles, settleImageAtRest]);

  /** Gone in this frame (Escape; a request that replaces this one). */
  const stopAll = useCallback(() => {
    cancelFrames();
    hideSource(null);
    clearMotionStyles();
    const image = imageRef.current;
    if (image) {
      image.style.willChange = "";
      clearImageBacking(image);
    }
    closingRef.current = false;
    setClosing(false);
    setDialogMotion(null);
  }, [cancelFrames, clearMotionStyles, hideSource]);

  const step = useCallback((direction: -1 | 1) => {
    if (gallery.length < 2 || !shown) return;
    const index = gallery.findIndex((item) => item.mediaRef === shown.mediaRef);
    if (index < 0) return;
    // Wraps, so a long press on one arrow keeps cycling instead of dead-ending.
    const next = gallery[(index + direction + gallery.length) % gallery.length];
    if (!next || !preview) return;
    // An arrow is a key: the picture it replaces does not finish its way.
    landNow();
    if (hiddenSourceRef.current) hideSource(next.source ?? null);
    setSteppedTo({ request: preview, mediaRef: next.mediaRef });
  }, [gallery, hideSource, landNow, preview, shown]);

  /** Writes one frame of the motion. */
  const paint = useCallback(() => {
    const motion = motionRef.current;
    if (!motion) return;
    const progress = clampUnit(motion.spring.position);
    if (scrimRef.current) scrimRef.current.style.opacity = String(progress);
    if (controlsRef.current) controlsRef.current.style.opacity = String(motion.toolbar);
    const image = imageRef.current;
    if (!image) return;
    if (!motion.way) {
      image.style.opacity = String(progress);
      return;
    }
    const frame = imagePreviewFrame(motion.way.place, motion.way.laid, transformRef.current, progress);
    image.style.transform = frame.transform;
    image.style.clipPath = frame.clipPath;
  }, []);

  /** The motion's last frame was written. Open, the clip and the opacities go
   *  a frame later and the picture's layer the frame after, one change a frame
   *  (SPEC_CARD_PEEK.md, О12). Closed, the picture stays a frame exactly on the
   *  source, the source shows under it the next frame, and the viewer goes the
   *  frame after (О11, п. 4). */
  const finish = useCallback((motion: ImagePreviewMotion) => {
    motion.landing = true;
    motion.frame = requestAnimationFrame(() => {
      motion.frame = null;
      if (motionRef.current !== motion) return;
      if (motion.spring.target === 1) {
        motionRef.current = null;
        clearMotionStyles();
        settleImageAtRest();
        layerFrameRef.current = requestAnimationFrame(() => {
          layerFrameRef.current = null;
          if (imageRef.current) imageRef.current.style.willChange = "";
        });
        return;
      }
      hideSource(null);
      motion.frame = requestAnimationFrame(() => {
        motion.frame = null;
        if (motionRef.current !== motion) return;
        motionRef.current = null;
        onCloseRef.current();
      });
    });
  }, [clearMotionStyles, hideSource, settleImageAtRest]);

  const tick = useCallback((now: number) => {
    const motion = motionRef.current;
    if (!motion) return;
    // One frame at most: a frame held up slows the picture, never jumps it.
    const step = Math.min(CARD_PEEK_FRAME_STEP_MS, Math.max(0, now - motion.last));
    motion.last = now;
    motion.spring = stepPeekSpring(motion.spring, step);
    motion.elapsed += step;
    motion.toolbar = motion.way
      ? peekContentOpacity(motion.spring.target === 1 ? "in" : "out", motion.elapsed, motion.toolbarStart)
      : clampUnit(motion.spring.position);
    const settled = peekSpringSettled(motion.spring);
    if (settled) {
      motion.spring = { position: motion.spring.target, velocity: 0, target: motion.spring.target };
      motion.toolbar = motion.spring.target;
    }
    paint();
    motion.written += 1;
    // From the second frame, under a picture that has been drawn over it.
    if (motion.way && motion.written === 1 && shownSourceRef.current) hideSource(shownSourceRef.current);
    if (settled) {
      finish(motion);
      return;
    }
    motion.frame = requestAnimationFrame(tick);
  }, [finish, hideSource, paint]);

  const runMotion = useCallback((
    spring: PeekSpring,
    way: ImagePreviewMotion["way"],
    toolbar: number,
  ) => {
    if (layerFrameRef.current !== null) cancelAnimationFrame(layerFrameRef.current);
    layerFrameRef.current = null;
    const motion: ImagePreviewMotion = {
      spring,
      way,
      elapsed: 0,
      last: performance.now(),
      frame: null,
      written: 0,
      toolbar,
      toolbarStart: toolbar,
      landing: false,
    };
    motionRef.current = motion;
    const image = imageRef.current;
    if (image && way) image.style.willChange = "transform";
    paint();
    if (image) image.style.visibility = "";
    motion.frame = requestAnimationFrame(tick);
  }, [paint, tick]);

  /** The running motion turns to `target` from where it stands, keeping its
   *  speed: the spring carries position and velocity through the turn. */
  const turn = useCallback((motion: ImagePreviewMotion, target: 0 | 1) => {
    motion.spring = { ...motion.spring, target };
    motion.elapsed = 0;
    motion.toolbarStart = motion.toolbar;
    closingRef.current = target === 0;
    setClosing(target === 0);
  }, []);

  /** A gesture on the picture while it leaves: it stays (Ф12). */
  const takeOver = useCallback(() => {
    const motion = motionRef.current;
    if (motion && !motion.landing && motion.spring.target === 0) turn(motion, 1);
  }, [turn]);

  /** The opening's first frame, once the original is decoded or the wait is
   *  over: measured here, once. */
  const beginOpening = useCallback((kind: ImagePreviewOpening, source: HTMLElement | null) => {
    const image = imageRef.current;
    if (kind === "flight" && image && source) {
      const laid = measureLaidImage(image, source);
      const place = laid && readImagePreviewPlace(source, laid.width, laid.height);
      if (laid && place) {
        const drawn = imagePreviewDrawnAddress(source);
        if (drawn && drawn !== image.src) setImageBacking(image, drawn);
        runMotion({ position: 0, velocity: 0, target: 1 }, { laid, place }, 0);
        return;
      }
      // The source is off screen or the picture has no size at all.
      openedAsRef.current = "dialog";
      clearMotionStyles();
      setDialogMotion("in");
      return;
    }
    if (image) image.style.opacity = "0";
    runMotion({ position: 0, velocity: 0, target: 1 }, null, 0);
  }, [clearMotionStyles, runMotion]);

  // A new request: whatever ran is gone in this frame, and the new opening
  // writes its unseen first state before anything is painted.
  useLayoutEffect(() => {
    stopAll();
    if (!preview) return;
    const source = preview.source ?? null;
    const kind = imagePreviewOpeningKind({
      keyboard: preview.openedBy === "keyboard",
      reducedMotion: prefersReducedMotion(),
      hasSource: source !== null,
    });
    openedAsRef.current = kind;
    if (kind === "instant") return;
    if (kind === "dialog") {
      setDialogMotion("in");
      return;
    }
    const image = imageRef.current;
    if (scrimRef.current) scrimRef.current.style.opacity = "0";
    if (controlsRef.current) controlsRef.current.style.opacity = "0";
    if (image) image.style.visibility = "hidden";
    decodedRef.current = false;
    let ready = false;
    // An original the source draws already is decoded, and `decode()` is not
    // to be asked of it: until it resolves WebKit blanks every picture of that
    // address on the page, the source first of all.
    const decodable = image && typeof image.decode === "function"
      && !(source && imagePreviewDrawnAddress(source) === image.src);
    if (image && decodable) {
      // A picture that cannot be decoded has nothing to wait for either: a
      // broken file leaves the plane by its own `onError`.
      const settled = () => {
        ready = true;
        if (imageRef.current !== image) return;
        decodedRef.current = true;
        settleImageAtRest();
      };
      void image.decode().then(settled, settled);
    } else {
      ready = true;
      decodedRef.current = true;
    }
    const since = performance.now();
    const wait = (now: number) => {
      preparationRef.current = null;
      if (ready || now - since >= CARD_PEEK_PREPARE_MAX_MS) {
        beginOpening(kind, source);
        return;
      }
      preparationRef.current = requestAnimationFrame(wait);
    };
    preparationRef.current = requestAnimationFrame(wait);
  }, [beginOpening, preview, settleImageAtRest, stopAll]);

  useLayoutEffect(() => stopAll, [stopAll]);

  /** Gone in this frame: Escape, or a closing before anything showed. */
  const vanish = useCallback(() => {
    stopAll();
    onCloseRef.current();
  }, [stopAll]);

  /** The button or the background: the way back from where it stands. */
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    if (preparationRef.current !== null) {
      vanish();
      return;
    }
    const motion = motionRef.current;
    if (motion && !motion.landing) {
      turn(motion, 0);
      return;
    }
    // A motion that only takes its styles off lands now, in this frame.
    if (motion) landNow();
    settleRunningAnimation();
    const image = imageRef.current;
    const laid = image && shownSource ? measureLaidImage(image, shownSource) : null;
    const place = laid && shownSource ? readImagePreviewPlace(shownSource, laid.width, laid.height) : null;
    const kind = imagePreviewClosingKind({
      openedAs: openedAsRef.current,
      reducedMotion: prefersReducedMotion(),
      sourceOnScreen: place !== null,
    });
    closingRef.current = true;
    setClosing(true);
    if (kind === "flight" && laid && place) {
      setDialogMotion(null);
      hideSource(shownSource);
      runMotion({ position: 1, velocity: 0, target: 0 }, { laid, place }, 1);
      return;
    }
    if (kind === "fade") {
      setDialogMotion(null);
      runMotion({ position: 1, velocity: 0, target: 0 }, null, 1);
      return;
    }
    hideSource(null);
    setDialogMotion("out");
  }, [hideSource, landNow, runMotion, settleRunningAnimation, shownSource, turn, vanish]);

  // The second press of a double click is not a press of its own: the one
  // that closed the viewer is done, and it reaches neither the picture nor
  // the page under it (SPEC_CARD_PEEK.md, О11).
  useEffect(() => {
    if (!closing) return;
    const drop = (event: MouseEvent) => {
      if (event.detail < 2) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("click", drop, true);
    window.addEventListener("dblclick", drop, true);
    return () => {
      window.removeEventListener("click", drop, true);
      window.removeEventListener("dblclick", drop, true);
    };
  }, [closing]);

  const handleStageAnimationEnd = useCallback((event: ReactAnimationEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (dialogMotion === "out") vanish();
    else setDialogMotion(null);
  }, [dialogMotion, vanish]);

  useEffect(() => {
    if (!preview) {
      return;
    }
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        vanish();
        return;
      }
      // On its way out the viewer leaves the rest to the page.
      if (closingRef.current) {
        return;
      }
      // Arrows are claimed only while the viewer is open and the card actually
      // has more than one image, so card-to-card navigation underneath keeps
      // working in every other case.
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      if (gallery.length < 2) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      step(event.key === "ArrowLeft" ? -1 : 1);
    };
    // On the window, ahead of the document: the viewer is the top layer, and
    // a tooltip left open under it (⤢ focused by the key that opened it) must
    // not take its Escape.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [gallery.length, preview, step, vanish]);

  const stepScale = useCallback((direction: -1 | 1) => {
    takeOver();
    applyScaleAtStageCenter(
      transformRef.current.scale + direction * IMAGE_PREVIEW_BUTTON_SCALE_STEP,
      true,
    );
  }, [applyScaleAtStageCenter, takeOver]);

  const toggleImageScale = useCallback((clientX: number, clientY: number) => {
    applyScaleAtPoint(
      Math.abs(transformRef.current.scale - 1) < 0.001 ? IMAGE_PREVIEW_TOGGLE_SCALE : 1,
      clientX,
      clientY,
      true,
    );
  }, [applyScaleAtPoint]);

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    takeOver();
    settleRunningAnimation();
    const nextScale = transformRef.current.scale * Math.exp(-event.deltaY * IMAGE_PREVIEW_WHEEL_SCALE_STEP);
    applyScaleAtPoint(nextScale, event.clientX, event.clientY);
  }, [applyScaleAtPoint, settleRunningAnimation, takeOver]);

  const handleImageClick = useCallback((event: ReactMouseEvent<HTMLImageElement>) => {
    event.stopPropagation();
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    // The second press of the double click that opened the viewer lands on
    // the picture on its way: it is not a press of its own (О11).
    if (motionRef.current && event.detail >= 2) {
      return;
    }
    takeOver();
    toggleImageScale(event.clientX, event.clientY);
  }, [takeOver, toggleImageScale]);

  const handleImagePointerDown = useCallback((event: ReactPointerEvent<HTMLImageElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    takeOver();
    settleRunningAnimation();
    activeDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [settleRunningAnimation, takeOver]);

  const handleImagePointerMove = useCallback((event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = activeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
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
  }, [applyTransform]);

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

  const shownMediaAsset = shown?.mediaRef ?? null;
  const copyImage = useCallback(() => {
    if (shownMediaAsset === null) {
      return;
    }
    setCopyError(null);
    // Copies what is on screen, which after an arrow press is no longer the
    // image the viewer was opened with.
    void copyMediaAssetToClipboard(shownMediaAsset)
      .catch((error) => setCopyError(error instanceof Error ? error.message : String(error)));
  }, [shownMediaAsset]);

  if (!preview || !shown) {
    return null;
  }

  // On its way out the viewer keeps the pointer only where it can turn back;
  // the dialogs' exit has nothing to turn back to.
  const interactiveWhileClosing = closing && dialogMotion !== "out" && "pointer-events-auto";

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      // Focused only to take the preview's keys: no ring around the window.
      className={cn(
        "fixed inset-0 z-[70] overflow-hidden text-black outline-none",
        closing && "pointer-events-none",
      )}
      role="dialog"
      aria-modal="false"
      aria-label="Image preview"
      data-image-preview-overlay
      onClick={(event) => {
        // The second press of the double click that opened the viewer lands
        // here: it is not a press of its own (О11).
        if (event.detail >= 2) return;
        requestClose();
      }}
      onWheel={handleWheel}
    >
      {/* The scrim alone takes the motion's opacity: an opacity over the
          picture and the toolbar would cut the blur off from the page. */}
      <div
        ref={scrimRef}
        aria-hidden="true"
        className={cn(
          "modal-scrim image-preview-secondary-plane absolute inset-0",
          MOVED_CLASS,
          dialogMotion === "in" && MODAL_SCRIM_ENTER_CLASS,
          dialogMotion === "out" && MODAL_SCRIM_LEAVE_CLASS,
        )}
        data-image-preview-scrim
      />
      <div
        ref={stageRef}
        className={cn(
          "relative z-10 flex h-full w-full items-center justify-center overflow-hidden p-8 pb-20",
          dialogMotion === "in" && MODAL_SURFACE_ENTER_CLASS,
          dialogMotion === "out" && MODAL_SURFACE_LEAVE_CLASS,
        )}
        data-image-preview-stage
        onAnimationEnd={handleStageAnimationEnd}
      >
        {/* A file that will not load leaves the plane, never the
            broken-image icon (SPEC_DEEP_AUDIT.md, Е6.8). */}
        <MissingAwareImage
          key={shown.src}
          ref={imageRef}
          src={shown.src}
          className={cn(
            "image-preview-primary-media max-h-[calc(100vh-8rem)] max-w-[calc(100vw-4rem)] origin-center cursor-grab select-none object-contain active:cursor-grabbing",
            MOVED_CLASS,
            interactiveWhileClosing,
          )}
          draggable={false}
          data-image-preview-image
          data-detail-image-preview-scale="1.000"
          data-detail-image-preview-translate-x="0.000"
          data-detail-image-preview-translate-y="0.000"
          style={{ touchAction: "none" }}
          onClick={handleImageClick}
          onDragStart={(event) => event.preventDefault()}
          onLoad={() => {
            applyTransform(transformRef.current);
            settleImageAtRest();
          }}
          onPointerDown={handleImagePointerDown}
          onPointerMove={handleImagePointerMove}
          onPointerUp={finishImageDrag}
          onPointerCancel={finishImageDrag}
        />
      </div>
      <div
        ref={controlsRef}
        className={cn(
          // A floating layer like every menu (DESIGN_SYSTEM.md, «Оверлеи»):
          // its own surface and line, so it reads on the shared scrim in either
          // theme. No shadow on the island or the image (user decision
          // 16.10.2026). A translucent
          // `bg-accent/90` made for the old always dark plane all but vanished
          // on the light scrim (16.10.2026). Always on screen: the controls
          // never hide, the pointer need not wake them (user decision
          // 16.10.2026; until then they left after 3 s without movement).
          "absolute bottom-6 left-1/2 z-20 flex h-8 -translate-x-1/2 items-center gap-1 rounded-1 border border-border bg-popover px-1 text-popover-foreground",
          MOVED_CLASS,
          interactiveWhileClosing,
          dialogMotion === "in" && MODAL_SURFACE_ENTER_CLASS,
          dialogMotion === "out" && MODAL_SURFACE_LEAVE_CLASS,
        )}
        data-image-preview-controls
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
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
          <Minus className="size-[13px]" />
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
          <Plus className="size-[13px]" />
        </Button>
        <div className="h-6 w-px bg-border" />
        {/* Copy Media copies a media file; a picture that is no media asset
            names none (SPEC_MEDIA_ASSET_ACTIONS.md, «Картинка страницы у
            ссылки»). */}
        {shownMediaAsset !== null && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Copy media"
              data-image-preview-copy
              onClick={copyImage}
              className="text-muted-foreground hover:text-foreground"
            >
              <Copy className="size-[13px]" />
            </Button>
            <div className="h-6 w-px bg-border" />
          </>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Collapse image preview"
          data-image-preview-collapse
          onClick={requestClose}
          className="text-muted-foreground hover:text-foreground"
        >
          <Minimize2 className="size-[13px]" />
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
