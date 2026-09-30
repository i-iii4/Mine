/// <reference lib="webworker" />

// Font-metrics Web Worker.
// Receives batches of blocks (title + body text) and returns word widths
// computed via OffscreenCanvas measureText. The font is loaded once via
// FontFace API at init time using an ArrayBuffer shipped from main thread.
//
// See SPEC_GRID.md for the pipeline rationale.

import type {
  WorkerInMessage,
  WorkerOutMessage,
  WorkerBlockInput,
  WorkerBlockResult,
} from "../types/fontMetrics";
import { computeWordWidths } from "../lib/wordWidths";

declare const self: DedicatedWorkerGlobalScope;

const PROGRESS_CHUNK = 500;

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let fontReady = false;

function ensureContext(): OffscreenCanvasRenderingContext2D {
  if (!canvas) {
    canvas = new OffscreenCanvas(1, 1);
  }
  if (!ctx) {
    const got = canvas.getContext("2d");
    if (!got) throw new Error("OffscreenCanvas 2d context unavailable");
    ctx = got;
  }
  return ctx;
}

async function loadFont(family: string, buffer: ArrayBuffer): Promise<void> {
  // FontFaceSet is available on WorkerGlobalScope in modern browsers
  // (Chrome 77+, Safari 15.4+, Firefox 100+).
  const globalFonts = (self as unknown as { fonts?: FontFaceSet }).fonts;
  if (!globalFonts) {
    throw new Error("FontFaceSet not available in worker context");
  }
  const face = new FontFace(family, buffer);
  await face.load();
  globalFonts.add(face);
  fontReady = true;
}

function postResult(message: WorkerOutMessage): void {
  self.postMessage(message);
}

function postError(requestId: number, message: string): void {
  postResult({ type: "error", requestId, message });
}

async function handleInit(
  requestId: number,
  fontBuffer: ArrayBuffer,
  fontFamily: string,
): Promise<void> {
  try {
    ensureContext();
    await loadFont(fontFamily, fontBuffer);
    postResult({ type: "ready", requestId });
  } catch (err) {
    postError(requestId, err instanceof Error ? err.message : String(err));
  }
}

function handleCompute(
  requestId: number,
  blocks: WorkerBlockInput[],
  fontHash: string,
  titleFontSpec: string,
  previewFontSpec: string,
): void {
  try {
    const ctxLocal = ensureContext();
    if (!fontReady) {
      postError(requestId, "Font not yet loaded — send init first");
      return;
    }

    const results: WorkerBlockResult[] = new Array(blocks.length);
    for (let i = 0; i < blocks.length; i += 1) {
      results[i] = {
        id: blocks[i]!.id,
        widths: computeWordWidths(
          ctxLocal,
          blocks[i]!,
          titleFontSpec,
          previewFontSpec,
        ),
      };
      if ((i + 1) % PROGRESS_CHUNK === 0) {
        postResult({ type: "progress", requestId, done: i + 1, total: blocks.length });
      }
    }

    postResult({ type: "result", requestId, results, fontHash });
  } catch (err) {
    postError(requestId, err instanceof Error ? err.message : String(err));
  }
}

self.addEventListener("message", (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "init":
      void handleInit(msg.requestId, msg.fontBuffer, msg.fontFamily);
      break;
    case "compute":
      handleCompute(
        msg.requestId,
        msg.blocks,
        msg.fontHash,
        msg.titleFontSpec,
        msg.previewFontSpec,
      );
      break;
    default: {
      // Exhaustiveness check
      const _never: never = msg;
      void _never;
    }
  }
});
