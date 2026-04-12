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
 */
export interface WordWidths {
  /** Pixel widths of each word in the block's title */
  title: number[];
  /** Pixel widths of each word in the preview (first 400 chars of body) */
  preview: number[];
  /** Pixel width of a single space character — used by word-wrap */
  space: number;
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
      fontSpec: string; // e.g., "14px 'Geist', system-ui, sans-serif"
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
