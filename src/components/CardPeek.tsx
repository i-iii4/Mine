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
  Fragment,
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
  carriedPeekImage,
  carriedPeekRect,
  cardPeekStackedMaxWidth,
  centerPeekRect,
  centredPeekRect,
  clampUnit,
  intersectPeekRect,
  lerpPeekRect,
  mainPeekTile,
  pairPeekGallery,
  peekClosingKind,
  peekContentOpacity,
  peekFrameCut,
  peekFrameTransforms,
  peekLaidMediaTransforms,
  peekMediaTransforms,
  peekNudgeTransform,
  peekOpeningKind,
  peekRideOpacity,
  peekSpringSettled,
  peekSurfaceTransforms,
  peekTileEdgeRects,
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
  type PeekTileEdge,
} from "@/lib/cardPeek";
import {
  detailPeekMediaFrame,
  detailPeekMediaFrames,
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
  /** The share the card's riding parts show at (`peekRideOpacity`), and
   *  where it stood when the motion took its direction. */
  rideStart: number;
  ride: number;
  /** The card's frame, in the window's space (`card` only). */
  card: PeekRect | null;
  /** The pictures it carries, in the order they stand on the page. */
  flights: PeekFlight[];
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

/** One picture a movement carries (О10, п. 3), in the window's space:
 *  from the card's place to the window's own frame for it (`fly`), or
 *  carried by the window's frame (`ride`, a gallery's tile with no picture
 *  of its own in the window). A gallery's tile carries its halves of the
 *  seams round it (`edges`). */
interface PeekFlight {
  kind: "fly" | "ride";
  from: PeekMediaPlace;
  /** The window's frame for it (`fly`). */
  to: PeekMediaPlace | null;
  /** Where it is laid out (null: the whole window). */
  laid: PeekRect | null;
  /** Where its picture is laid out in it, from its origin (null: over the
   *  whole of it). A `ride` is laid out as the card shows it, so it lands
   *  as the card draws it. */
  laidImage: PeekRect | null;
  /** The picture's own size: a `ride` covers the box the frame carries. */
  naturalWidth: number;
  naturalHeight: number;
  /** It fades under the content (no frame of its own in the window), or by
   *  the window's share (`ride`). */
  fades: "content" | "share" | null;
  edges: PeekTileEdge[];
  /** A `ride` held beside this flight, the gallery's main picture: it goes
   *  with it as one piece, offset and scaled as it is (О10, п. 3); with
   *  none, it rides the window's frame. */
  follows?: number;
  /** A `ride`'s picture keeps its own size at its clip's top left (the
   *  card's text, as the window's content does), not covering the clip. */
  fixed?: boolean;
  /** The card's line under its media where it runs along the bottom of
   *  this picture: its offset from the clip's bottom and its height. It
   *  goes with the picture, and is the card's: it fades as the card does. */
  underline: { offset: number; height: number } | null;
  /** The window's own picture it stands for, hidden while it rides over it. */
  hidden: HTMLElement | null;
}

/** What a flight shows on the page: its picture, its half seams in the
 *  seams' colour, and the window's original it is, by its address, kept
 *  for the closing. */
interface PeekFlyer {
  kind: PeekFlight["kind"];
  picture: PeekPicture | null;
  /** The card's own picture under the window's original it carries, drawn
   *  alike: a large original WebKit has not drawn yet in its first frame
   *  leaves the tile's picture showing, never the window's fill. */
  backing: PeekPicture | null;
  edges: number;
  seams: string | null;
  /** The colour of the card's line under its media, when the flight
   *  carries a part of it. */
  underline: string | null;
  laid: PeekRect | null;
  laidImage: PeekRect | null;
  original: string | null;
}

/** Waiting, before a movement, for the card to be whole. */
interface PeekPreparation {
  frame: number | null;
  /** The window's originals the movement carries, once decoded, by their
   *  addresses. */
  pictures: Map<string, PeekPicture>;
  /** How many are still decoding. */
  decoding: number;
}

/** The picture a movement carries: an `<img>` decoded before the start (the
 *  window's own original, so the end needs no swap), a copy of a gallery
 *  tile's picture, or a canvas drawn from what the card shows when the
 *  window has no picture of its own. */
interface PeekPicture {
  element: HTMLElement;
  naturalWidth: number;
  naturalHeight: number;
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
  /** Each flight's clip, picture, half seams and line, by the motion's
   *  flights. */
  flights: ({
    clip: HTMLElement;
    image: HTMLElement | null;
    backing: HTMLElement | null;
    edges: HTMLElement[];
    underline: HTMLElement | null;
  } | null)[];
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
function PeekFrameUnder({ view, cut }: { view: PeekMotionView; cut: PeekFrameCut }) {
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
      {PEEK_FRAME_CORNERS.map((corner) => (
        <div
          key={corner}
          className={cn(FRAME_PIECE_CLASS, "overflow-hidden")}
          style={pieceStyle(corner, cut)}
          data-peek-piece={corner}
        >
          {shape(cardOnTop ? "window" : "card", corner, false)}
          {shape(cardOnTop ? "card" : "window", corner, true)}
        </div>
      ))}
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
  const gallery = source.gallery;
  const relative = (box: PeekRect) => relativePeekRect(box, origin);
  return {
    rect: relative(source.rect),
    media: source.media
      ? { clip: relative(source.media.clip), image: relative(source.media.image) }
      : null,
    gallery: gallery
      ? {
        ...gallery,
        clip: relative(gallery.clip),
        tiles: gallery.tiles.map((tile) => ({ ...tile, clip: relative(tile.clip), image: relative(tile.image) })),
      }
      : null,
    underline: source.underline ? { ...source.underline, y: source.underline.y - origin.y } : null,
    text: source.text ? { element: source.text.element, rect: relative(source.text.rect) } : null,
  };
}

/** The window's originals the flights carry, by their addresses. */
function carriedOriginals(flyers: readonly PeekFlyer[]): Map<string, PeekPicture> {
  const kept = new Map<string, PeekPicture>();
  for (const flyer of flyers) if (flyer.original && flyer.picture) kept.set(flyer.original, flyer.picture);
  return kept;
}

/** The address of a window media frame's original picture. */
function originalOf(frame: HTMLElement | null): string | null {
  const original = frame?.querySelector<HTMLImageElement>("img:not([data-detail-preview-backing])");
  return original ? original.currentSrc || original.src || null : null;
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
    flights: PeekFlyer[];
  } | null>(null);
  const flyerRef = useRef<PeekFlyer[]>([]);
  flyerRef.current = flyer?.flights ?? [];
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
  // The window's originals an opening carried, kept decoded for the
  // closing, by their addresses.
  const restPicturesRef = useRef<Map<string, PeekPicture>>(new Map());
  const scrimRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const flightClipsRef = useRef<(HTMLDivElement | null)[]>([]);
  const flightEdgesRef = useRef<(HTMLDivElement | null)[][]>([]);
  const flightLinesRef = useRef<(HTMLDivElement | null)[]>([]);
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
    for (const flight of motion?.flights ?? []) if (flight.hidden) flight.hidden.style.visibility = "";
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
    const transform = peekNudgeTransform(nudge.spring.position * carried);
    wrap.style.transform = transform;
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

  /** Every media frame of the open card where it stands in the window's
   *  space, read once, when a movement starts: the part the window shows
   *  of it now (inside the window and the content's scroll), and its
   *  original's address. */
  const readWindowFrames = useCallback(() => {
    const contentElement = contentRef.current;
    if (!contentElement) return [];
    const contentBox = rectOf(contentElement);
    // As `readWindowMedia`: the step's scale taken out.
    const scale = 1 - (1 - CARD_PEEK_NUDGE_SCALE) * nudgeSpringRef.current.spring.position;
    const inWindow = (box: PeekRect): PeekRect => ({
      x: (box.x - contentBox.x) / scale + 1,
      y: (box.y - contentBox.y) / scale + 1,
      width: box.width / scale,
      height: box.height / scale,
    });
    const { width, height } = sizeRef.current;
    const interior = { x: 1, y: 1, width: width - 2, height: height - 2 };
    return detailPeekMediaFrames(contentElement).map(({ frame, source }) => {
      const image = inWindow(rectOf(frame));
      let seen = interior;
      for (let element = frame.parentElement; element && element !== contentElement; element = element.parentElement) {
        if (getComputedStyle(element).overflowY !== "visible") seen = intersectPeekRect(seen, inWindow(rectOf(element)));
      }
      const clip = intersectPeekRect(image, seen);
      return { frame, source, place: { clip, image }, shown: clip.width > 0 && clip.height > 0, original: originalOf(frame) };
    });
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
    const card = motion.card;
    motion.flights.forEach((flight, index) => {
      const piece = pieces.flights[index];
      if (!piece || !card) return;
      let clip: PeekRect;
      let image: PeekRect;
      // Its whole box before the frame cuts it: its seams go by it.
      let whole: PeekRect;
      if (flight.to) {
        clip = lerpPeekRect(flight.from.clip, flight.to.clip, p);
        image = lerpPeekRect(flight.from.image, flight.to.image, p);
        whole = clip;
      } else {
        // Carried beside the gallery's main picture as one piece with it, or
        // by the frame, stretched as it is, and inside the frame; its
        // picture is not stretched, and covers the box it is carried in
        // (О10, п. 3).
        const lead = flight.follows !== undefined ? motion.flights[flight.follows] : undefined;
        whole = lead?.to
          ? carriedPeekRect(lead.from.clip, lerpPeekRect(lead.from.clip, lead.to.clip, p), flight.from.clip)
          : carriedPeekRect(card, shown, flight.from.clip);
        clip = intersectPeekRect(whole, shown);
        image = flight.fixed
          ? { x: whole.x, y: whole.y, width: flight.from.image.width, height: flight.from.image.height }
          : carriedPeekImage(flight.from, whole);
      }
      const media = flight.laidImage
        ? peekLaidMediaTransforms(flight.laid ?? place, flight.laidImage, clip, image)
        : peekMediaTransforms(flight.laid ?? place, clip, image);
      piece.clip.style.transform = media.clip;
      if (piece.image) piece.image.style.transform = media.image;
      if (piece.backing) piece.backing.style.transform = media.image;
      const opacity = String(flight.fades === "content" ? 1 - motion.content : flight.fades === "share" ? motion.ride : 1);
      piece.clip.style.opacity = opacity;
      // Its halves of the seams stand at its sides, their own width on
      // screen however far the tile is scaled.
      const pixelBox = (element: HTMLElement, box: PeekRect) => {
        element.style.transform = `translate(${box.x}px, ${box.y}px) scale(${box.width}, ${box.height})`;
      };
      peekTileEdgeRects(whole, flight.edges, flight.from.clip).forEach((box, edge) => {
        const element = piece.edges[edge];
        if (!element) return;
        // Inside the frame, as the tile is.
        pixelBox(element, intersectPeekRect(box, shown));
        element.style.opacity = opacity;
      });
      if (piece.underline && flight.underline) {
        // Across the picture and its half seams, its own height on screen.
        const side = (name: PeekTileEdge["side"]) => flight.edges.find((edge) => edge.side === name)?.width ?? 0;
        pixelBox(piece.underline, intersectPeekRect({
          x: whole.x - side("left"),
          y: whole.y + whole.height + flight.underline.offset,
          width: whole.width + side("left") + side("right"),
          height: flight.underline.height,
        }, shown));
        piece.underline.style.opacity = flight.fades === "share" ? opacity : String(1 - p);
      }
    });
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
      // A resize carries no picture: the opening's stay kept.
      if (flyerRef.current.length > 0) restPicturesRef.current = carriedOriginals(flyerRef.current);
      flushSync(() => setFlyer(null));
      handoverRef.current = requestAnimationFrame(dropLayers);
    };
    const step = (now: number) => {
      handoverRef.current = null;
      // Every picture stood for: each of the window's own shows under its own.
      const shown = motion.flights.every((flight) => {
        const original = flight.hidden?.querySelector<HTMLImageElement>("img:not([data-detail-preview-backing])") ?? null;
        return !original || (original.complete && original.naturalWidth > 0 && original.style.opacity !== "0");
      });
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
        restPicturesRef.current = new Map();
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
    motion.ride = peekRideOpacity(motion.direction, motion.elapsed, motion.rideStart);
    motion.content = motion.kind === "card"
      ? peekContentOpacity(motion.direction, motion.elapsed, motion.contentStart)
      : 1;
    const settled = peekSpringSettled(motion.spring);
    if (settled) {
      motion.spring = { position: motion.spring.target, velocity: 0, target: motion.spring.target };
      motion.content = motion.spring.target;
      motion.ride = 1 - motion.spring.target;
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
    const flights = flyerRef.current.map((flight, index) => {
      const clip = flightClipsRef.current[index];
      if (!clip) return null;
      const element = flight.picture?.element ?? null;
      const backing = flight.backing?.element ?? null;
      if (element && clip.lastChild !== element) {
        const box = flight.laidImage;
        for (const picture of [backing, element]) {
          if (!picture) continue;
          picture.className = cn(FLYER_CLASS, !box && "inset-0 size-full");
          // Wider than its clip, as the card's picture is: no clamp to it.
          if (box) Object.assign(picture.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px`, maxWidth: "none", maxHeight: "none" });
        }
        element.setAttribute("data-peek-media", "");
        clip.replaceChildren(...(backing ? [backing, element] : [element]));
      }
      const edges = (flightEdgesRef.current[index] ?? []).slice(0, flight.edges).filter((edge): edge is HTMLDivElement => edge !== null);
      return { clip, image: element, backing, edges, underline: flight.underline ? flightLinesRef.current[index] ?? null : null };
    });
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
      flights,
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
   *  this frame is painted. `pictures` are the window's originals decoded
   *  for it to carry for a card, by their addresses. */
  const start = useCallback((
    kind: MovingKind,
    slug: string,
    spring: PeekSpring,
    contentStart: number,
    source: PeekSource | null,
    pictures: ReadonlyMap<string, PeekPicture>,
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
    const place = kind === "card" && source ? sourcePlace(source, box) : null;
    const flights: PeekFlight[] = [];
    const flyers: PeekFlyer[] = [];
    const used = new Set<PeekPicture>();
    const original = (address: string | null) => {
      const picture = address ? pictures.get(address) : undefined;
      if (!picture || used.has(picture)) return null;
      used.add(picture);
      return picture;
    };
    // The card's line under its media, where it runs along the bottom of a
    // picture's part: within the seam's reach of it.
    const underlineOf = (clip: PeekRect) => {
      const line = place?.underline;
      if (!line) return null;
      const offset = line.y - (clip.y + clip.height);
      return Math.abs(offset) <= 2 ? { offset, height: line.height } : null;
    };
    // The card's title and text go with its main picture as one piece with
    // it (with no picture, with the frame), under all its pictures, and come
    // back with the card (О11, п. 2).
    if (place?.text) {
      const box = place.text.rect;
      const wrap = document.createElement("div");
      wrap.append(place.text.element);
      flights.push({
        kind: "ride", from: { clip: box, image: box }, to: null, laid: box, laidImage: { x: 0, y: 0, width: box.width, height: box.height },
        naturalWidth: box.width, naturalHeight: box.height, fades: "share", hidden: null, edges: [], fixed: true, underline: null,
      });
      flyers.push({
        kind: "ride", picture: { element: wrap, naturalWidth: box.width, naturalHeight: box.height }, backing: null,
        edges: 0, seams: null, underline: null, laid: box, laidImage: { x: 0, y: 0, width: box.width, height: box.height }, original: null,
      });
    }
    if (place?.gallery) {
      // A gallery: each tile whose picture the window shows now flies to
      // it, the others and the seams ride the frame (О10, п. 3; О11, п. 2).
      const gallery = place.gallery;
      const frames = readWindowFrames();
      const pairs = pairPeekGallery(gallery.tiles.map((tile) => tile.source), frames);
      type Tile = (typeof gallery.tiles)[number];
      const tilePicture = (tile: Tile): PeekPicture => ({
        element: tile.picture, naturalWidth: tile.naturalWidth, naturalHeight: tile.naturalHeight,
      });
      // The card's own picture is laid out as the card shows it, so it is
      // drawn there from the first frame and lands as the card draws it.
      const laidAtCard = (tile: Tile) => ({ x: tile.image.x - tile.clip.x, y: tile.image.y - tile.clip.y, width: tile.image.width, height: tile.image.height });
      // Only the main tile flies: the one of the first of the window's
      // pictures it shows that a tile has (the window's main picture, else
      // the first under it). The others stay by it as one piece with it
      // (О10, п. 3; user's decision of 26.10.2026).
      const lead = mainPeekTile(pairs);
      const rides = (index: number) => index !== lead;
      // The gallery goes as one piece: each seam goes with its tiles, whole,
      // drawn once by the first of them (two halves meeting at a fraction
      // of a pixel let the window's fill show between them).
      const seamsOf = (tile: Tile, index: number) => tile.edges.flatMap((edge) => (
        edge.across.every((other) => other > index) ? [{ ...edge, width: edge.width * 2, carried: true }] : []
      ));
      gallery.tiles.forEach((tile, index) => {
        if (!rides(index)) return;
        const laidImage = laidAtCard(tile);
        const edges = seamsOf(tile, index);
        flights.push({
          kind: "ride", from: tile, to: null, laid: tile.clip, laidImage,
          naturalWidth: tile.naturalWidth, naturalHeight: tile.naturalHeight, fades: "share", hidden: null,
          edges, underline: underlineOf(tile.clip),
        });
        flyers.push({
          kind: "ride", picture: tilePicture(tile), backing: null, edges: edges.length, seams: gallery.seams,
          underline: underlineOf(tile.clip) ? place.underline?.colour ?? null : null, laid: tile.clip, laidImage, original: null,
        });
      });
      const flying = gallery.tiles
        .map((tile, index) => ({ tile, index, frame: index === lead ? frames[pairs[index] ?? -1] : undefined }))
        .filter((entry): entry is { tile: Tile; index: number; frame: NonNullable<typeof entry.frame> } => entry.frame !== undefined);
      for (const { tile, index, frame } of flying) {
        const edges = seamsOf(tile, index);
        const carried = original(frame.original);
        // The window's original is laid out where it lands, in the part of
        // it the window shows (a frame laid out past the window's edge shows
        // blank in WebKit in its first frame); the card's own picture, when
        // none is decoded, where it starts.
        const laidBox = carried ? frame.place.clip : tile.clip;
        const laidImage = carried
          ? { ...frame.place.image, x: frame.place.image.x - frame.place.clip.x, y: frame.place.image.y - frame.place.clip.y }
          : laidAtCard(tile);
        flights.push({
          kind: "fly", from: tile, to: frame.place, laid: laidBox, laidImage,
          naturalWidth: tile.naturalWidth, naturalHeight: tile.naturalHeight, fades: null, hidden: frame.frame,
          edges, underline: underlineOf(tile.clip),
        });
        flyers.push({
          kind: "fly", picture: carried ?? tilePicture(tile), backing: carried ? tilePicture(tile) : null, edges: edges.length, seams: gallery.seams,
          underline: underlineOf(tile.clip) ? place.underline?.colour ?? null : null,
          laid: laidBox, laidImage, original: carried ? frame.original : null,
        });
        frame.frame.style.visibility = "hidden";
      }
      // The other tiles stay by the main one, as one piece with it.
      const leadFlight = flying.length > 0 ? flights.length - 1 : -1;
      if (leadFlight >= 0) for (const flight of flights) if (flight.kind === "ride") flight.follows = leadFlight;
    } else if (place?.media && source?.media) {
      const sourceMedia = source.media;
      const measured = readWindowMedia();
      const address = measured ? originalOf(measured.frame) : null;
      // A picture drawn as one carries itself: the window's own picture is
      // only one of its parts.
      const decoded = sourceMedia.composite ? null : original(address);
      const carried = decoded ?? canvasPicture(sourceMedia.drawable, sourceMedia.naturalWidth, sourceMedia.naturalHeight);
      const to = measured?.place
        ?? carriedPeekMediaPlace(place.rect, place.media, laid(), sourceMedia.naturalWidth, sourceMedia.naturalHeight);
      const fades = sourceMedia.composite || measured === null;
      const hidden = measured && !fades ? measured.frame : null;
      if (hidden) hidden.style.visibility = "hidden";
      const underline = underlineOf(place.media.clip);
      flights.push({
        kind: "fly", from: place.media, to, laid: to.image, laidImage: null,
        naturalWidth: sourceMedia.naturalWidth, naturalHeight: sourceMedia.naturalHeight, fades: fades ? "content" : null, hidden,
        edges: [], underline,
      });
      flyers.push({
        kind: "fly", picture: carried, backing: null, edges: 0, seams: null, underline: underline ? place.underline?.colour ?? null : null,
        laid: to.image, laidImage: null, original: decoded ? address : null,
      });
      // The card's text goes with its picture, as one piece with it.
      for (const flight of flights) if (flight.kind === "ride") flight.follows = flights.length - 1;
    }
    // A movement that takes another's place carries the riding parts'
    // share on; else they show as much as the card does.
    const rideFrom = previous && previous.slug === slug && previous.kind === "card"
      ? previous.ride
      : 1 - clampUnit(spring.position);
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
      rideStart: rideFrom,
      ride: rideFrom,
      card: place?.rect ?? null,
      flights,
      widths: [null, null],
      windowWidth,
      frame: null,
    };
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
      setFlyer(flyers.length > 0 ? { id, flights: flyers } : null);
      setClosing(spring.target === 0);
      setPreparing(false);
      setLive(false);
    });
    gatherAndPaint();
  // `hideCard`, `holdGate`, `laid` and `viewFor` read only refs, the store
  // and their arguments.
  }, [gatherAndPaint, readWindowFrames, readWindowMedia]);

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
      rideStart: 0,
      ride: 0,
      card: null,
      flights: [],
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
   *  module is in, its work done (`track`) and a frame past it, and the
   *  pictures asked for (`wantsPictures`, by their addresses: one to decode,
   *  or one decoded already) decoded. */
  const prepare = useCallback((
    begin: (now: number, pictures: ReadonlyMap<string, PeekPicture>) => void,
    wantsPictures: () => ReadonlyMap<string, string | PeekPicture>,
    needsCard: boolean,
  ) => {
    cancelPreparation();
    const preparation: PeekPreparation = { frame: null, pictures: new Map(), decoding: 0 };
    preparationRef.current = preparation;
    let asked = false;
    // Counted from the input's own commit, so the wait is bounded from the
    // press, not from the first frame after it.
    const since = performance.now();
    const step = (now: number) => {
      preparation.frame = null;
      if (preparationRef.current !== preparation) return;
      if (!asked) {
        const wanted = wantsPictures();
        asked = wanted.size > 0;
        for (const [address, picture] of wanted) {
          if (typeof picture !== "string") {
            // Decoded already: nothing to wait for.
            preparation.pictures.set(address, picture);
            continue;
          }
          preparation.decoding += 1;
          void decodedPicture(picture).then((decoded) => {
            if (decoded) preparation.pictures.set(address, decoded);
            preparation.decoding -= 1;
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
        && preparation.decoding === 0;
      if (ready || now - since >= CARD_PEEK_PREPARE_MAX_MS) {
        preparationRef.current = null;
        begin(now, preparation.pictures);
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
      restPicturesRef.current = new Map();
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
      // A window a key opened at once still fades in place when it closes
      // other than by Escape (О11).
      openedAsRef.current = from === "keyboard" && kind === "instant" && !(opening?.restored ?? false) ? "fade" : kind;
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
        (now, pictures) => {
          const source = movingKind === "card" && area ? findPeekSource(area, slug) : null;
          start(source || movingKind !== "card" ? movingKind : "center", slug, { position: 0, velocity: 0, target: 1 }, 0, source, pictures, now);
        },
        () => {
          const wanted = new Map<string, string>();
          if (movingKind !== "card" || !contentRef.current) return wanted;
          // The window's own originals the card's pictures fly to: its one
          // picture, or each of a gallery's the window shows.
          const tiles = preparedSource?.gallery?.tiles.map((tile) => tile.source);
          if (tiles) {
            const frames = readWindowFrames();
            const pairs = pairPeekGallery(tiles, frames);
            const address = frames[pairs[mainPeekTile(pairs)] ?? -1]?.original;
            if (address) wanted.set(address, address);
          } else {
            const address = originalOf(detailPeekMediaFrame(contentRef.current));
            if (address) wanted.set(address, address);
          }
          return wanted;
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
      const source = openedAsRef.current === "card" && area ? findPeekSource(area, held.slug) : null;
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
          moving.rideStart = moving.ride;
          setClosing(true);
          moving.frame = requestAnimationFrame(tick);
          return;
        }
        start(kind, slug, spring, moving.content, kind === "card" ? source : null, carriedOriginals(flyerRef.current), performance.now());
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
      const keptFlyer = carriedOriginals(flyerRef.current);
      cancelHandover();
      holdGate();
      setLive(false);
      setClosing(true);
      const openedAs = openedAsRef.current;
      prepare(
        (now, pictures) => {
          // Where the card stands as the closing starts, the feed or the
          // graph after a change of place included (О11).
          const place = openedAs === "card" && area ? findPeekSource(area, slug) : null;
          const kindNow = peekClosingKind({ openedAs, exit: exitRef.current, reducedMotion, cardOnScreen: place !== null });
          if (kindNow === "none") {
            vanish();
            return;
          }
          if (kindNow === "center" && openedAs === "card") {
            leaveAsDialog();
            return;
          }
          start(kindNow, slug, { position: 1, velocity: 0, target: 0 }, 1, kindNow === "card" ? place : null, kindNow === "card" ? pictures : new Map(), now, restWidth);
        },
        () => {
          const wanted = new Map<string, PeekPicture>();
          if (openedAs !== "card" || !contentRef.current) return wanted;
          // The pictures the opening carried are still decoded: the closing
          // carries each back to its tile while the window's frame is still
          // of that file. Else it carries the card's own picture (`start`):
          // decoding the window's file once more while the window shows it
          // leaves the window's picture blank in WebKit until that decode
          // ends.
          const kept = new Map([...restPicturesRef.current, ...keptFlyer]);
          for (const { frame } of detailPeekMediaFrames(contentRef.current)) {
            const address = originalOf(frame);
            const picture = address ? kept.get(address) : undefined;
            if (address && picture) wanted.set(address, picture);
          }
          return wanted;
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
  /** A flight on the page: its clip, its halves of the seams and its part
   *  of the card's line under its media. */
  const renderFlight = (flight: PeekFlyer, index: number) => (
    <Fragment key={`${flyer?.id ?? 0}-${index}`}>
      <div
        ref={(element) => {
          flightClipsRef.current[index] = element;
        }}
        className={cn(FLYER_CLASS, "overflow-hidden")}
        style={flyerBox(flight.laid)}
        data-peek-media-clip=""
        data-peek-flight={flight.kind}
      />
      {/* Its halves of the seams, a pixel box each, scaled to stand. */}
      {Array.from({ length: flight.edges }, (_, edge) => (
        <div
          key={edge}
          ref={(element) => {
            const edges = flightEdgesRef.current[index] ?? [];
            edges[edge] = element;
            flightEdgesRef.current[index] = edges;
          }}
          className={cn(FRAME_PIECE_CLASS, "left-0 top-0 size-px")}
          style={{ background: flight.seams ?? undefined }}
          data-peek-media-edge=""
        />
      ))}
      {flight.underline && (
        <div
          ref={(element) => {
            flightLinesRef.current[index] = element;
          }}
          className={cn(FRAME_PIECE_CLASS, "left-0 top-0 size-px")}
          style={{ background: flight.underline }}
          data-peek-media-underline=""
        />
      )}
    </Fragment>
  );

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
        {view && cut && <PeekFrameUnder view={view} cut={cut} />}
        {/* A gallery's tiles riding the frame, under the window's content
            showing in (О10, п. 3). */}
        {flyer?.flights.map((flight, index) => (flight.kind === "ride" ? renderFlight(flight, index) : null))}
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
        {/* The tiles flying to the window's own pictures, over its content. */}
        {flyer?.flights.map((flight, index) => (flight.kind === "fly" ? renderFlight(flight, index) : null))}
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
