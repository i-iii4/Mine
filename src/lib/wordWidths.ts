// Word widths of one card's title and preview, measured on any 2D canvas.
//
// The font-metrics worker measures on an OffscreenCanvas; when the worker
// cannot start or stops answering, the page measures on its own canvas with
// the same code, so a card's height never depends on which one measured it.
//
// See SPEC_GRID.md for the pipeline rationale.

import type { WorkerBlockInput, WordWidths } from "../types/fontMetrics";
import { FONT_METRICS_PREVIEW_MAX_CHARS } from "../types/fontMetrics";
import { splitWords } from "./lineUnits";

/** The part of a 2D canvas context measurement needs. */
export interface TextMeasurer {
  font: string;
  measureText(text: string): { width: number };
}

function measureWords(measurer: TextMeasurer, words: string[]): number[] {
  const widths = new Array<number>(words.length);
  for (let i = 0; i < words.length; i += 1) {
    widths[i] = measurer.measureText(words[i]!).width;
  }
  return widths;
}

export function computeWordWidths(
  measurer: TextMeasurer,
  block: WorkerBlockInput,
  titleFontSpec: string,
  previewFontSpec: string,
): WordWidths {
  const title = splitWords(block.title);
  const previewText = block.body.length > FONT_METRICS_PREVIEW_MAX_CHARS
    ? block.body.slice(0, FONT_METRICS_PREVIEW_MAX_CHARS)
    : block.body;
  const preview = splitWords(previewText);

  // Title measurement pass (title font spec)
  measurer.font = titleFontSpec;
  const titleWidths = measureWords(measurer, title.words);
  const titleSpace = measurer.measureText(" ").width;

  // Preview measurement pass (preview font spec)
  measurer.font = previewFontSpec;
  const previewWidths = measureWords(measurer, preview.words);
  const previewSpace = measurer.measureText(" ").width;

  return {
    title: titleWidths,
    preview: previewWidths,
    titleSpace,
    previewSpace,
    titleNoSpaceBefore: title.noSpaceBefore,
    previewNoSpaceBefore: preview.noSpaceBefore,
  };
}
