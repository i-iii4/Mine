declare global {
  var MinePageTitle: {
    /**
     * Whether `value` can name a card: a letter, a digit or another visible
     * sign. Punctuation, dashes and separators alone are a placeholder.
     */
    hasNameText(value: unknown): boolean;
    /** `title` without one of the site's names joined to its end or start by a separator. */
    withoutSiteName(title: string, siteNames: ReadonlyArray<string | null | undefined>): string;
    /**
     * The page's name: the first declared title with name text, else the
     * document title (without the site's name when a declared title was a
     * placeholder), else empty.
     */
    choosePageTitle(
      declared: ReadonlyArray<string | null | undefined>,
      documentTitle: string | null | undefined,
      siteNames: ReadonlyArray<string | null | undefined>,
    ): string;
  };
}

export {};
