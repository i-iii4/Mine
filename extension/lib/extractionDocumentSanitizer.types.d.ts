declare global {
  var MineExtractionDocumentSanitizer: {
    /**
     * Remove from `doc` the images that are page furniture (tracking pixels,
     * app icons, hidden images) before the article is extracted. Returns the
     * same document.
     */
    sanitizeExtractionDocument(doc: Document): Document;
    /** Whether `img` is page furniture rather than an image of the content. */
    shouldRemoveExtractionImage(img: HTMLImageElement | null | undefined): boolean;
  };
}

export {};
