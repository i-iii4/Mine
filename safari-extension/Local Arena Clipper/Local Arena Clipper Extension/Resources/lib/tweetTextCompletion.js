// Choosing between the two readings of a post's text.
//
// X collapses a long post behind "Show more" and leaves only the visible half
// in the markup, so text read from the page can stop mid-word. The syndication
// API answers with the whole post but drops the formatting the DOM carries —
// links become bare URLs, some line breaks vanish. Neither source wins
// outright, so the choice is made per post.

(function () {
  /// Comparison form: markdown links flattened to their text, whitespace
  /// collapsed. The two sources never agree character for character.
  function tweetTextPlain(text) {
    return String(text ?? "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  }

  /// The DOM reading wins whenever it is complete — it keeps the formatting.
  /// The API reading wins only when the DOM one is a truncated prefix of it,
  /// which is exactly the "Show more" case.
  function preferCompleteTweetText(domText, apiText) {
    const dom = String(domText ?? "").trim();
    const api = String(apiText ?? "").trim();
    if (!api) return dom;
    if (!dom) return api;

    const domPlain = tweetTextPlain(dom);
    const apiPlain = tweetTextPlain(api);
    if (apiPlain.length <= domPlain.length) return dom;

    // A prefix long enough to be the same post, short enough to survive the
    // small differences between the two renderings.
    const probe = domPlain.slice(0, Math.min(domPlain.length, 60));
    return probe.length > 0 && apiPlain.startsWith(probe) ? api : dom;
  }

  window.MineTweetTextCompletion = { preferCompleteTweetText, tweetTextPlain };
})();
