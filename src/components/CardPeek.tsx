// TRIAL (SPEC_CARD_PEEK.md; user's requests of 23.10.2026): the open card's
// window over the right part, the view «Peek» of the Display panel's «Card
// view» (src/lib/cardView.ts). The page decides which card is open and how
// the next closing goes; this component owns the window's motion.
//
// The right part (О3; user's decision of 23.10.2026) runs from the top of
// the page's top rows, under the tab bar, to the bottom bar, beside the
// sidebar: the top rows over the feed lie under it too (`CardPeekArea`). The
// window stands `M` off every edge of it by CSS, so it follows the right part
// in every frame with no motion of its own (О4). The right part round it is
// blurred by the product's one scrim (`.modal-scrim`, О6). A click on its
// card grows it out of that card and shrinks it back there; a key fades it
// in place; anything else brings it out of the right part's centre at 95 %
// (О10, О11). One spring drives every movement, read each frame, so a
// reversal turns back from where the window is without a jump or a break in
// speed (О12). Only `transform` and `opacity` move: the frame is drawn in
// pieces while the window moves, the content is clipped by a box scaled to
// the frame and scaled back inside it, and the card's picture rides a clip of
// its own (cardPeek.ts). At rest the window is one plain surface with no
// layer of its own.
//
// The window's width follows where the card's panel stands, beside the
// content or under it, as the window's place decides (О3, О8): the card
// tells its content's width (detailFrame.ts) and takes the layout it is
// given. A change of width moves only the frame's edges, in the same pieces
// and by the same spring; the card stands in its new layout at once, laid
// out once, clipped by the edges.
//
// A motion carries a finished card. Before the window starts it is laid out
// unseen and waits, `CARD_PEEK_PREPARE_MAX_MS` at most, for the card's own
// work (its file, its editor's session) and for its picture, decoded; the
// window's ends are measured then, once. While it moves nothing is committed
// into the window: the page's renders keep the content as it was, and what
// the card learns late lands once the window rests (detailMotionGate.ts).
// The window's size is heard by a ResizeObserver, never read in a frame.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { ArrowDown, Maximize2 } from "lucide-react";
import {
  CARD_PEEK_CENTER_SCALE,
  CARD_PEEK_FRAME_STEP_MS,
  CARD_PEEK_MARGIN_PX,
  CARD_PEEK_MAX_WIDTH,
  CARD_PEEK_NUDGE_OFFSET_PX,
  CARD_PEEK_NUDGE_SCALE,
  CARD_PEEK_PLATE_HEIGHT_PX,
  CARD_PEEK_PREPARE_MAX_MS,
  CARD_PEEK_RADIUS_PX,
  PEEK_FRAME_CORNERS,
  PEEK_FRAME_PIECES,
  carriedPeekMediaPlace,
  cardPeekStackedMaxWidth,
  centerPeekRect,
  centredPeekRect,
  clampUnit,
  intersectPeekRect,
  lerpPeekRect,
  peekClosingKind,
  peekContentOpacity,
  peekFrameCut,
  peekFrameTransforms,
  peekMediaTransforms,
  peekNudgeTransform,
  peekNudgeUndoTransform,
  peekOpeningKind,
  peekSpringSettled,
  peekSurfaceTransforms,
  peekWindowLayout,
  lerp,
  relativePeekRect,
  setPeekHiddenSlug,
  stepPeekSpring,
  type CardPeekExit,
  type PeekFrameCorner,
  type PeekFrameCut,
  type PeekFramePiece,
  type PeekMediaPlace,
  type PeekMotionKind,
  type PeekOpeningFrom,
  type PeekRect,
  type PeekSource,
  type PeekSpring,
} from "@/lib/cardPeek";
import {
  detailPeekMediaFrame,
  detailPeekMediaSource,
  feedCardSelector,
  findPeekSource,
  rectOf,
} from "@/lib/cardPeekSource";
import { HoverIntentDragWatch, useHoverIntent } from "@/hooks/useHoverIntent";
import { HOVER_INTENT } from "@/lib/hoverIntent";
import { commandById } from "@/lib/commandRegistry";
import { usePeekWidth, type PeekWidth } from "@/lib/cardView";
import type { DetailLayoutMode } from "@/lib/detailLayout";
import { prefersReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { IndexedBlock, LightBlock, RenameBlockError, TagCount } from "@/types";
import { CardMoreMenu } from "./CardHoverMenu";
import { ChromeActions } from "./ChromeRow";
import { Separator } from "./ui/separator";
import { ChromeCloseButton } from "./ChromeCloseButton";
import { DetailFrameContext, type DetailFrame } from "./detailFrame";
import { DetailMotionGateContext, type DetailMotionGate } from "./detailMotionGate";
import { DetailCardFileName } from "./MainSecondaryChrome";
import { Button } from "./ui/button";

type PeekBlock = LightBlock | IndexedBlock;

/** How the latest opening began, told by the page with the open card. */
export interface CardPeekOpening {
  /** One more for every opening. */
  sequence: number;
  slug: string;
  from: PeekOpeningFrom;
  /** Opened with the tab, at its launch or its return (О10). */
  restored: boolean;
}

export interface CardPeekProps {
  /** The open card; null once it closes. */
  block: PeekBlock | null;
  opening: CardPeekOpening | null;
  /** How the window goes when `block` turns null. */
  exit: CardPeekExit;
  /** The right part the window stands over. */
  areaRef: RefObject<HTMLElement | null>;
  /** The scrim was pressed, or Escape came while the window grew. */
  onClose: () => void;
  /** The closing window was pressed: open its card again (О11). */
  onReopen: (block: PeekBlock) => void;
  /** The window's content: the open card and its plate. */
  children: (block: PeekBlock) => ReactNode;
}

/** The window's movements: its opening and closing, and `resize`, the
 *  window at its place narrowing to its content or widening for the panel
 *  beside it (О3, О8). */
type MovingKind = Exclude<PeekMotionKind, "instant"> | "resize";

/** A movement under way. Its numbers live here, not in React state: every
 *  frame writes the page directly. */
interface PeekMotion {
  kind: MovingKind;
  slug: string;
  spring: PeekSpring;
  direction: "in" | "out";
  /** The frame time of the last frame written, the spring's clock. */
  last: number;
  /** The motion's own time in its present direction: the sum of the
   *  spring's steps, so the content's third follows the spring even when a
   *  frame was held up. */
  elapsed: number;
  contentStart: number;
  content: number;
  /** The card's frame, in the window's space (`card` only). */
  card: PeekRect | null;
  cardMedia: PeekMediaPlace | null;
  windowMedia: PeekMediaPlace | null;
  /** The picture's place in the window is not one of the window's own
   *  frames (a gallery, no frame at all): it fades under the content. */
  mediaFades: boolean;
  /** The window's own picture, hidden while the card's rides over it. */
  hiddenFrame: HTMLElement | null;
  /** Where the carried picture is laid out: its place at the window's end,
   *  so it is drawn no larger than it lands (null: the whole window). */
  mediaLaid: PeekRect | null;
  /** `resize`: the window's width at either end of the spring, 0 and 1;
   *  null, the end it goes to, follows the window's place. */
  widths: [number | null, number | null];
  /** The window's width at its end of an opening or a closing, centred at
   *  its place; null, its place's (a closing that cut a resize short starts
   *  from the width it had). */
  windowWidth: number | null;
  frame: number | null;
}

/** The window's width, and the layout of the card in it, as the window's
 *  place decided last (О3, О8); null until the card told its content. */
interface PeekFrameLayout {
  layout: DetailLayoutMode;
  contentWidth: number;
  /** «Peek width» (cardView.ts): `fit`, no wider than the card; `fill`,
   *  `M` off every edge of the right part. */
  width: PeekWidth;
}

/** The window's widest, by CSS: `fill` none, `fit` the card's widest or,
 *  with the panel under the content, the content's (О3). */
function frameMaxWidth(frame: PeekFrameLayout | null, width: PeekWidth): string {
  if ((frame?.width ?? width) === "fill") return "none";
  return frame?.layout === "stacked" ? cardPeekStackedMaxWidth(frame.contentWidth) : CARD_PEEK_MAX_WIDTH;
}

/** Waiting, before a movement, for the card to be whole. */
interface PeekPreparation {
  frame: number | null;
  /** The picture the movement carries, once decoded (null while it is
   *  decoding, or when there is none to carry). */
  picture: PeekPicture | null;
  /** The picture is still decoding. */
  decoding: boolean;
}

/** The picture a movement carries: an `<img>` decoded before the start (the
 *  window's own original, so the end needs no swap), a canvas drawn from
 *  what the card shows when the window has no picture of its own, or a
 *  gallery's copy of its tiles, laid out at the card's size on `stage` and
 *  scaled to the carried box. */
interface PeekPicture {
  element: HTMLElement;
  naturalWidth: number;
  naturalHeight: number;
  stage?: HTMLElement;
}

/** What stands on the page while the window moves. */
interface PeekMotionView {
  id: number;
  kind: MovingKind;
  cardRadius: number;
  windowRadius: number;
  fill: string;
}

/** The pieces a frame paint writes, gathered once per movement. */
interface PeekPieces {
  /** The frame's pieces, under and over the surface: pieces of one name
   *  move alike. */
  frame: { element: HTMLElement; piece: PeekFramePiece }[];
  weights: HTMLElement[];
  mediaClip: HTMLElement | null;
  mediaImage: HTMLElement | null;
  /** A gallery's other tiles and seams, at the card's place. */
  rest: HTMLElement | null;
  /** The card's line under its media, carried with the frame. */
  outline: HTMLElement | null;
}

/** The longest side a canvas picture is drawn at, in device pixels. */
const MEDIA_CANVAS_MAX_PX = 2048;

/** How long, at rest, the carried picture waits for the window's own
 *  original to show under it before it goes anyway. */
const PICTURE_HANDOVER_MAX_MS = 1000;

/** The card's frame in the feed while the window stands for it (global.css,
 *  «Card peek»): one attribute on one element, no stylesheet change. */
const HIDDEN_CARD_ATTRIBUTE = "data-card-peek-hidden";

/** A piece of the frame: moved by the spring, drawn in the window's own
 *  layer (thirty layers of their own cost WebKit a long frame to make and
 *  to drop, DESIGN_SYSTEM.md, «Слои композиции»). */
const FRAME_PIECE_CLASS = "pointer-events-none absolute origin-top-left transition-none";

/** The carried picture and its clip: large and moving, each on a layer for
 *  the movement only (they are on the page only while it lasts). */
const FLYER_CLASS = "pointer-events-none absolute origin-top-left will-change-transform transition-none";

/** A gallery's other tiles and seams: still, at the card's place, they only
 *  fade, on a layer for the movement only. */
const REST_CLASS = "pointer-events-none absolute overflow-hidden will-change-[opacity] transition-none";

/** What the motion writes moves only by the spring: no CSS transition of
 *  its own, the 0.01 ms one "Reduce motion" gives every element included
 *  (global.css), which would show each frame's value a frame late and the
 *  window's first frame at full opacity. */
const MOVED_CLASS = "transition-none";

/** The dialogs' exit (ui/modal-window.ts, DESIGN_SYSTEM.md, «Окна»): the
 *  window's as their surface's, the scrim's as their overlay's (О11). */
const DIALOG_LEAVE_CLASS = "animate-out fade-out-0 zoom-out-95 duration-200 fill-mode-forwards";
const DIALOG_SCRIM_LEAVE_CLASS = "animate-out fade-out-0 fill-mode-forwards";

/** On the root while a menu is on the page (openMenus.ts). */
const MENU_OPEN_ATTRIBUTE = "data-menu-open";

/** The scrim as the one target of the window's hover intent (О15). */
const SCRIM_TARGET = "card-peek-scrim";

/** The free band over the window stepped back (О15): from the right part's
 *  top to the stepped window's top, `M` and the step's own way down, its
 *  scale taking half of what it takes from the window's height (the window
 *  is the right part's height less `M` on either side). The hint stands in
 *  its middle, across the right part, clear of the window. */
const HINT_BAND_STYLE: CSSProperties = {
  height: `calc(${Math.round((CARD_PEEK_MARGIN_PX + CARD_PEEK_NUDGE_OFFSET_PX) * 1e3) / 1e3}px + ${Math.round(((1 - CARD_PEEK_NUDGE_SCALE) / 2) * 1e6) / 1e6} * (100% - ${2 * CARD_PEEK_MARGIN_PX}px))`,
};

/** Where each piece is laid out at the window's place, by CSS, so it follows
 *  the right part as the window does (`peekFramePieceBoxes` reads the same
 *  boxes for the motion). */
function pieceStyle(piece: PeekFramePiece, cut: PeekFrameCut): CSSProperties {
  const r = cut.round;
  const k = cut.corner;
  switch (piece) {
    case "shadow": return { inset: 0 };
    case "bandAcross": return { left: 0, right: 0, top: r, bottom: r };
    case "bandDown": return { left: r, right: r, top: 0, bottom: 0 };
    case "lineTop": return { left: r, right: r, top: 0, height: 1 };
    case "lineBottom": return { left: r, right: r, bottom: 0, height: 1 };
    case "lineLeft": return { left: 0, top: r, bottom: r, width: 1 };
    case "lineRight": return { right: 0, top: r, bottom: r, width: 1 };
    case "cornerTopLeft": return { left: 0, top: 0, width: k, height: k };
    case "cornerTopRight": return { right: 0, top: 0, width: k, height: k };
    case "cornerBottomLeft": return { left: 0, bottom: 0, width: k, height: k };
    case "cornerBottomRight": return { right: 0, bottom: 0, width: k, height: k };
  }
}

/** A corner's shape inside its square: a rounded box twice the square's
 *  side, of which the square shows one corner. */
function cornerShapeStyle(corner: PeekFrameCorner, cut: PeekFrameCut, radius: number): CSSProperties {
  const size = cut.corner * 2;
  const horizontal = corner === "cornerTopLeft" || corner === "cornerBottomLeft" ? { left: 0 } : { right: 0 };
  const vertical = corner === "cornerTopLeft" || corner === "cornerTopRight" ? { top: 0 } : { bottom: 0 };
  return { width: size, height: size, borderRadius: radius, ...horizontal, ...vertical };
}

/** The frame under the window's surface: the shadow, the fill, the corners'
 *  fill. The card's fill gives way to the window's by the motion's share;
 *  of the two corner shapes the one that covers more lies on top and takes
 *  its own share, so every frame of a corner is one of the two shapes or
 *  between them (О10, п. 2). */
function PeekFrameUnder({ view, cut, children }: { view: PeekMotionView; cut: PeekFrameCut; children?: ReactNode }) {
  const cardOnTop = view.cardRadius <= view.windowRadius;
  const shape = (owner: "card" | "window", corner: PeekFrameCorner, weighted: boolean) => (
    <div
      className={cn("absolute", MOVED_CLASS, owner === "window" && "bg-background")}
      style={{
        ...cornerShapeStyle(corner, cut, owner === "card" ? view.cardRadius : view.windowRadius),
        ...(owner === "card" ? { background: view.fill } : null),
      }}
      data-peek-weight={weighted ? owner : undefined}
    />
  );
  // The corners' two shapes, the one under (unweighted) and the one over it
  // (weighted), drawn as two passes of the same pieces.
  const corners = (owner: "card" | "window", weighted: boolean) => PEEK_FRAME_CORNERS.map((corner) => (
    <div
      key={`${owner}-${corner}`}
      className={cn(FRAME_PIECE_CLASS, "overflow-hidden")}
      style={pieceStyle(corner, cut)}
      data-peek-piece={corner}
    >
      {shape(owner, corner, weighted)}
    </div>
  ));
  return (
    <>
      <div
        className={cn(FRAME_PIECE_CLASS, "shadow-lg")}
        style={{ ...pieceStyle("shadow", cut), borderRadius: CARD_PEEK_RADIUS_PX }}
        data-peek-piece="shadow"
        data-peek-weight="window"
      />
      <div className="pointer-events-none absolute inset-0" data-peek-fill="card">
        {(["bandAcross", "bandDown"] as const).map((piece) => (
          <div
            key={piece}
            className={FRAME_PIECE_CLASS}
            style={{ ...pieceStyle(piece, cut), background: view.fill }}
            data-peek-piece={piece}
          />
        ))}
      </div>
      {corners(cardOnTop ? "window" : "card", false)}
      {cardOnTop && corners("card", true)}
      {/* What stands under the window and over the card's fill (a gallery's
          other tiles, О11, п. 2): over the corners' card shape too, so the
          card's corner shows it at the end, under the window's fill. */}
      {children}
      <div className={cn("pointer-events-none absolute inset-0", MOVED_CLASS)} data-peek-fill="window" data-peek-weight="window">
        {(["bandAcross", "bandDown"] as const).map((piece) => (
          <div
            key={piece}
            className={cn(FRAME_PIECE_CLASS, "bg-background")}
            style={pieceStyle(piece, cut)}
            data-peek-piece={piece}
          />
        ))}
      </div>
      {!cardOnTop && corners("window", true)}
    </>
  );
}

/** The frame over the window's surface and the card's picture: the four
 *  lines and the corners' line, as the card's line lies over its picture. */
function PeekFrameOver({ view, cut }: { view: PeekMotionView; cut: PeekFrameCut }) {
  return (
    <>
      {(["lineTop", "lineBottom", "lineLeft", "lineRight"] as const).map((piece) => (
        <div
          key={piece}
          className={cn(FRAME_PIECE_CLASS, "bg-border")}
          style={pieceStyle(piece, cut)}
          data-peek-piece={piece}
        />
      ))}
      {PEEK_FRAME_CORNERS.map((corner) => (
        <div
          key={corner}
          className={cn(FRAME_PIECE_CLASS, "overflow-hidden")}
          style={pieceStyle(corner, cut)}
          data-peek-piece={corner}
        >
          {(["card", "window"] as const).map((owner) => (
            <div
              key={owner}
              className={cn("absolute border border-border", MOVED_CLASS)}
              style={cornerShapeStyle(corner, cut, owner === "card" ? view.cardRadius : view.windowRadius)}
              data-peek-weight={owner}
            />
          ))}
        </div>
      ))}
    </>
  );
}

/**
 * The right part the card's window stands over (О3): the sides and the
 * bottom of the feed's area (`sides`, the page's `main`) and the top of the
 * page's top rows (`top`), so the rows over the feed lie under the window's
 * scrim while the sidebar and its own segment of the row stay clear. Laid
 * over the page shell, it reads the two boxes whenever either changes size,
 * in the frame they change (a ResizeObserver notifies before the frame is
 * painted): the sidebar's collapse and its edge's drag move it with them.
 * What lies past its edges is cut there.
 */
export function CardPeekArea({
  areaRef,
  top,
  sides,
  children,
}: {
  areaRef: RefObject<HTMLDivElement | null>;
  top: HTMLElement | null;
  sides: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    const area = areaRef.current;
    const feed = sides.current;
    if (!area || !feed || !top) return undefined;
    const place = () => {
      const shell = area.offsetParent;
      if (!(shell instanceof HTMLElement)) return;
      const origin = shell.getBoundingClientRect();
      const rows = top.getBoundingClientRect();
      const box = feed.getBoundingClientRect();
      area.style.left = `${box.left - origin.left}px`;
      area.style.top = `${rows.top - origin.top}px`;
      area.style.width = `${box.width}px`;
      area.style.height = `${box.bottom - rows.top}px`;
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(feed);
    observer?.observe(top);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [areaRef, sides, top]);
  return (
    <div
      ref={areaRef}
      className="pointer-events-none absolute z-20 overflow-hidden"
      data-card-peek-area=""
    >
      {children}
    </div>
  );
}

/** Draws `drawable` into a new canvas at its own size, no larger than
 *  `MEDIA_CANVAS_MAX_PX` on its longest side. */
function canvasPicture(drawable: CanvasImageSource, naturalWidth: number, naturalHeight: number): PeekPicture {
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, MEDIA_CANVAS_MAX_PX / Math.max(naturalWidth, naturalHeight, 1));
  canvas.width = Math.max(1, Math.round(naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(naturalHeight * scale));
  canvas.getContext("2d")?.drawImage(drawable, 0, 0, canvas.width, canvas.height);
  return { element: canvas, naturalWidth, naturalHeight };
}

/** A gallery's copy of its tiles (cardPeekSource.ts) as a carried picture:
 *  laid out at its own size, `naturalWidth` by `naturalHeight`, so its seams
 *  stay 1 px when it lands. */
function copyPicture(copy: HTMLElement, naturalWidth: number, naturalHeight: number): PeekPicture {
  const stage = document.createElement("div");
  stage.className = "absolute left-0 top-0 origin-top-left overflow-hidden";
  Object.assign(stage.style, { width: `${naturalWidth}px`, height: `${naturalHeight}px` });
  stage.append(copy);
  const element = document.createElement("div");
  element.append(stage);
  return { element, naturalWidth, naturalHeight, stage };
}

/** An `<img>` of `source`, decoded off the main thread; null when it cannot
 *  be. */
function decodedPicture(source: string): Promise<PeekPicture | null> {
  const image = new Image();
  image.decoding = "async";
  image.src = source;
  return image.decode().then(
    () => ({ element: image, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight }),
    () => null,
  );
}

/** The carried picture's box: where it lands, or the whole window. */
function flyerBox(laid: PeekRect | null): CSSProperties {
  return laid
    ? { left: laid.x, top: laid.y, width: laid.width, height: laid.height }
    : { inset: 0 };
}

/** The card's frame as a source, in the window's space. */
function sourcePlace(source: PeekSource, origin: { x: number; y: number }) {
  const rest = source.media?.rest;
  return {
    rect: relativePeekRect(source.rect, origin),
    media: source.media
      ? { clip: relativePeekRect(source.media.clip, origin), image: relativePeekRect(source.media.image, origin) }
      : null,
    rest: rest ? { element: rest.element, rect: relativePeekRect(rest.rect, origin) } : null,
    outline: source.outline ? { element: source.outline.element, rect: relativePeekRect(source.outline.rect, origin) } : null,
  };
}

/** The open card's window over the right part. */
export function CardPeek({ block, opening, exit, areaRef, onClose, onReopen, children }: CardPeekProps) {
  // The card the window shows: the open one, and the last one while the
  // window leaves.
  const [held, setHeld] = useState<PeekBlock | null>(block);
  if (block && block !== held) setHeld(block);
  const [view, setView] = useState<PeekMotionView | null>(null);
  const [flyer, setFlyer] = useState<{
    id: number;
    picture: PeekPicture;
    laid: PeekRect | null;
    /** A gallery's other tiles and seams, in the window's space. */
    rest: { element: HTMLElement; rect: PeekRect } | null;
    /** The card's line under its media, in the window's space. */
    outline: { element: HTMLElement; rect: PeekRect } | null;
  } | null>(null);
  const flyerRef = useRef<PeekPicture | null>(null);
  flyerRef.current = flyer?.picture ?? null;
  const flyerLaidRef = useRef<PeekRect | null>(null);
  flyerLaidRef.current = flyer?.laid ?? null;
  const flyerRestRef = useRef<HTMLElement | null>(null);
  flyerRestRef.current = flyer?.rest?.element ?? null;
  const flyerRestBoxRef = useRef<PeekRect | null>(null);
  flyerRestBoxRef.current = flyer?.rest?.rect ?? null;
  const flyerOutlineRef = useRef<{ element: HTMLElement; rect: PeekRect } | null>(null);
  flyerOutlineRef.current = flyer?.outline ?? null;
  const [closing, setClosing] = useState(false);
  const [preparing, setPreparing] = useState(false);
  // Whether the content takes the page's renders: not while the window moves.
  const [live, setLive] = useState(true);
  const motionRef = useRef<PeekMotion | null>(null);
  const preparationRef = useRef<PeekPreparation | null>(null);
  const openedAsRef = useRef<PeekMotionKind>("instant");
  const viewIdRef = useRef(0);
  const piecesRef = useRef<PeekPieces | null>(null);
  const previousRef = useRef<string | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const hiddenCardRef = useRef<HTMLElement | null>(null);
  const handoverRef = useRef<number | null>(null);
  // The picture an opening carried, kept decoded for the closing.
  const restPictureRef = useRef<PeekPicture | null>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const mediaClipRef = useRef<HTMLDivElement>(null);
  const restRef = useRef<HTMLDivElement>(null);
  const outlineRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<PeekMotionView | null>(null);
  viewRef.current = view;
  const exitRef = useRef(exit);
  exitRef.current = exit;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const heldRef = useRef(held);
  heldRef.current = held;
  const closingRef = useRef(closing);
  closingRef.current = closing;

  // The window's width and the card's layout in it (О3, О8): decided by the
  // window's place and the content the card told of, applied at once while
  // the window is unseen, carried by the spring once it shows.
  const [frameLayout, setFrameLayout] = useState<PeekFrameLayout | null>(null);
  const peekWidth = usePeekWidth();
  const peekWidthRef = useRef(peekWidth);
  peekWidthRef.current = peekWidth;
  const frameLayoutRef = useRef<PeekFrameLayout | null>(null);
  // What the card told, which card told it and when: an opening waits for
  // its own card's word and a frame past it.
  const frameContentRef = useRef<{ width: number; pad: number; slug: string; at: number } | null>(null);
  const areaWidthRef = useRef(0);
  const evaluateFrameRef = useRef<() => void>(() => undefined);
  const reportFrame = useCallback((contentWidth: number, padPx: number) => {
    const current = frameContentRef.current;
    const slug = heldRef.current?.slug ?? "";
    if (current && current.width === contentWidth && current.pad === padPx && current.slug === slug) return;
    frameContentRef.current = { width: contentWidth, pad: padPx, slug, at: performance.now() };
    // Told from the card's commit: decided once it is over.
    queueMicrotask(() => evaluateFrameRef.current());
  }, []);
  const detailFrame = useMemo<DetailFrame>(
    () => ({ layout: frameLayout?.layout ?? null, report: reportFrame }),
    [frameLayout?.layout, reportFrame],
  );

  // О15: the pointer resting on the scrim round the window steps the window
  // back, as a card about to be swept down, and a hint shows over it. The
  // step has its own spring (the window's, «Величины») and moves the whole
  // window as one, by a transform of its own round the frame's pieces; a
  // movement under way carries it in its own share, so a closing goes on
  // from where the stepped window stands and lands on the card all the same.
  const nudgeRef = useRef<HTMLDivElement>(null);
  const nudgeSpringRef = useRef<{ spring: PeekSpring; last: number; frame: number | null }>({
    spring: { position: 0, velocity: 0, target: 0 },
    last: 0,
    frame: null,
  });
  const pointerOnScrimRef = useRef(false);
  // The pointer heads down toward the window, and a menu is open (О15).
  const towardWindowRef = useRef(false);
  const menuOpenRef = useRef(false);
  // The step is on: it holds while the pointer stays on the band, whatever
  // way and however fast it goes there (О15).
  const steppedRef = useRef(false);
  const recheckPointerRef = useRef<() => void>(() => undefined);
  // The pointer attends to the scrim (SPEC_CARD_STATES.md, С7.2): a slow
  // pointer there, at once, not one crossing it on its way.
  const attendedRef = useRef(false);
  const scrimIntent = useHoverIntent((state) => {
    const attended = state.slow === SCRIM_TARGET;
    if (attended === attendedRef.current) return;
    attendedRef.current = attended;
    updateNudgeRef.current();
  });
  // Escape is held down: the closing it brings is at once (О11).
  const escapedRef = useRef(false);
  const updateNudgeRef = useRef<() => void>(() => undefined);
  const [hintShown, setHintShown] = useState(false);
  // О11: the card the window grew out of has no place on screen as the
  // window closes; it leaves as a dialog does.
  const [leavingAsDialog, setLeavingAsDialog] = useState(false);

  // The gate the card's own work goes through (detailMotionGate.ts): open
  // while the window prepares and rests, holding while it moves.
  const gateStateRef = useRef({ moving: false, queue: [] as (() => void)[], pending: 0, settledAt: 0 });
  const gate = useMemo<DetailMotionGate>(() => ({
    defer(update) {
      const state = gateStateRef.current;
      if (state.moving) state.queue.push(update);
      else update();
    },
    track(work) {
      const state = gateStateRef.current;
      state.pending += 1;
      const done = () => {
        state.pending -= 1;
        state.settledAt = performance.now();
      };
      work.then(done, done);
      return work;
    },
  }), []);
  const holdGate = () => {
    gateStateRef.current.moving = true;
  };
  const releaseGate = useCallback(() => {
    const state = gateStateRef.current;
    state.moving = false;
    for (const update of state.queue.splice(0)) update();
  }, []);

  // The content stands still while the window moves: the page's renders
  // reach it while it prepares and once it rests.
  const content = useMemo(() => (held ? children(held) : null), [children, held]);
  const shownContentRef = useRef<ReactNode>(content);
  if (block && live) shownContentRef.current = content;

  const hideCard = (slug: string | null) => {
    hiddenCardRef.current?.removeAttribute(HIDDEN_CARD_ATTRIBUTE);
    hiddenCardRef.current = null;
    setPeekHiddenSlug(slug);
    if (slug === null) return;
    const card = document.querySelector<HTMLElement>(feedCardSelector(slug));
    card?.setAttribute(HIDDEN_CARD_ATTRIBUTE, "");
    hiddenCardRef.current = card;
  };

  const restoreHiddenFrame = (motion: PeekMotion | null) => {
    if (motion?.hiddenFrame) motion.hiddenFrame.style.visibility = "";
  };

  /** Back to the plain surface's place: no transform, no fade. */
  const clearMotion = useCallback(() => {
    for (const element of [scrimRef.current, anchorRef.current, surfaceRef.current, contentRef.current]) {
      if (!element) continue;
      element.style.transform = "";
      element.style.opacity = "";
    }
  }, []);

  /** The window's step back as it is now: its own spring's share, carried
   *  by a movement under way (an opening or a closing is the window's way
   *  to and from its place, `p`), on a layer only while it moves. */
  const writeNudge = useCallback(() => {
    const wrap = nudgeRef.current;
    if (!wrap) return;
    const motion = motionRef.current;
    const carried = motion && motion.kind !== "resize" ? clampUnit(motion.spring.position) : 1;
    const nudge = nudgeSpringRef.current;
    const share = nudge.spring.position * carried;
    const transform = peekNudgeTransform(share);
    wrap.style.transform = transform;
    // A gallery's other tiles stand at the card's place, not stepped back.
    const rest = restRef.current;
    const restBox = flyerRestBoxRef.current;
    if (rest && restBox) {
      const { width, height } = sizeRef.current;
      rest.style.transformOrigin = `${width / 2 - restBox.x}px ${height / 2 - restBox.y}px`;
      rest.style.transform = peekNudgeUndoTransform(share);
    }
    wrap.style.willChange = transform !== "" && (nudge.frame !== null || (motion !== null && motion.kind !== "resize"))
      ? "transform"
      : "";
  }, []);

  const stepNudge = useCallback((now: number) => {
    const nudge = nudgeSpringRef.current;
    // One frame at most, as the window's own movement (О12).
    const step = Math.min(CARD_PEEK_FRAME_STEP_MS, Math.max(0, now - nudge.last));
    nudge.last = now;
    nudge.spring = stepPeekSpring(nudge.spring, step);
    if (peekSpringSettled(nudge.spring)) {
      nudge.spring = { position: nudge.spring.target, velocity: 0, target: nudge.spring.target };
      nudge.frame = null;
    } else {
      nudge.frame = requestAnimationFrame(stepNudge);
    }
    writeNudge();
  }, [writeNudge]);

  /** Sends the step back toward `target` from where it is, keeping its
   *  speed (О12). */
  const aimNudge = useCallback((target: 0 | 1) => {
    const nudge = nudgeSpringRef.current;
    if (nudge.spring.target === target) return;
    nudge.spring = { ...nudge.spring, target };
    if (nudge.frame === null) {
      nudge.last = performance.now();
      nudge.frame = requestAnimationFrame(stepNudge);
    }
  }, [stepNudge]);

  /** The step back at once at `position`, still. */
  const resetNudge = useCallback(() => {
    const nudge = nudgeSpringRef.current;
    if (nudge.frame !== null) cancelAnimationFrame(nudge.frame);
    nudge.frame = null;
    nudge.spring = { position: 0, velocity: 0, target: 0 };
    writeNudge();
  }, [writeNudge]);

  /** Back to the plain surface: no transform, no layer. */
  const clearInline = useCallback(() => {
    clearMotion();
    for (const element of [anchorRef.current, surfaceRef.current, contentRef.current]) {
      if (element) element.style.willChange = "";
    }
  }, [clearMotion]);

  const stopLoop = (motion: PeekMotion | null) => {
    if (motion?.frame != null) cancelAnimationFrame(motion.frame);
    if (motion) motion.frame = null;
  };

  const cancelPreparation = () => {
    const preparation = preparationRef.current;
    if (preparation?.frame != null) cancelAnimationFrame(preparation.frame);
    preparationRef.current = null;
  };

  // The frame the carried picture covers until it hands over.
  const handoverFrameRef = useRef<PeekMotion | null>(null);
  const cancelHandover = () => {
    if (handoverRef.current !== null) cancelAnimationFrame(handoverRef.current);
    handoverRef.current = null;
    restoreHiddenFrame(handoverFrameRef.current);
    handoverFrameRef.current = null;
  };

  /** The window's place, from the size its observer heard. */
  const laid = (): PeekRect => ({ x: 0, y: 0, ...sizeRef.current });

  /** The file of the window's own picture: a gallery card gives the tile
   *  of that file (О10, п. 3). */
  const windowSource = () => (contentRef.current ? detailPeekMediaSource(contentRef.current) : null);

  /** The window's own picture, where it stands in the window's space: read
   *  once, when a movement starts. */
  const readWindowMedia = useCallback((): { frame: HTMLElement; place: PeekMediaPlace } | null => {
    const contentElement = contentRef.current;
    const frame = contentElement ? detailPeekMediaFrame(contentElement) : null;
    if (!contentElement || !frame) return null;
    // The content and its picture move together, unscaled: their difference
    // is the picture's place in the content, which starts inside the line.
    const contentBox = rectOf(contentElement);
    // Both stand in the window stepped back (О15): their difference is
    // scaled by the step's scale, taken out here.
    const scale = 1 - (1 - CARD_PEEK_NUDGE_SCALE) * nudgeSpringRef.current.spring.position;
    const frameBox = rectOf(frame);
    const image = {
      x: (frameBox.x - contentBox.x) / scale + 1,
      y: (frameBox.y - contentBox.y) / scale + 1,
      width: frameBox.width / scale,
      height: frameBox.height / scale,
    };
    const { width, height } = sizeRef.current;
    const interior = { x: 1, y: 1, width: width - 2, height: height - 2 };
    return { frame, place: { clip: intersectPeekRect(image, interior), image } };
  }, []);

  /** Writes one frame of the movement. */
  const paint = useCallback(() => {
    const motion = motionRef.current;
    const anchor = anchorRef.current;
    const scrim = scrimRef.current;
    const surface = surfaceRef.current;
    const contentElement = contentRef.current;
    const pieces = piecesRef.current;
    if (!motion || !anchor || !scrim || !surface || !contentElement || !pieces) return;
    writeNudge();
    const place = laid();
    let shown: PeekRect;
    // The window's share: of the card's corner and fill against its own, of
    // the shadow, of the picture's way.
    let p: number;
    if (motion.kind === "resize") {
      // The window alone, at its place: its width only moves. Unclamped: a
      // turn that carries speed against the new target goes on a little
      // past where it turned before it comes back (О12).
      const [from, to] = motion.widths;
      shown = centredPeekRect(place, lerp(from ?? place.width, to ?? place.width, motion.spring.position));
      p = 1;
    } else {
      p = clampUnit(motion.spring.position);
      scrim.style.opacity = String(p);
      if (motion.kind === "fade") {
        anchor.style.opacity = String(p);
        return;
      }
      anchor.style.opacity = motion.kind === "center" ? String(p) : "1";
      const end = motion.windowWidth === null ? place : centredPeekRect(place, motion.windowWidth);
      const from = motion.kind === "center" || !motion.card ? centerPeekRect(end, CARD_PEEK_CENTER_SCALE) : motion.card;
      shown = lerpPeekRect(from, end, p);
    }
    const currentView = viewRef.current;
    if (!currentView) return;
    const transforms = peekFrameTransforms(place, shown, peekFrameCut(currentView.cardRadius, currentView.windowRadius));
    for (const { element, piece } of pieces.frame) element.style.transform = transforms[piece];
    for (const element of pieces.weights) {
      element.style.opacity = String(element.dataset.peekWeight === "card" ? 1 - p : p);
    }
    const surfaceTransforms = peekSurfaceTransforms(place, shown);
    surface.style.transform = surfaceTransforms.surface;
    contentElement.style.transform = surfaceTransforms.content;
    contentElement.style.opacity = String(motion.kind === "card" ? motion.content : 1);
    if (pieces.mediaClip && pieces.mediaImage && motion.cardMedia && motion.windowMedia) {
      const clip = lerpPeekRect(motion.cardMedia.clip, motion.windowMedia.clip, p);
      const image = lerpPeekRect(motion.cardMedia.image, motion.windowMedia.image, p);
      const media = peekMediaTransforms(motion.mediaLaid ?? place, clip, image);
      pieces.mediaClip.style.transform = media.clip;
      pieces.mediaImage.style.transform = media.image;
      pieces.mediaClip.style.opacity = String(motion.mediaFades ? 1 - motion.content : 1);
    }
    // With the scrim, as the card under it shows again (О11, п. 2).
    if (pieces.rest) pieces.rest.style.opacity = String(1 - p);
    // The card's line under its media goes with the card's frame, from the
    // card's place in it to the same place in the window's, along itself
    // only, and is the card's: it fades as the card's corner does.
    const outlineBox = flyerOutlineRef.current?.rect;
    if (pieces.outline && outlineBox && motion.card) {
      const scaleX = shown.width / Math.max(motion.card.width, 1e-3);
      const scaleY = shown.height / Math.max(motion.card.height, 1e-3);
      const x = shown.x + (outlineBox.x - motion.card.x) * scaleX - outlineBox.x;
      const y = shown.y + (outlineBox.y - motion.card.y) * scaleY - outlineBox.y;
      pieces.outline.style.transform = `translate(${x}px, ${y}px) scaleX(${scaleX})`;
      pieces.outline.style.opacity = String(1 - p);
    }
  }, [writeNudge]);

  /** At rest the carried picture goes once the window's own original shows
   *  under it, so the end needs no swap; the window's frame shows again.
   *  One change a frame, and the window's layers go last, the frame after
   *  the carried picture: a frame that takes the layers apart while the
   *  carried picture is on the page shows the picture's place blank in
   *  WebKit. */
  const handOverPicture = useCallback((motion: PeekMotion, since: number) => {
    cancelHandover();
    handoverFrameRef.current = motion;
    const dropLayers = () => {
      handoverRef.current = null;
      clearInline();
      // What the window's place decided while it moved lands now, and the
      // pointer resting on the scrim steps the window back now (О15).
      evaluateFrameRef.current();
      updateNudgeRef.current();
    };
    const dropPicture = () => {
      handoverRef.current = null;
      handoverFrameRef.current = null;
      // A resize carries no picture: the opening's stays kept.
      if (flyerRef.current) restPictureRef.current = flyerRef.current;
      flushSync(() => setFlyer(null));
      handoverRef.current = requestAnimationFrame(dropLayers);
    };
    const step = (now: number) => {
      handoverRef.current = null;
      const frame = motion.hiddenFrame;
      const original = frame?.querySelector<HTMLImageElement>("img:not([data-detail-preview-backing])") ?? null;
      const shown = !original || (original.complete && original.naturalWidth > 0 && original.style.opacity !== "0");
      if (!shown && now - since < PICTURE_HANDOVER_MAX_MS) {
        handoverRef.current = requestAnimationFrame(step);
        return;
      }
      restoreHiddenFrame(motion);
      handoverRef.current = requestAnimationFrame(dropPicture);
    };
    handoverRef.current = requestAnimationFrame(step);
  }, [clearInline]);

  /** The movement's last frame was written. Opened, the window rests: the
   *  card's late work lands a frame later, the frame's pieces go the frame
   *  after (never in the frame the movement stops), the carried picture once
   *  the window's own shows, the window's layers last. Closed, it stays one
   *  frame exactly on the card (О11, п. 4), the card shows under it the
   *  next frame, and the window goes the frame after (О14). */
  const finish = useCallback((motion: PeekMotion) => {
    if (motion.kind === "resize") {
      motion.frame = requestAnimationFrame((now) => {
        motion.frame = null;
        if (motionRef.current !== motion) return;
        motionRef.current = null;
        flushSync(() => setView(null));
        clearMotion();
        handOverPicture(motion, now);
      });
      return;
    }
    if (motion.spring.target === 1) {
      motion.frame = requestAnimationFrame(() => {
        motion.frame = requestAnimationFrame((now) => {
          motion.frame = null;
          if (motionRef.current !== motion) return;
          motionRef.current = null;
          flushSync(() => setView(null));
          clearMotion();
          handOverPicture(motion, now);
        });
        if (motionRef.current !== motion) return;
        releaseGate();
        setLive(true);
      });
      return;
    }
    // The card shows again a frame before the window leaves, under the
    // window lying exactly on it, so its layer is drawn before the window
    // uncovers it: shown in the frame the window left, a gallery's seams
    // flashed dark for a frame in the app. The window and its scrim then
    // leave the page with
    // their last frame's styles on them, since a frame painted after they
    // were cleared would show the window whole and the right part blurred.
    motion.frame = requestAnimationFrame(() => {
      motion.frame = null;
      if (motionRef.current !== motion) return;
      hideCard(null);
      motion.frame = requestAnimationFrame(() => {
        motion.frame = null;
        if (motionRef.current !== motion) return;
        motionRef.current = null;
        restPictureRef.current = null;
        releaseGate();
        flushSync(() => {
          setView(null);
          setFlyer(null);
          setHeld(null);
          setClosing(false);
          setLive(true);
        });
      });
    });
    // `hideCard` reads only refs and the store.
  }, [clearMotion, handOverPicture, releaseGate]);

  const tick = useCallback((now: number) => {
    const motion = motionRef.current;
    if (!motion) return;
    // One frame at most: a frame held up slows the window, never jumps it.
    const step = Math.min(CARD_PEEK_FRAME_STEP_MS, Math.max(0, now - motion.last));
    motion.last = now;
    motion.spring = stepPeekSpring(motion.spring, step);
    motion.elapsed += step;
    motion.content = motion.kind === "card"
      ? peekContentOpacity(motion.direction, motion.elapsed, motion.contentStart)
      : 1;
    const settled = peekSpringSettled(motion.spring);
    if (settled) {
      motion.spring = { position: motion.spring.target, velocity: 0, target: motion.spring.target };
      motion.content = motion.spring.target;
    }
    paint();
    if (settled) {
      finish(motion);
      return;
    }
    motion.frame = requestAnimationFrame(tick);
  }, [finish, paint]);

  /** The window's own corner, from its surface. */
  const readWindowRadius = () => {
    const surface = surfaceRef.current;
    return surface ? Number.parseFloat(getComputedStyle(surface).borderTopLeftRadius) || 0 : 0;
  };

  /** What a movement of `kind` from `source` puts on the page. */
  const viewFor = (kind: MovingKind, source: PeekSource | null, windowRadius: number): Omit<PeekMotionView, "id"> => ({
    kind,
    cardRadius: source?.radius ?? windowRadius,
    windowRadius,
    fill: source?.fill ?? "var(--background)",
  });

  /** Gathers the movement's pieces on the page and writes the movement's
   *  frame, before the browser paints it (the first frame is the card
   *  itself, О10, п. 1). */
  const gatherAndPaint = useCallback(() => {
    const anchor = anchorRef.current;
    const clip = mediaClipRef.current;
    const picture = flyerRef.current;
    if (picture && clip && clip.firstChild !== picture.element) {
      const element = picture.element;
      element.className = cn(FLYER_CLASS, "inset-0 size-full");
      element.setAttribute("data-peek-media", "");
      clip.replaceChildren(element);
      if (picture.stage) {
        // The copy stands at the card's size in the carried box.
        const box = flyerLaidRef.current ?? sizeRef.current;
        picture.stage.style.transform = `scale(${box.width / picture.naturalWidth}, ${box.height / picture.naturalHeight})`;
      }
    }
    const rest = restRef.current;
    const restPicture = flyerRestRef.current;
    if (rest && restPicture && rest.firstChild !== restPicture) rest.replaceChildren(restPicture);
    const outline = outlineRef.current;
    const outlineLine = flyerOutlineRef.current?.element ?? null;
    if (outline && outlineLine && outline.firstChild !== outlineLine) outline.replaceChildren(outlineLine);
    if (!anchor) {
      piecesRef.current = null;
      return;
    }
    const frame: PeekPieces["frame"] = [];
    for (const element of anchor.querySelectorAll<HTMLElement>("[data-peek-piece]")) {
      const piece = PEEK_FRAME_PIECES.find((candidate) => candidate === element.dataset.peekPiece);
      if (piece) frame.push({ element, piece });
    }
    piecesRef.current = {
      frame,
      weights: [...anchor.querySelectorAll<HTMLElement>("[data-peek-weight]")],
      mediaClip: clip,
      mediaImage: picture ? picture.element : null,
      rest,
      outline,
    };
    const motion = motionRef.current;
    if (!motion) return;
    const surface = surfaceRef.current;
    const contentElement = contentRef.current;
    if (motion.kind !== "fade" && surface && contentElement) {
      surface.style.willChange = "transform";
      contentElement.style.willChange = "transform, opacity";
    }
    anchor.style.willChange = "opacity";
    paint();
    if (motion.frame === null) motion.frame = requestAnimationFrame(tick);
  }, [paint, tick]);

  /** Sets a movement going from where `spring` is, in the frame at `now`:
   *  its ends are measured here, once, and its first frame is written before
   *  this frame is painted. `picture` is what it carries for a card. */
  const start = useCallback((
    kind: MovingKind,
    slug: string,
    spring: PeekSpring,
    contentStart: number,
    source: PeekSource | null,
    picture: PeekPicture | null,
    now: number,
    windowWidth: number | null = null,
  ) => {
    const anchor = anchorRef.current;
    const surface = surfaceRef.current;
    if (!anchor || !surface) return;
    const previous = motionRef.current;
    stopLoop(previous);
    restoreHiddenFrame(previous);
    const box = rectOf(anchor);
    const place = source ? sourcePlace(source, box) : null;
    const measured = kind === "card" && place?.media ? readWindowMedia() : null;
    const sourceMedia = source?.media ?? null;
    // The card's own picture, when the window has none decoded to carry:
    // a gallery's copy of its elements, else a canvas.
    const own = (): PeekPicture | null => {
      if (!sourceMedia) return null;
      const { copy, drawable, naturalWidth, naturalHeight } = sourceMedia;
      if (copy) return sourceMedia.composite ? copyPicture(copy, naturalWidth, naturalHeight) : { element: copy, naturalWidth, naturalHeight };
      return drawable ? canvasPicture(drawable, naturalWidth, naturalHeight) : null;
    };
    // A gallery flying whole carries itself: the window's own picture is
    // only one of its tiles (О10, п. 3).
    const carried = (sourceMedia?.composite ? null : picture) ?? own();
    const windowMedia = place?.media && sourceMedia
      ? measured?.place ?? carriedPeekMediaPlace(place.rect, place.media, laid(), sourceMedia.naturalWidth, sourceMedia.naturalHeight)
      : null;
    const mediaFades = Boolean(sourceMedia?.composite) || measured === null;
    const motion: PeekMotion = {
      kind,
      slug,
      spring,
      direction: spring.target === 1 ? "in" : "out",
      // A movement that turns another round keeps its clock: no frame stands
      // still at the turn.
      last: previous && previous.slug === slug && !peekSpringSettled(spring) ? previous.last : now,
      elapsed: 0,
      contentStart,
      content: contentStart,
      card: place?.rect ?? null,
      cardMedia: kind === "card" ? place?.media ?? null : null,
      windowMedia: kind === "card" ? windowMedia : null,
      mediaFades,
      hiddenFrame: null,
      mediaLaid: kind === "card" && windowMedia ? windowMedia.image : null,
      widths: [null, null],
      windowWidth,
      frame: null,
    };
    if (measured && !mediaFades && kind === "card") {
      measured.frame.style.visibility = "hidden";
      motion.hiddenFrame = measured.frame;
    }
    motionRef.current = motion;
    holdGate();
    const windowRadius = readWindowRadius();
    viewIdRef.current += 1;
    const id = viewIdRef.current;
    hideCard(kind === "card" ? slug : null);
    // The pieces stand on the page already when the window prepared them:
    // the start then only writes their styles.
    const nextView = viewFor(kind, source, windowRadius);
    const current = viewRef.current;
    const keep = current !== null && current.kind === nextView.kind && current.cardRadius === nextView.cardRadius
      && current.windowRadius === nextView.windowRadius && current.fill === nextView.fill;
    flushSync(() => {
      if (!keep) setView({ ...nextView, id });
      setFlyer(kind === "card" && motion.cardMedia && carried
        ? { id, picture: carried, laid: motion.mediaLaid, rest: place?.rest ?? null, outline: place?.outline ?? null }
        : null);
      setClosing(spring.target === 0);
      setPreparing(false);
      setLive(false);
    });
    gatherAndPaint();
  // `hideCard`, `holdGate`, `laid` and `viewFor` read only refs, the store
  // and their arguments.
  }, [gatherAndPaint, readWindowMedia]);

  /** The width a resize shows now, of a window laid out `laidWidth` wide. */
  const resizeWidth = (motion: PeekMotion, laidWidth: number) => {
    const [from, to] = motion.widths;
    return lerp(from ?? laidWidth, to ?? laidWidth, motion.spring.position);
  };

  /** Sets the window's width going by the spring from `fromWidth` to its
   *  place's, in the frame it is called in. Only the frame's edges move,
   *  in pieces, as in an opening; the card stands in its new layout at once,
   *  clipped by them and never stretched (О12). */
  const startResize = (fromWidth: number, spring: PeekSpring) => {
    const previous = motionRef.current;
    stopLoop(previous);
    const now = performance.now();
    const motion: PeekMotion = {
      kind: "resize",
      slug: heldRef.current?.slug ?? "",
      spring,
      direction: "in",
      // A resize that turns another keeps its clock, as a reversal does.
      last: previous ? previous.last : now,
      elapsed: 0,
      contentStart: 1,
      content: 1,
      card: null,
      cardMedia: null,
      windowMedia: null,
      mediaFades: false,
      hiddenFrame: null,
      mediaLaid: null,
      widths: [fromWidth, null],
      windowWidth: null,
      frame: null,
    };
    motionRef.current = motion;
    if (viewRef.current?.kind !== "resize") {
      const windowRadius = readWindowRadius();
      viewIdRef.current += 1;
      const id = viewIdRef.current;
      flushSync(() => setView({ kind: "resize", cardRadius: windowRadius, windowRadius, fill: "var(--background)", id }));
    }
    gatherAndPaint();
  };

  /** Applies the window's width and the card's layout for `next`: the card
   *  takes its new layout in this frame, and the window's edges go from the
   *  width shown now to the new one by the spring when `animate`, keeping
   *  the speed of a resize under way (О12), else stand there at once. */
  const applyFrame = (next: PeekFrameLayout, animate: boolean) => {
    const anchor = anchorRef.current;
    const motion = motionRef.current?.kind === "resize" ? motionRef.current : null;
    const before = sizeRef.current.width;
    const shownWidth = motion ? resizeWidth(motion, before) : before;
    const speed = motion
      ? motion.spring.velocity * ((motion.widths[1] ?? before) - (motion.widths[0] ?? before))
      : 0;
    frameLayoutRef.current = next;
    flushSync(() => setFrameLayout(next));
    // The window's new width, read once, at the change: the spring's end.
    if (anchor) sizeRef.current = { width: anchor.offsetWidth, height: anchor.offsetHeight };
    const distance = sizeRef.current.width - shownWidth;
    // Less than half a pixel to go: nothing to move.
    if (!animate || Math.abs(distance) < 0.5) {
      if (motion) {
        stopLoop(motion);
        motionRef.current = null;
        flushSync(() => setView(null));
        clearInline();
      }
      return;
    }
    startResize(shownWidth, { position: 0, velocity: speed / distance, target: 1 });
  };

  /** Decides the window's width and the card's layout for the window's
   *  place and the content the card told of (О3, О8). Unseen, or told for
   *  the first time, the window takes them at once; shown, it moves to them
   *  (О13: at once with reduced motion). An opening or a closing under way
   *  keeps its width: the window leaves as it stands, and what an opening
   *  missed lands once it rests. */
  const evaluateFrame = () => {
    const content = frameContentRef.current;
    const available = areaWidthRef.current - 2 * CARD_PEEK_MARGIN_PX;
    if (!heldRef.current || !content || available <= 0) return;
    const layout = peekWindowLayout(available, content.width, content.pad);
    const applied = frameLayoutRef.current;
    const width = peekWidthRef.current;
    if (
      applied
      && applied.width === width
      && applied.layout === layout
      && (width === "fill" || layout === "rail" || applied.contentWidth === content.width)
    ) return;
    if (closingRef.current) return;
    const motion = motionRef.current;
    if (motion && motion.kind !== "resize") return;
    if (!motion && handoverRef.current !== null) return;
    const unseen = preparationRef.current !== null;
    applyFrame({ layout, contentWidth: content.width, width }, applied !== null && !unseen && !prefersReducedMotion());
  };
  evaluateFrameRef.current = evaluateFrame;

  /** The pointer on the scrim steps the window at its place back and shows
   *  the hint (О15); off the scrim, or as the window moves to or from its
   *  place, it does not. A closing carries the step it found. */
  const updateNudge = () => {
    if (closingRef.current) {
      setHintShown(false);
      return;
    }
    const motion = motionRef.current;
    const resting = preparationRef.current === null && (motion === null || motion.kind === "resize");
    const allowed = pointerOnScrimRef.current && !menuOpenRef.current && resting && heldRef.current !== null;
    // A pointer that attends to the band and does not head to the window
    // turns the step on; from then on only leaving the band, a menu or a
    // movement of the window takes it off.
    const on = allowed && (steppedRef.current || (attendedRef.current && !towardWindowRef.current));
    steppedRef.current = on;
    setHintShown(on);
    // With reduced motion the hint alone (О13).
    aimNudge(on && !prefersReducedMotion() ? 1 : 0);
  };
  updateNudgeRef.current = updateNudge;

  /** Lays the card out unseen and waits for it, `CARD_PEEK_PREPARE_MAX_MS`
   *  at most, before `begin` starts the movement in a frame: until the card's
   *  module is in, its work done (`track`) and a frame past it, and `picture`
   *  (when asked) decoded. */
  const prepare = useCallback((
    begin: (now: number, picture: PeekPicture | null) => void,
    wantsPicture: () => string | PeekPicture | null,
    needsCard: boolean,
  ) => {
    cancelPreparation();
    const preparation: PeekPreparation = { frame: null, picture: null, decoding: false };
    preparationRef.current = preparation;
    let asked = false;
    // Counted from the input's own commit, so the wait is bounded from the
    // press, not from the first frame after it.
    const since = performance.now();
    const step = (now: number) => {
      preparation.frame = null;
      if (preparationRef.current !== preparation) return;
      if (!asked) {
        const wanted = wantsPicture();
        if (wanted && typeof wanted !== "string") {
          // Decoded already: nothing to wait for.
          asked = true;
          preparation.picture = wanted;
        } else if (wanted) {
          asked = true;
          preparation.decoding = true;
          void decodedPicture(wanted).then((picture) => {
            preparation.picture = picture;
            preparation.decoding = false;
          });
        }
      }
      const gateState = gateStateRef.current;
      // The card in, and its width told a frame ago, so the window starts
      // at the width it ends with (О3).
      const told = frameContentRef.current;
      const cardIn = !needsCard || (
        Boolean(contentRef.current?.querySelector("[data-detail-root]"))
        && told !== null
        && told.slug === heldRef.current?.slug
        && now - told.at >= CARD_PEEK_FRAME_STEP_MS
      );
      const ready = cardIn
        && gateState.pending === 0
        && now - gateState.settledAt >= CARD_PEEK_FRAME_STEP_MS
        && !preparation.decoding;
      if (ready || now - since >= CARD_PEEK_PREPARE_MAX_MS) {
        preparationRef.current = null;
        begin(now, preparation.picture);
        return;
      }
      preparation.frame = requestAnimationFrame(step);
    };
    preparation.frame = requestAnimationFrame(step);
  }, []);

  // The window's size, heard rather than read in a frame (О12).
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return undefined;
    sizeRef.current = { width: anchor.offsetWidth, height: anchor.offsetHeight };
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      sizeRef.current = { width: anchor.offsetWidth, height: anchor.offsetHeight };
    });
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [held !== null]);

  // The right part's width, heard as it changes: the window's place decides
  // its width and the card's layout (О3, О8), in the frame it changes.
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area || held === null || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      areaWidthRef.current = area.offsetWidth;
      evaluateFrameRef.current();
      recheckPointerRef.current();
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, [areaRef, held !== null]);

  // Whether the pointer is on the scrim's top part, the band over the
  // window (О15), by the window's place rather than by what lies under it:
  // the stepped window must not move the band's edge and send itself back.
  // Its sides and the part under it give no step. A touch has no pointer
  // resting anywhere. A pointer heading down to the window (to its header's
  // buttons) turns no step on: the window would slide from under it; one
  // stopped on the band, or going along it or up, does, and the step then
  // holds while the pointer stays on the band, any way it goes. A press
  // held down (a selection, a drag) and an open menu take it off
  // (SPEC_CARD_STATES.md, С7.8, С8.6).
  useEffect(() => {
    if (held === null) return undefined;
    let last: { x: number; y: number } | null = null;
    // The way the pointer went over the speed's own window (С7.2).
    let trail: { x: number; y: number; t: number }[] = [];
    let stopped: ReturnType<typeof setTimeout> | null = null;
    const onBand = (x: number, y: number) => {
      const area = areaRef.current;
      const anchor = anchorRef.current;
      if (!area || !anchor) return false;
      const box = area.getBoundingClientRect();
      return x >= box.left && x < box.right && y >= box.top && y < box.bottom
        && y < anchor.getBoundingClientRect().top;
    };
    const set = (on: boolean, x = 0, y = 0) => {
      // On the band the intent decides when the pointer attends; off it,
      // the step goes at once.
      if (on) scrimIntent.move(SCRIM_TARGET, x, y);
      else if (pointerOnScrimRef.current) scrimIntent.leave();
      if (on === pointerOnScrimRef.current) return;
      pointerOnScrimRef.current = on;
      updateNudgeRef.current();
    };
    const heading = (toWindow: boolean) => {
      if (toWindow === towardWindowRef.current) return;
      towardWindowRef.current = toWindow;
      updateNudgeRef.current();
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const anchor = anchorRef.current;
      const scrim = scrimRef.current;
      if (!anchor || !scrim) return;
      last = { x: event.clientX, y: event.clientY };
      const now = performance.now();
      trail = trail.filter((point) => now - point.t <= HOVER_INTENT.velocityWindowMs);
      trail.push({ ...last, t: now });
      // Down toward the window over the last stretch: no step; once the
      // pointer has been still for that stretch, it has stopped.
      const first = trail[0];
      heading(first !== undefined && trail.length > 1 && last.y > first.y);
      if (stopped !== null) clearTimeout(stopped);
      stopped = setTimeout(() => {
        stopped = null;
        trail = [];
        heading(false);
      }, HOVER_INTENT.velocityWindowMs);
      const target = event.target instanceof Node ? event.target : null;
      const ours = target !== null && (target === scrim || anchor.contains(target));
      set(ours && event.buttons === 0 && onBand(event.clientX, event.clientY), event.clientX, event.clientY);
    };
    // The right part moved under a still pointer (a sidebar that grew): off
    // the band now, the step goes; a new one waits for a real movement (С7.5).
    recheckPointerRef.current = () => {
      if (!pointerOnScrimRef.current || last === null) return;
      if (onBand(last.x, last.y)) return;
      set(false);
      scrimIntent.displace();
    };
    // Only the pointer leaving the page ends it (С7.8): the app's window
    // losing the focus does not.
    const leave = () => set(false);
    // A menu on the page holds the step and the hint (С8.6).
    const root = document.documentElement;
    const menus = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
      const open = root.hasAttribute(MENU_OPEN_ATTRIBUTE);
      if (open === menuOpenRef.current) return;
      menuOpenRef.current = open;
      updateNudgeRef.current();
    });
    menus?.observe(root, { attributes: true, attributeFilter: [MENU_OPEN_ATTRIBUTE] });
    menuOpenRef.current = root.hasAttribute(MENU_OPEN_ATTRIBUTE);
    window.addEventListener("pointermove", move, { passive: true });
    root.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      root.removeEventListener("pointerleave", leave);
      menus?.disconnect();
      if (stopped !== null) clearTimeout(stopped);
      recheckPointerRef.current = () => undefined;
      pointerOnScrimRef.current = false;
      towardWindowRef.current = false;
      steppedRef.current = false;
      scrimIntent.leave();
    };
  }, [areaRef, held !== null, scrimIntent]);

  // «Peek width» changed while the window is open: it goes to its new width
  // as it goes on a change of the panel's place.
  useLayoutEffect(() => {
    queueMicrotask(() => evaluateFrameRef.current());
  }, [peekWidth]);

  /** The window, its scrim and its hint gone at once, the card back in the
   *  feed (О11: Escape, a narrow window's full page). */
  const vanish = () => {
    const motion = motionRef.current;
    cancelPreparation();
    cancelHandover();
    stopLoop(motion);
    restoreHiddenFrame(motion);
    motionRef.current = null;
    clearInline();
    resetNudge();
    hideCard(null);
    releaseGate();
    setView(null);
    setFlyer(null);
    setHeld(null);
    setClosing(false);
    setLive(true);
    setHintShown(false);
    setLeavingAsDialog(false);
  };

  /** The window and its scrim leave as a dialog does (О11): the card it
   *  grew out of has no place on screen now (another place, another view,
   *  a filter), so there is nothing to shrink into. The dialogs' own exit,
   *  `fade-out-0` and `zoom-out-95` over their durations, from where the
   *  window stands; gone once it ends. */
  const leaveAsDialog = () => {
    const motion = motionRef.current;
    stopLoop(motion);
    motionRef.current = null;
    cancelPreparation();
    cancelHandover();
    const nudge = nudgeSpringRef.current;
    if (nudge.frame !== null) cancelAnimationFrame(nudge.frame);
    nudge.frame = null;
    hideCard(null);
    releaseGate();
    setHintShown(false);
    setClosing(true);
    setLeavingAsDialog(true);
  };

  // The page opened, closed or reopened the card.
  useLayoutEffect(() => {
    const previousSlug = previousRef.current;
    previousRef.current = block?.slug ?? null;
    const area = areaRef.current;
    const motion = motionRef.current;
    if (block && previousSlug === null) {
      // The same card opened again while its window leaves: back from where
      // it is (О11).
      if (motion && motion.spring.target === 0 && motion.slug === block.slug) {
        stopLoop(motion);
        const now = performance.now();
        // A window that already lay down starts again from rest; one on its
        // way keeps its clock, so its speed carries through the turn.
        if (peekSpringSettled(motion.spring)) motion.last = now;
        motion.spring = { ...motion.spring, target: 1 };
        motion.direction = "in";
        motion.elapsed = 0;
        motion.contentStart = motion.content;
        setClosing(false);
        motion.frame = requestAnimationFrame(tick);
        return;
      }
      // Reopened before its closing started: it stays where it stands.
      if (!motion && preparationRef.current && held?.slug === block.slug && closing) {
        cancelPreparation();
        releaseGate();
        setClosing(false);
        setLive(true);
        return;
      }
      // A new opening: a window still leaving is gone at once (О11).
      restPictureRef.current = null;
      cancelPreparation();
      cancelHandover();
      if (motion) {
        stopLoop(motion);
        restoreHiddenFrame(motion);
        motionRef.current = null;
      }
      clearInline();
      hideCard(null);
      releaseGate();
      setView(null);
      setFlyer(null);
      setClosing(false);
      setLive(true);
      // The new card's width is decided afresh, at once (О3); its window
      // starts at its place, the hint gone (О15).
      frameLayoutRef.current = null;
      resetNudge();
      setHintShown(false);
      setLeavingAsDialog(false);
      queueMicrotask(() => evaluateFrameRef.current());
      const from = opening && opening.slug === block.slug ? opening.from : "elsewhere";
      let kind = peekOpeningKind({
        from,
        restored: opening?.slug === block.slug && opening.restored,
        reducedMotion: prefersReducedMotion(),
      });
      if (kind === "card" && !(area && findPeekSource(area, block.slug))) kind = "center";
      openedAsRef.current = kind;
      if (kind === "instant") {
        setPreparing(false);
        return;
      }
      // Unseen while it prepares: nothing changes on screen until the start.
      // Its pieces are laid out now, unseen, so the start only moves them.
      if (scrimRef.current) scrimRef.current.style.opacity = "0";
      if (anchorRef.current) anchorRef.current.style.opacity = "0";
      setPreparing(true);
      viewIdRef.current += 1;
      const preparedSource = kind === "card" && area ? findPeekSource(area, block.slug) : null;
      setView({ ...viewFor(kind, preparedSource, readWindowRadius()), id: viewIdRef.current });
      const slug = block.slug;
      const movingKind: MovingKind = kind;
      prepare(
        (now, picture) => {
          const source = movingKind === "card" && area ? findPeekSource(area, slug, windowSource()) : null;
          start(source || movingKind !== "card" ? movingKind : "center", slug, { position: 0, velocity: 0, target: 1 }, 0, source, picture, now);
        },
        () => {
          if (movingKind !== "card" || !contentRef.current) return null;
          const frame = detailPeekMediaFrame(contentRef.current);
          const original = frame?.querySelector<HTMLImageElement>("img:not([data-detail-preview-backing])");
          return original?.currentSrc || original?.src || null;
        },
        true,
      );
      return;
    }
    if (!block && previousSlug !== null && held) {
      // Closed while it prepared: it never showed.
      if (!motion && preparationRef.current && !closing) {
        cancelPreparation();
        clearInline();
        releaseGate();
        setPreparing(false);
        setHeld(null);
        return;
      }
      // The hint goes; the step back stays and the closing carries it (О15).
      setHintShown(false);
      // A resize under way stops where it stands: the closing goes from the
      // width the window shows (О11).
      let shownWidth: number | null = null;
      if (motion?.kind === "resize") {
        stopLoop(motion);
        shownWidth = resizeWidth(motion, sizeRef.current.width);
        motionRef.current = null;
      }
      const moving = motionRef.current;
      const reducedMotion = prefersReducedMotion();
      const source = openedAsRef.current === "card" && area ? findPeekSource(area, held.slug, windowSource()) : null;
      const kind = peekClosingKind({
        openedAs: openedAsRef.current,
        exit: exitRef.current,
        reducedMotion,
        cardOnScreen: source !== null,
      });
      if (kind === "none" || escapedRef.current) {
        escapedRef.current = false;
        vanish();
        return;
      }
      const slug = held.slug;
      // The card has no place on screen to shrink into: it leaves as a
      // dialog does (О11).
      if (kind === "center" && openedAsRef.current === "card") {
        leaveAsDialog();
        return;
      }
      // On its way open: it turns back from where it is, at once, carrying
      // what it carries.
      if (moving) {
        const spring: PeekSpring = { ...moving.spring, target: 0 };
        if (kind === moving.kind && (kind !== "card" || source !== null)) {
          stopLoop(moving);
          moving.spring = spring;
          moving.direction = "out";
          moving.elapsed = 0;
          moving.contentStart = moving.content;
          setClosing(true);
          moving.frame = requestAnimationFrame(tick);
          return;
        }
        start(kind, slug, spring, moving.content, kind === "card" ? source : null, flyer?.picture ?? null, performance.now());
        return;
      }
      // A fade has no edges to carry the width: the window fades at its
      // place.
      if (shownWidth !== null && kind === "fade") {
        clearMotion();
        setView(null);
        shownWidth = null;
      }
      const restWidth = shownWidth;
      // At rest: the content stands still from now on and the scrim lets
      // the feed through; the movement starts from the next frame on, once
      // the card's own work is done (`prepare`). A picture still handing
      // over is the one to carry back.
      const keptFlyer = flyerRef.current;
      cancelHandover();
      holdGate();
      setLive(false);
      setClosing(true);
      const openedAs = openedAsRef.current;
      prepare(
        (now, picture) => {
          // Where the card stands as the closing starts, the feed or the
          // graph after a change of place included (О11).
          const place = openedAs === "card" && area ? findPeekSource(area, slug, windowSource()) : null;
          const kindNow = peekClosingKind({ openedAs, exit: exitRef.current, reducedMotion, cardOnScreen: place !== null });
          if (kindNow === "none") {
            vanish();
            return;
          }
          if (kindNow === "center" && openedAs === "card") {
            leaveAsDialog();
            return;
          }
          start(kindNow, slug, { position: 1, velocity: 0, target: 0 }, 1, kindNow === "card" ? place : null, kindNow === "card" ? picture : null, now, restWidth);
        },
        () => {
          if (openedAs !== "card" || !contentRef.current) return null;
          const frame = detailPeekMediaFrame(contentRef.current);
          // The picture the opening carried is still decoded: the closing
          // carries it back when the window's frame is still of that file.
          // Else it carries the card's own picture (`start`): decoding the
          // window's file once more while the window shows it leaves the
          // window's picture blank in WebKit until that decode ends.
          const kept = restPictureRef.current ?? keptFlyer;
          const keptSrc = kept?.element instanceof HTMLImageElement ? kept.element.currentSrc || kept.element.src : null;
          const original = frame?.querySelector<HTMLImageElement>("img:not([data-detail-preview-backing])");
          if (kept && original && keptSrc && keptSrc === (original.currentSrc || original.src)) return kept;
          return null;
        },
        false,
      );
    }
  // Heard on `block` alone: `held`, `closing` and `flyer` are what stood
  // before this change, and `opening` and `exit` come with `block`.
  }, [block]);

  useLayoutEffect(() => {
    gatherAndPaint();
  }, [flyer, gatherAndPaint, view]);

  // Escape closes the window at once, with no movement (О11; user's
  // decision of 24.10.2026), from rest, while it grows and while it closes.
  // The page closes the card on the key as before (Detail.tsx); the window
  // hears the key first and goes in that frame instead of moving. The mark
  // lasts until the key is let go: a close that comes with it is Escape's.
  // While the window still grows the key reaches it wherever the focus is,
  // the card's text included (О12).
  useEffect(() => {
    if (held === null) return undefined;
    const down = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.metaKey || event.altKey || event.ctrlKey) return;
      escapedRef.current = true;
      if (closingRef.current) {
        flushSync(() => vanish());
        return;
      }
      const motion = motionRef.current;
      if (!motion || motion.kind === "resize" || motion.spring.target !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === "Escape") escapedRef.current = false;
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      escapedRef.current = false;
    };
  }, [held !== null]);

  // The second press of the double click that closed the window does not
  // reach the feed under it: it is not a press of its own (О11). A single
  // press on the feed right after the closing begins does.
  useEffect(() => {
    if (!closing) return undefined;
    const guard = (event: MouseEvent) => {
      if (event.detail < 2) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("click", guard, true);
    window.addEventListener("dblclick", guard, true);
    return () => {
      window.removeEventListener("click", guard, true);
      window.removeEventListener("dblclick", guard, true);
    };
  }, [closing]);

  useEffect(() => () => {
    const nudge = nudgeSpringRef.current;
    if (nudge.frame !== null) cancelAnimationFrame(nudge.frame);
    nudge.frame = null;
    const motion = motionRef.current;
    stopLoop(motion);
    restoreHiddenFrame(motion);
    cancelPreparation();
    cancelHandover();
    hiddenCardRef.current?.removeAttribute(HIDDEN_CARD_ATTRIBUTE);
    setPeekHiddenSlug(null);
    releaseGate();
  }, [releaseGate]);

  if (!held) return null;
  const cut = view && view.kind !== "fade" ? peekFrameCut(view.cardRadius, view.windowRadius) : null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10"
      data-card-peek=""
      data-card-peek-closing={closing ? "" : undefined}
      data-card-peek-preparing={preparing ? "" : undefined}
    >
      {/* A drag holds the step and the hint (С7.8). */}
      <HoverIntentDragWatch intent={scrimIntent} />
      <div
        ref={scrimRef}
        aria-hidden="true"
        className={cn(
          "modal-scrim absolute inset-0",
          MOVED_CLASS,
          closing ? "pointer-events-none" : "pointer-events-auto",
          leavingAsDialog && DIALOG_SCRIM_LEAVE_CLASS,
        )}
        data-card-peek-scrim=""
        onClick={(event) => {
          // The second press of a double click is not a press of its own:
          // the one that opened the window, or closed it, is done (О11).
          if (event.detail >= 2) return;
          // Inside the window's own place, where the stepped window leaves
          // the scrim showing, a press does not close it (О15).
          const anchor = anchorRef.current?.getBoundingClientRect();
          if (anchor && event.clientX >= anchor.left && event.clientX < anchor.right
            && event.clientY >= anchor.top && event.clientY < anchor.bottom) return;
          onClose();
        }}
      />
      <div
        ref={anchorRef}
        className={cn("pointer-events-none absolute", MOVED_CLASS, leavingAsDialog && DIALOG_LEAVE_CLASS)}
        onAnimationEnd={(event) => {
          if (leavingAsDialog && event.target === event.currentTarget) vanish();
        }}
        // In M from the right part's edges; with «Peek width» Fit card never
        // wider than the card, and with the panel under the content no wider
        // than the content, the auto margins centring it once the right part
        // is wider (О3).
        style={{
          inset: CARD_PEEK_MARGIN_PX,
          maxWidth: frameMaxWidth(frameLayout, peekWidth),
          marginInline: "auto",
        }}
        data-card-peek-window=""
      >
        {/* The window as one, stepped back while the pointer rests on the
            scrim (О15). */}
        <div ref={nudgeRef} className={cn("pointer-events-none absolute inset-0 origin-center", MOVED_CLASS)} data-card-peek-nudge="">
        {view && cut && (
          <PeekFrameUnder view={view} cut={cut}>
            {/* Over the card's fill, under the window's: the scrim's share
                shows it through the window as the card comes back, and the
                window's edges uncover it where the card lies past them
                (О11, п. 2). */}
            {flyer?.rest && (
              <div
                ref={restRef}
                className={REST_CLASS}
                style={{
                  left: flyer.rest.rect.x,
                  top: flyer.rest.rect.y,
                  width: flyer.rest.rect.width,
                  height: flyer.rest.rect.height,
                }}
                data-peek-media-rest=""
              />
            )}
          </PeekFrameUnder>
        )}
        <div
          ref={surfaceRef}
          className={cn(
            "pointer-events-auto absolute inset-0 origin-top-left overflow-hidden border border-border bg-background text-foreground shadow-lg",
            MOVED_CLASS,
          )}
          style={{ borderRadius: CARD_PEEK_RADIUS_PX }}
          data-card-peek-surface=""
          data-moving={cut ? "" : undefined}
          onClick={closing ? () => onReopen(held) : undefined}
        >
          <div
            ref={contentRef}
            className={cn("absolute inset-0 origin-top-left", MOVED_CLASS)}
            inert={closing}
            data-card-peek-content=""
          >
            <DetailMotionGateContext.Provider value={gate}>
              <DetailFrameContext.Provider value={detailFrame}>
                {shownContentRef.current}
              </DetailFrameContext.Provider>
            </DetailMotionGateContext.Provider>
          </div>
        </div>
        {flyer && (
          <div
            ref={mediaClipRef}
            className={cn(FLYER_CLASS, "overflow-hidden")}
            style={flyerBox(flyer.laid)}
            data-peek-media-clip=""
          />
        )}
        {flyer?.outline && (
          <div
            ref={outlineRef}
            className={FRAME_PIECE_CLASS}
            style={{
              left: flyer.outline.rect.x,
              top: flyer.outline.rect.y,
              width: flyer.outline.rect.width,
              height: flyer.outline.rect.height,
            }}
            data-peek-media-outline=""
          />
        )}
        {view && cut && <PeekFrameOver view={view} cut={cut} />}
        </div>
      </div>
      {/* Over the window, in the field `M` over it (О15). */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center gap-1 text-sm text-muted-foreground"
        style={HINT_BAND_STYLE}
        data-card-peek-hint=""
        data-shown={hintShown ? "" : undefined}
      >
        <ArrowDown className="size-4" />
        ESC to close card
      </div>
    </div>
  );
}

/** The window's header (О9): always shown at the window's top, the card
 *  under it, as the open card's top row stands over a full page: the same
 *  fill and line under it. Everything that row holds full page, and before
 *  it the way to full page. */
export function CardPeekPlate({
  block,
  vaultPath,
  tags,
  currentTag,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onRequestDelete,
  onRenameFile,
  onCheckFileName,
  onExpand,
  onClose,
  menuOpenRequestSequence,
}: {
  block: PeekBlock;
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestRename: (block: PeekBlock) => void;
  onRequestDelete: (slug: string) => void;
  onRenameFile: (block: PeekBlock, newStem: string) => Promise<void>;
  onCheckFileName: (block: PeekBlock, newStem: string) => Promise<RenameBlockError | null>;
  /** Full page: the window fades and the same card stands full (О9). */
  onExpand: () => void;
  onClose: () => void;
  menuOpenRequestSequence: number;
}) {
  // The page counts ⌘K over every open card; the plate's menu answers the
  // requests that came since this window opened.
  const menuBaselineRef = useRef(menuOpenRequestSequence);
  return (
    <header
      className="flex shrink-0 flex-col bg-accent"
      style={{ height: CARD_PEEK_PLATE_HEIGHT_PX }}
      data-card-peek-plate=""
    >
      <div className="flex min-h-0 flex-1 items-center gap-1 pl-[var(--chrome-edge-pad)]">
        <Button
          type="button"
          variant="chrome"
          size="chrome-icon"
          aria-label="Open as full page"
          onClick={onExpand}
          data-card-peek-expand=""
        >
          <Maximize2 />
        </Button>
        <DetailCardFileName block={block} onRename={onRenameFile} onCheck={onCheckFileName} />
        <ChromeActions className="ml-auto">
          <CardMoreMenu
            block={block}
            vaultPath={vaultPath}
            tags={tags}
            currentTag={currentTag}
            onToggleTag={onToggleTag}
            onCreateAndAssign={onCreateAndAssign}
            onRequestRename={onRequestRename}
            onRequestDelete={onRequestDelete}
            triggerVariant="chrome"
            triggerShortcut={commandById("element-menu-open").combo}
            openRequestSequence={menuOpenRequestSequence - menuBaselineRef.current}
          />
          <ChromeCloseButton onClick={onClose} />
        </ChromeActions>
      </div>
      <Separator data-chrome-divider="" />
    </header>
  );
}
