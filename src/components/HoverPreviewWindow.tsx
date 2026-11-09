// The one hover preview window of the sidebar, the open card's panel and the
// graph (SPEC_CARD_STATES.md, С7.11): the cards, the frame in pieces while a card or
// a height changes, and the writes of each frame. What the window does lives
// in src/lib/hoverPreviewWindow.ts.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { HoverIntentHandle } from "@/hooks/useHoverIntent";
import { useHoverPreviewOpener } from "@/hooks/useHoverPreviewOpener";
import {
  CARD_PEEK_PREPARE_MAX_MS,
  PEEK_FRAME_CORNERS,
  peekFrameCornerShapeStyle,
  peekFrameCut,
  peekFramePieceStyle,
  peekFrameTransforms,
  type PeekFrameCut,
  type PeekFramePiece,
} from "@/lib/cardPeek";
import {
  HOVER_PREVIEW_WINDOW_WIDTH_PX,
  HoverPreviewWindow,
  type HoverPreviewMeasure,
  type HoverPreviewPlacer,
  type HoverPreviewTarget,
  type HoverPreviewWindowPaint,
} from "@/lib/hoverPreviewWindow";
import { cn } from "@/lib/utils";
import type { IndexedBlock, LightBlock } from "@/types";
import { ReadOnlyCardPreview } from "./Card";

/** One surface's window: the sidebar's, the open card's panel's or the graph's. */
export function useHoverPreviewWindow<TTarget extends HoverPreviewTarget, TCard>(options: {
  intent: HoverIntentHandle;
  readCard: (slug: string) => Promise<TCard | null>;
  place: HoverPreviewPlacer<TTarget>;
  /** The target moves on its own, as a node of the graph does. */
  tracksTarget?: boolean;
  onShown?: (target: TTarget | null) => void;
}): HoverPreviewWindow<TTarget, TCard> {
  const latest = useRef(options);
  latest.current = options;
  const { intent } = options;
  const opener = useHoverPreviewOpener(intent.isAttending);
  const [controller] = useState(() => new HoverPreviewWindow<TTarget, TCard>({
    opener,
    isAttending: () => latest.current.intent.isAttending(),
    readCard: (slug) => latest.current.readCard(slug),
    place: (target, height, moment) => latest.current.place(target, height, moment),
    tracksTarget: options.tracksTarget,
    onShown: (target) => latest.current.onShown?.(target),
  }));
  useEffect(() => {
    intent.setAttendingListener(() => controller.attendingChanged());
    return () => intent.setAttendingListener(null);
  }, [controller, intent]);
  useEffect(() => () => controller.dispose(), [controller]);
  return controller;
}

/** A piece of the frame: moved by the frames' writes, drawn in the window's own
 *  layer, no transition, the 0.01 ms one "Reduce motion" gives every element
 *  included (global.css), which would show each frame's value a frame late. */
const FRAME_PIECE_CLASS = "pointer-events-none absolute origin-top-left transition-none";

function FrameUnder({ cut, radius }: { cut: PeekFrameCut; radius: number }) {
  return (
    <>
      <div
        className={cn(FRAME_PIECE_CLASS, "shadow-lg")}
        style={{ ...peekFramePieceStyle("shadow", cut), borderRadius: radius }}
        data-preview-frame-piece="shadow"
      />
      {(["bandAcross", "bandDown"] as const).map((piece) => (
        <div
          key={piece}
          className={cn(FRAME_PIECE_CLASS, "bg-card")}
          style={peekFramePieceStyle(piece, cut)}
          data-preview-frame-piece={piece}
        />
      ))}
      {PEEK_FRAME_CORNERS.map((corner) => (
        <div
          key={corner}
          className={cn(FRAME_PIECE_CLASS, "overflow-hidden")}
          style={peekFramePieceStyle(corner, cut)}
          data-preview-frame-piece={corner}
        >
          <div className="absolute bg-card" style={peekFrameCornerShapeStyle(corner, cut, radius)} />
        </div>
      ))}
    </>
  );
}

function FrameOver({ cut, radius }: { cut: PeekFrameCut; radius: number }) {
  return (
    <>
      {(["lineTop", "lineBottom", "lineLeft", "lineRight"] as const).map((piece) => (
        <div
          key={piece}
          className={cn(FRAME_PIECE_CLASS, "bg-border")}
          style={peekFramePieceStyle(piece, cut)}
          data-preview-frame-piece={piece}
        />
      ))}
      {PEEK_FRAME_CORNERS.map((corner) => (
        <div
          key={corner}
          className={cn(FRAME_PIECE_CLASS, "overflow-hidden")}
          style={peekFramePieceStyle(corner, cut)}
          data-preview-frame-piece={corner}
        >
          <div className="absolute border border-border" style={peekFrameCornerShapeStyle(corner, cut, radius)} />
        </div>
      ))}
    </>
  );
}

/** The elements a frame writes, gathered once per view. */
interface Written {
  pieces: { element: HTMLElement; piece: PeekFramePiece }[];
  layers: Map<number, { element: HTMLElement; media: HTMLElement | null }>;
}

function measureCard(layer: HTMLElement): HoverPreviewMeasure {
  const frame = layer.querySelector<HTMLElement>("[data-feed-card-frame]");
  const media = layer.querySelector<HTMLElement>("[data-card-preview-media-box]");
  return {
    height: layer.getBoundingClientRect().height,
    mediaHeight: media?.getBoundingClientRect().height ?? 0,
    radius: frame ? Number.parseFloat(getComputedStyle(frame).borderTopLeftRadius) || 0 : 0,
  };
}

/** Until the card's pictures are decoded, `CARD_PEEK_PREPARE_MAX_MS` at most. */
function cardDecoded(layer: HTMLElement): Promise<unknown> {
  const decodes = Array.from(layer.querySelectorAll("img"), (image) => (
    typeof image.decode === "function" ? image.decode() : undefined
  ));
  return Promise.race([
    Promise.allSettled(decodes),
    new Promise((resolve) => window.setTimeout(resolve, CARD_PEEK_PREPARE_MAX_MS)),
  ]);
}

function round(value: number): number {
  return Math.round(value * 1e3) / 1e3;
}

export function HoverPreviewWindowLayer<TTarget extends HoverPreviewTarget>({
  controller,
  vaultPath,
  thumbsRootPath,
  thumbVersions,
  attribute,
}: {
  controller: HoverPreviewWindow<TTarget, LightBlock | IndexedBlock>;
  vaultPath: string;
  thumbsRootPath?: string;
  /** Rebuilt thumbnails' versions, where the surface keeps them. */
  thumbVersions?: ReadonlyMap<string, number>;
  /** The surface's own name of the window, for its tests and audits. */
  attribute: string;
}) {
  const view = useSyncExternalStore(controller.subscribe, controller.getView);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const clipRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const writtenRef = useRef<Written>({ pieces: [], layers: new Map() });
  const measuredRef = useRef<number | null>(null);
  const cut = useMemo(() => peekFrameCut(view?.radius ?? 0, view?.radius ?? 0), [view?.radius]);

  useLayoutEffect(() => {
    controller.setPainter((paint: HoverPreviewWindowPaint) => {
      const shell = shellRef.current;
      const clip = clipRef.current;
      const inner = innerRef.current;
      if (!shell || !clip || !inner) return;
      shell.style.left = `${paint.left}px`;
      shell.style.top = `${paint.laidTop}px`;
      shell.style.height = `${paint.laidHeight}px`;
      shell.style.transform = paint.translateX === 0 && paint.translateY === 0
        ? ""
        : `translate(${paint.translateX}px, ${paint.translateY}px)`;
      shell.style.opacity = paint.opacity === 1 ? "" : String(round(paint.opacity));
      shell.style.willChange = paint.moving ? "transform, opacity" : "";
      const written = writtenRef.current;
      if (paint.frameMoving) {
        const laid = { width: HOVER_PREVIEW_WINDOW_WIDTH_PX, height: paint.laidHeight };
        const shown = { x: 0, y: 0, width: HOVER_PREVIEW_WINDOW_WIDTH_PX, height: paint.height };
        const transforms = peekFrameTransforms(laid, shown, cut);
        for (const { element, piece } of written.pieces) element.style.transform = transforms[piece];
        const scale = paint.laidHeight > 0 ? paint.height / paint.laidHeight : 1;
        clip.style.transform = scale === 1 ? "" : `scale(1, ${scale})`;
        inner.style.transform = scale === 1 || scale === 0 ? "" : `scale(1, ${1 / scale})`;
      } else {
        clip.style.transform = "";
        inner.style.transform = "";
      }
      for (const layer of paint.layers) {
        const target = written.layers.get(layer.id);
        if (!target) continue;
        target.element.style.opacity = layer.opacity === 1 ? "" : String(round(layer.opacity));
        target.element.style.willChange = layer.opacity === 1 ? "" : "opacity";
        if (target.media) target.media.style.transform = layer.coverScale === 1 ? "" : `scale(${layer.coverScale})`;
      }
    });
    return () => controller.setPainter(null);
  }, [controller, cut]);

  // After each view: gather what the frames write, take the geometry, and lay
  // a pending card out once for its measure.
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      writtenRef.current = { pieces: [], layers: new Map() };
      measuredRef.current = null;
      return;
    }
    const written: Written = { pieces: [], layers: new Map() };
    for (const element of shell.querySelectorAll<HTMLElement>("[data-preview-frame-piece]")) {
      written.pieces.push({ element, piece: element.dataset.previewFramePiece as PeekFramePiece });
    }
    for (const element of shell.querySelectorAll<HTMLElement>("[data-hover-preview-layer]")) {
      written.layers.set(Number(element.dataset.hoverPreviewLayer), {
        element,
        media: element.querySelector<HTMLElement>("[data-card-preview-media-box]"),
      });
    }
    writtenRef.current = written;
    controller.repaint();

    const pending = view?.layers.find((layer) => layer.role === "pending");
    if (!pending || measuredRef.current === pending.id) return;
    measuredRef.current = pending.id;
    const layer = written.layers.get(pending.id)?.element;
    if (!layer) return;
    const measure = measureCard(layer);
    void cardDecoded(layer).then(() => controller.prepared(pending.id, measure));
  }, [controller, view]);

  if (!view || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={shellRef}
      className="pointer-events-none fixed z-50 transition-none"
      style={{ width: HOVER_PREVIEW_WINDOW_WIDTH_PX, visibility: view.shown ? undefined : "hidden" }}
      data-hover-preview-window=""
      data-frame-moving={view.frameMoving ? "" : undefined}
      {...(view.shown ? { [attribute]: "" } : null)}
    >
      {view.frameMoving && <FrameUnder cut={cut} radius={view.radius} />}
      <div
        ref={clipRef}
        className={cn("relative h-full origin-top-left transition-none", view.frameMoving && "overflow-hidden")}
        style={view.frameMoving ? { borderRadius: view.radius } : undefined}
      >
        <div ref={innerRef} className="relative origin-top-left transition-none">
          {view.layers.map((layer) => (
            <div
              key={layer.id}
              className="absolute inset-x-0 top-0 transition-none"
              style={{ visibility: layer.role === "pending" ? "hidden" : undefined }}
              data-hover-preview-layer={layer.id}
              data-hover-preview-layer-role={layer.role}
            >
              <ReadOnlyCardPreview
                block={layer.card}
                vaultPath={vaultPath}
                thumbsRootPath={thumbsRootPath}
                thumbVersion={thumbVersions?.get(layer.card.slug)}
                width={HOVER_PREVIEW_WINDOW_WIDTH_PX}
              />
            </div>
          ))}
        </div>
      </div>
      {view.frameMoving && <FrameOver cut={cut} radius={view.radius} />}
    </div>,
    document.body,
  );
}
