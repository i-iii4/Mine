// Globals the extension's scripts put on a page's window and read across
// scripts: content.js and the overlay (dist/overlay.js) share the window of
// the extension's isolated world. A script of an earlier build may have
// written them, so each one may be absent.
import type { ArticleData, CaptureDocument, PageMetadata, TwitterLightboxResult } from "./popup/lib/messaging";

/** A picture of the page, as `__mineClipper.getImageInfo` reads it. */
export interface PageImageInfo {
  src: string;
  alt: string | null;
  title: string | null;
  width: number | null;
  height: number | null;
  /** The post the picture belongs to, when one post's links surround it. */
  postUrl: string | null;
}

/** The extractors content.js offers the overlay in their shared world. */
export interface MineContentHelpers {
  extractMetadata(): PageMetadata;
  extractArticle(): ArticleData;
  extractArticleAsync(): Promise<ArticleData>;
  captureDocumentSnapshot(): Readonly<CaptureDocument>;
  getImageInfo(src: string): PageImageInfo;
  detectTwitterLightboxImage(): TwitterLightboxResult | null;
}

/** The overlay clipper of the page, which content.js hides for a crop and shows again. */
export interface MineOverlayApi {
  show(): void;
  hide(): void;
  close(): void;
  isHidden(): boolean;
}

/** The crop content.js runs for the overlay clipper. */
export interface MinePageCrop {
  /**
   * Start crop `cropId`. The first argument named the page of a Save link
   * clip until 12.10.2026 and is not read; an overlay of that build passes
   * no id.
   */
  start(unused: unknown, cropId?: string): void;
  /** Cancel crop `cropId` if it is the one under way; absent in a script that predates named crops. */
  cancel?(cropId: string): void;
}

declare global {
  interface Window {
    /**
     * Chrome's Navigation API, which lib.dom does not declare; content.js
     * listens to its `navigate` events. Absent in browsers without it.
     */
    readonly navigation?: EventTarget;
  }

  /** The token of the content script that owns the page in this world (SPEC_CLIPPER.md, К4). */
  var __mineContentScript: object | undefined;
  var __mineClipper: MineContentHelpers | undefined;
  var __mineOverlay: MineOverlayApi | undefined;
  var __mineCrop: MinePageCrop | undefined;
  /**
   * Puts back the `console.warn` background replaced while it injected
   * Defuddle, which warns about quirks mode as it loads.
   */
  var __mineRestoreDefuddleConsole: (() => void) | undefined;
}
