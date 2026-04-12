// Types for the font-metrics precomputation pipeline.
// See SPEC_GRID.md for the full design rationale.

/**
 * Font identity — a string that changes whenever anything affecting
 * measureText output changes (font file, font size, line height).
 * When the hash changes, all cached word widths are considered stale.
 */
export type FontHash = string;

/**
 * Per-block word widths, in pixels, computed via Canvas measureText.
 * These are pure font metrics — they don't depend on columnWidth.
 * Word-wrap at any columnWidth is a pure function of these widths.
 *
 * Title and preview are measured with different font weights (title is
 * semibold, preview is regular in our card template), so each has its own
 * space width to support word-wrap correctly.
 */
export interface WordWidths {
  /** Pixel widths of each word in the block's title (measured with title font) */
  title: number[];
  /** Pixel widths of each word in the preview (measured with preview font) */
  preview: number[];
  /** Pixel width of a space character in the title font */
  titleSpace: number;
  /** Pixel width of a space character in the preview font */
  previewSpace: number;
}

/**
 * IndexedDB record: word widths for one block at a specific font hash.
 * Stored keyed by blockId; fontHash is checked on read to detect stale entries.
 */
export interface CachedWordWidths {
  blockId: number;
  fontHash: FontHash;
  widths: WordWidths;
}

/** Input data the worker needs for each block — only text fields. */
export interface WorkerBlockInput {
  id: number;
  title: string;
  body: string;
}

/** Output the worker produces per block. */
export interface WorkerBlockResult {
  id: number;
  widths: WordWidths;
}

// ─── Worker message protocol ────────────────────────────────────────────────

/** Main → worker */
export type WorkerInMessage =
  | {
      /** Register the Geist font in the worker's FontFaceSet. Sent once on startup. */
      type: "init";
      requestId: number;
      fontBuffer: ArrayBuffer;
      fontFamily: string;
    }
  | {
      /** Compute word widths for a batch of blocks. */
      type: "compute";
      requestId: number;
      blocks: WorkerBlockInput[];
      fontHash: FontHash;
      /** Font spec used to measure titles (e.g., "600 12px 'Geist', ..."). */
      titleFontSpec: string;
      /** Font spec used to measure preview (e.g., "400 12px 'Geist', ..."). */
      previewFontSpec: string;
    };

/** Worker → main */
export type WorkerOutMessage =
  | {
      /** Acknowledgement of init. Worker is ready to accept compute messages. */
      type: "ready";
      requestId: number;
    }
  | {
      /** Progress during a compute batch. Sent every 500 blocks. */
      type: "progress";
      requestId: number;
      done: number;
      total: number;
    }
  | {
      /** Final batch result. All blocks measured. */
      type: "result";
      requestId: number;
      results: WorkerBlockResult[];
      fontHash: FontHash;
    }
  | {
      /** Worker encountered an error. The correlated request rejects. */
      type: "error";
      requestId: number;
      message: string;
    };
