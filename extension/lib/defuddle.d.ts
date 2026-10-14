// The part of the vendored Defuddle bundle (lib/defuddle.js, a UMD build of
// https://github.com/kepano/defuddle) that content.js calls. The bundle
// defines the global `Defuddle` only after background injects it into the
// page, so the global may be absent.

export interface DefuddleOptions {
  /** Put the Markdown of the content in `contentMarkdown`, keeping `content` HTML. */
  separateMarkdown?: boolean;
}

/** The fields of Defuddle's answer that content.js reads. */
export interface DefuddleResponse {
  title?: string;
  /** The extracted content, HTML. */
  content?: string;
  /** The content as Markdown, with `separateMarkdown`. */
  contentMarkdown?: string;
  author?: string;
  description?: string;
  /** Extractor-specific values; a YouTube page puts its transcript here. */
  variables?: { [name: string]: string | undefined };
}

export interface DefuddleInstance {
  parse(): DefuddleResponse;
  /** The same, with the extractors that fetch (a YouTube transcript). */
  parseAsync(): Promise<DefuddleResponse>;
}

export interface DefuddleConstructor {
  new (doc: Document, options?: DefuddleOptions): DefuddleInstance;
  /** Defuddle's HTML to Markdown conversion, links resolved against `url`. */
  createMarkdownContent(html: string, url: string): string;
}

declare global {
  var Defuddle: DefuddleConstructor | undefined;
}
