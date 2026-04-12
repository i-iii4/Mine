// Pure word-wrap: given per-word widths and a target column width,
// compute how many rendered lines the text will occupy.
//
// The algorithm is a standard greedy line-breaking pass. For each word,
// check whether `currentLine + space + word` still fits `maxWidth`. If not,
// commit the current line, start a new one with this word. When a single
// word exceeds `maxWidth`, it still occupies its own line (the browser will
// break it mid-word via CSS `overflow-wrap: break-word`, but from a line-
// counting perspective it's still one line of our computation).
//
// This is a pure function with no DOM access — safe for use on main thread,
// in workers, and in unit tests without any mocking.

/**
 * Count the number of lines the given word sequence will occupy when
 * rendered into a column of `maxWidth` pixels.
 *
 * @param wordWidths Widths of individual words in pixels (from measureText).
 * @param spaceWidth Width of a single space character in pixels.
 * @param maxWidth   Target column width in pixels. Must be > 0.
 * @returns Non-negative integer line count. Empty input returns 0.
 */
export function countLines(
  wordWidths: readonly number[],
  spaceWidth: number,
  maxWidth: number,
): number {
  if (wordWidths.length === 0) return 0;
  if (maxWidth <= 0) return wordWidths.length;

  let lines = 1;
  let currentLineWidth = 0;

  for (let i = 0; i < wordWidths.length; i += 1) {
    const wordWidth = wordWidths[i]!;

    if (currentLineWidth === 0) {
      // First word of the line: always fits (even if it alone exceeds maxWidth,
      // counted as a single line — browser will handle mid-word break).
      currentLineWidth = wordWidth;
      continue;
    }

    const projected = currentLineWidth + spaceWidth + wordWidth;
    if (projected <= maxWidth) {
      currentLineWidth = projected;
    } else {
      lines += 1;
      currentLineWidth = wordWidth;
    }
  }

  return lines;
}
