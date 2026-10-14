declare global {
  var MineTweetTextCompletion: {
    /**
     * The text of a post to save: the page's reading, which keeps the
     * formatting, unless it is a truncated prefix of the API's reading.
     */
    preferCompleteTweetText(domText: string | null | undefined, apiText: string | null | undefined): string;
    /** The comparison form: Markdown links flattened to their text, whitespace collapsed. */
    tweetTextPlain(text: string | null | undefined): string;
  };
}

export {};
