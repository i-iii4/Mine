// Pure mapping from a search-result LightBlock to the overlay list row.
//
// The row names the result by its file name (user's decision of 05.10.2026),
// and the search `title` field is that same name end to end (SPEC_SEARCH.md),
// so a title match's ranges index the row's name.
//
// Encodes the Match Metadata rendering rules (SPEC_SEARCH.md) for the list
// surface:
// - title match    → highlight ranges on the file name, the text stays the
//   normal preview text without a mark;
// - description/body match → the text is the backend excerpt with mark ranges
//   (the note's H1 is body text and matches here);
// - semantic match → the text is the excerpt, no ranges, no fake highlight;
// - author/url match → ranking-only metadata: the text is the normal preview
//   text, the matched metadata never leaks into the rendered row;
// - media block without any text → no text, the row shows the name alone.
//
// The list shows the name and the text on one line (user's decision of
// 06.10.2026, SPEC_SEARCH_OVERLAY.md). A file name is often made from the
// note's own text, so the text's start that repeats the name is cut off and
// the line continues at the first word the name does not already say. The
// cut never touches the user's data, only what this row shows.

import type { LightBlock, SearchMatch } from "@/types";
import { getFileName } from "@/lib/displayTitle";

export interface SearchResultRow {
  /** File name: the row's name and the search `title` field. */
  title: string;
  /** The backend's title match, ranges over `title`. */
  titleMatch: SearchMatch | null;
  /** The note's text for this result, whole: the match excerpt or the
   *  preview text. The micro preview shows it as its text. */
  snippet: string | null;
  snippetMatch: SearchMatch | null;
  /** Highlight on the list row's name: the title match, or the ranges of a
   *  text match that fell inside the fragment the cut moved onto the name. */
  nameMatch: SearchMatch | null;
  /** What the list row shows after the name: `snippet` without the start
   *  that repeats the name. `null` shows the name alone. */
  text: string | null;
  /** `snippetMatch` over `text`: same match, ranges shifted by the cut. */
  textMatch: SearchMatch | null;
}

const SNIPPET_MATCH_FIELDS: ReadonlySet<SearchMatch["field"]> = new Set([
  "description",
  "body",
  "semantic",
]);

export function deriveSearchResultRow(block: LightBlock): SearchResultRow {
  const title = getFileName(block);
  const match = block.search_match ?? null;

  const titleMatch = match?.field === "title" ? match : null;

  const excerptMatch =
    match && SNIPPET_MATCH_FIELDS.has(match.field) && match.excerpt.trim().length > 0
      ? match
      : null;
  const fallbackPreview = block.preview_text?.trim() ?? "";
  const snippetText = excerptMatch ? excerptMatch.excerpt : fallbackPreview;
  const snippet = snippetText.length > 0 ? snippetText : null;

  const line = withoutRepeatedName(title, snippet, excerptMatch);

  return {
    title,
    titleMatch,
    snippet,
    snippetMatch: excerptMatch,
    nameMatch: titleMatch ?? line.nameMatch,
    text: line.text,
    textMatch: line.textMatch,
  };
}

interface Word {
  /** UTF-16 offsets into the source string. */
  start: number;
  end: number;
  /** Comparison key: NFC, lower case. */
  key: string;
}

/** A word is a run of letters, digits and combining marks. Everything else
 *  (spaces, punctuation, `/` that a file name turns into a space, the
 *  trailing period a file name drops, emoji) separates words and is not
 *  compared. */
const WORD_PATTERN = /[\p{L}\p{N}\p{M}]+/gu;
const HAS_LETTER = /\p{L}/u;
/** Content worth showing after the cut: letters, digits and symbols (emoji). */
const MEANINGFUL = /[\p{L}\p{N}\p{S}]/u;
/** Skipped between the repeated fragment and the first new word: spaces and
 *  punctuation that closes or separates. Opening brackets and quotes, `#` and
 *  `@` begin the next word and stay. */
const LEADING_SEPARATOR = /[\s\p{Pd}\p{Pe}\p{Pf}\p{Po}]/u;

function splitWords(text: string): Word[] {
  const words: Word[] = [];
  const pattern = new RegExp(WORD_PATTERN.source, WORD_PATTERN.flags);
  let found = pattern.exec(text);
  while (found !== null) {
    words.push({
      start: found.index,
      end: found.index + found[0].length,
      key: found[0].normalize("NFC").toLowerCase(),
    });
    found = pattern.exec(text);
  }
  return words;
}

/**
 * How the text's start repeats the name, word by word: the pairs of words
 * that say the same, and where the repeated fragment ends in the text.
 * `null` when the text does not begin with the name, or the name does not
 * begin with the whole text.
 */
function repeatedStart(
  name: string,
  text: string,
): { pairs: Array<[Word, Word]>; end: number } | null {
  const nameWords = splitWords(name);
  const textWords = splitWords(text);
  if (nameWords.length === 0 || textWords.length === 0) return null;

  const pairs: Array<[Word, Word]> = [];
  const count = Math.min(nameWords.length, textWords.length);
  for (let index = 0; index < count; index += 1) {
    const nameWord = nameWords[index]!;
    const textWord = textWords[index]!;
    if (nameWord.key === textWord.key) {
      pairs.push([nameWord, textWord]);
      continue;
    }
    // A name made from the note's text is cut at its length limit, often in
    // the middle of a word: `… for glor` repeats `… for glory`. Only the
    // name's last word may be cut, and only a word with a letter in a name of
    // two words or more, so a short name (`Cat`, `Report 2`) never swallows
    // the start of a longer word (`Category`, `2025`).
    const nameCutHere =
      index === nameWords.length - 1
      && nameWords.length >= 2
      && HAS_LETTER.test(nameWord.key)
      && textWord.key.startsWith(nameWord.key);
    // The same, the other way: a text shorter than the name, cut inside the
    // name's word.
    const textCutHere =
      index === textWords.length - 1
      && textWords.length >= 2
      && HAS_LETTER.test(textWord.key)
      && nameWord.key.startsWith(textWord.key);
    if (nameCutHere || textCutHere) {
      pairs.push([nameWord, textWord]);
      break;
    }
    return null;
  }

  const wholeName = pairs.length === nameWords.length;
  const wholeText = pairs.length === textWords.length;
  if (!wholeName && !wholeText) return null;
  return { pairs, end: pairs[pairs.length - 1]![1].end };
}

/** Code point index → UTF-16 offset, and back, for one string. */
function codePointOffsets(text: string): number[] {
  const offsets: number[] = [0];
  let offset = 0;
  for (const char of text) {
    offset += char.length;
    offsets.push(offset);
  }
  return offsets;
}

function codePointAt(offsets: number[], utf16: number): number {
  // Offsets ascend; word bounds always fall on a code point boundary.
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (offsets[middle]! < utf16) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Carries the ranges that fell inside the cut fragment onto the same words
 * of the name, so a match the cut removed from the text stays marked where
 * those words are still shown.
 */
function carryRangesToName(
  name: string,
  text: string,
  ranges: SearchMatch["ranges"],
  pairs: Array<[Word, Word]>,
): SearchMatch["ranges"] {
  const textOffsets = codePointOffsets(text);
  const nameOffsets = codePointOffsets(name);
  const carried: SearchMatch["ranges"] = [];
  for (const range of ranges) {
    const start = textOffsets[range.start];
    const end = textOffsets[range.end];
    if (start === undefined || end === undefined || end <= start) continue;
    let nameStart: number | null = null;
    let nameEnd: number | null = null;
    for (const [nameWord, textWord] of pairs) {
      const overlapStart = Math.max(start, textWord.start);
      const overlapEnd = Math.min(end, textWord.end);
      if (overlapEnd <= overlapStart) continue;
      const mappedStart = nameWord.start + (overlapStart - textWord.start);
      const mappedEnd = Math.min(nameWord.end, nameWord.start + (overlapEnd - textWord.start));
      if (mappedEnd <= mappedStart) continue;
      nameStart ??= mappedStart;
      nameEnd = mappedEnd;
    }
    if (nameStart === null || nameEnd === null) continue;
    carried.push({
      start: codePointAt(nameOffsets, nameStart),
      end: codePointAt(nameOffsets, nameEnd),
    });
  }
  return carried;
}

export interface MarkWindow {
  /** The name or the text as shown so its first mark is in view: the name's
   *  head, an ellipsis and the words up to the mark; the text from an
   *  ellipsis and the words just before the mark. */
  text: string;
  /** The marks over `text`. */
  ranges: SearchMatch["ranges"];
}

const NAME_ELLIPSIS = "…";
/** The share of the name's width its head may keep when the middle is skipped. */
const NAME_HEAD_SHARE = 0.4;

/**
 * A long name cut at the line's end can hide its first mark: a title match
 * deep in a name made from a post, or a match the cut carried onto the
 * name's last word. Then the name keeps its head, skips the middle with an
 * ellipsis and shows the words that lead up to the mark, the way Finder
 * shortens a long name. Whole words only, unless a word alone is wider than
 * the room. `null` when there is no mark or it is already in view.
 *
 * `measure` gives a string's width in the name's font, `width` the room the
 * name has on the line.
 */
export function windowNameAroundMark(
  name: string,
  ranges: SearchMatch["ranges"],
  width: number,
  measure: (text: string) => number,
): MarkWindow | null {
  const chars = Array.from(name);
  const mark = ranges
    .filter((range) => range.start >= 0 && range.end > range.start && range.end <= chars.length)
    .sort((a, b) => a.start - b.start)[0];
  if (!mark || width <= 0) return null;

  const slice = (from: number, to: number) => chars.slice(from, to).join("");
  const ellipsis = measure(NAME_ELLIPSIS);
  // The line truncates past the mark with its own ellipsis.
  const after = mark.end < chars.length ? ellipsis : 0;
  if (measure(name) <= width) return null;
  if (measure(slice(0, mark.end)) + after <= width) return null;

  const offsets = codePointOffsets(name);
  const words = splitWords(name).map((word) => ({
    start: codePointAt(offsets, word.start),
    end: codePointAt(offsets, word.end),
  }));
  const fits = (headEnd: number, tailStart: number) =>
    measure(slice(0, headEnd)) + ellipsis + measure(slice(tailStart, mark.end)) + after <= width;
  // The earliest word start after the head that still shows the mark.
  const tailFor = (headEnd: number): number | null => {
    for (const word of words) {
      if (word.start <= headEnd) continue;
      if (word.start > mark.start) break;
      if (fits(headEnd, word.start)) return word.start;
    }
    return fits(headEnd, mark.start) ? mark.start : null;
  };

  let headEnd = 0;
  for (const word of words) {
    if (word.end > mark.start || measure(slice(0, word.end)) > width * NAME_HEAD_SHARE) break;
    headEnd = word.end;
  }
  let tailStart = tailFor(headEnd);
  if (tailStart === null) {
    headEnd = 0;
    tailStart = tailFor(0);
  }
  // The mark alone is wider than the room: nothing to skip that would help.
  if (tailStart === null || tailStart <= headEnd) return null;

  // Every mark starts at or after the first one, so inside the tail.
  const shift = tailStart - headEnd - 1;
  return {
    text: `${slice(0, headEnd)}${NAME_ELLIPSIS}${slice(tailStart, chars.length)}`,
    ranges: ranges
      .filter((range) => range.start >= tailStart && range.end <= chars.length)
      .map((range) => ({ start: range.start - shift, end: range.end - shift })),
  };
}

/** The share of the text's room the words before the mark may take, so the
 *  mark is followed by some of what it says. */
const TEXT_LEAD_SHARE = 0.4;
/** Kept with the word they open when the text is cut before it. */
const WORD_OPENER = /[\p{Ps}\p{Pi}"'#@]/u;

/**
 * The text after the name is cut at the line's end, and the backend's excerpt
 * starts up to 90 characters before its match, so its first mark often falls
 * past the cut (user's report of 07.10.2026). Then the text starts at the
 * words just before the mark, after an ellipsis. When the rest of the text
 * from some word on fits the room whole, it starts at the earliest such word;
 * otherwise the words before the mark take at most `TEXT_LEAD_SHARE` of the
 * room, the mark and what follows it the rest, and the line's own ellipsis
 * cuts the end. Whole words, an opening bracket or quote kept with its word.
 * `null` when there is no mark, it is already in view, or the mark alone is
 * wider than the room.
 *
 * `measure` gives a string's width in the text's font, `width` the room the
 * text has on the line.
 */
export function windowTextAroundMark(
  text: string,
  ranges: SearchMatch["ranges"],
  width: number,
  measure: (text: string) => number,
): MarkWindow | null {
  const chars = Array.from(text);
  const mark = ranges
    .filter((range) => range.start >= 0 && range.end > range.start && range.end <= chars.length)
    .sort((a, b) => a.start - b.start)[0];
  if (!mark || width <= 0) return null;

  const slice = (from: number, to: number) => chars.slice(from, to).join("");
  const ellipsis = measure(NAME_ELLIPSIS);
  const after = mark.end < chars.length ? ellipsis : 0;
  if (measure(text) <= width) return null;
  if (measure(slice(0, mark.end)) + after <= width) return null;
  if (ellipsis + measure(slice(mark.start, mark.end)) + after > width) return null;

  const offsets = codePointOffsets(text);
  const starts = splitWords(text)
    .map((word) => {
      let start = codePointAt(offsets, word.start);
      while (start > 0 && WORD_OPENER.test(chars[start - 1]!)) start -= 1;
      return start;
    })
    .filter((start) => start > 0 && start < mark.start);
  // A short end leaves room: the earliest start from which the rest fits whole
  // fills the line with the words before the mark.
  const wholeRest = (start: number) => ellipsis + measure(slice(start, chars.length)) <= width;
  const fits = (start: number) =>
    ellipsis + measure(slice(start, mark.start)) <= width * TEXT_LEAD_SHARE
    && ellipsis + measure(slice(start, mark.end)) + after <= width;
  const start = starts.find(wholeRest) ?? starts.find(fits) ?? mark.start;

  const shift = start - 1;
  return {
    text: `${NAME_ELLIPSIS}${slice(start, chars.length)}`,
    ranges: ranges
      .filter((range) => range.start >= start && range.end <= chars.length)
      .map((range) => ({ start: range.start - shift, end: range.end - shift })),
  };
}

function withoutRepeatedName(
  name: string,
  snippet: string | null,
  match: SearchMatch | null,
): Pick<SearchResultRow, "nameMatch" | "text" | "textMatch"> {
  if (snippet === null) return { nameMatch: null, text: null, textMatch: null };

  const repeated = repeatedStart(name, snippet);
  if (repeated === null) return { nameMatch: null, text: snippet, textMatch: match };

  let cut = repeated.end;
  while (cut < snippet.length) {
    const char = String.fromCodePoint(snippet.codePointAt(cut)!);
    if (!LEADING_SEPARATOR.test(char) || char === "#" || char === "@") break;
    cut += char.length;
  }
  const rest = snippet.slice(cut);
  const text = MEANINGFUL.test(rest) ? rest : null;

  const ranges = match?.ranges ?? [];
  const shift = Array.from(snippet.slice(0, cut)).length;
  const carried = carryRangesToName(
    name,
    snippet,
    ranges.filter((range) => range.start < shift),
    repeated.pairs,
  );
  const nameMatch = match && carried.length > 0
    ? { ...match, excerpt: name, ranges: carried }
    : null;

  if (text === null) return { nameMatch, text: null, textMatch: null };

  const textMatch = match
    ? {
        ...match,
        excerpt: text,
        ranges: ranges
          .filter((range) => range.end > shift)
          .map((range) => ({
            start: Math.max(0, range.start - shift),
            end: range.end - shift,
          })),
      }
    : null;
  return { nameMatch, text, textMatch };
}
