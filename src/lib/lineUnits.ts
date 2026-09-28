// The units a line of card text can break between, for the font-metrics
// worker (SPEC_GRID.md). Pure: no DOM, testable on the main thread.

/** Characters the browser may break between even without spaces. */
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFFEF]/u;

/**
 * Characters that never begin a line (closing marks, small kana) or never end
 * one (opening marks): the browser keeps them with their neighbour, so they
 * are measured as part of it.
 */
const NO_LINE_START = /[、。，．・：；？！）」』】〕〉》ゝゞーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々〻〜…‥]/u;
const NO_LINE_END = /[（「『【〔〈《]/u;

export interface MeasuredWords {
  words: string[];
  /** Per word: it follows the previous word with no space between them. */
  noSpaceBefore: boolean[];
}

/**
 * Split text into the units a line can break between.
 *
 * Spaces separate words. Inside a space-free token, CJK characters are each a
 * unit of their own, since the browser breaks between any two of them; runs
 * of other characters (Latin words, digits) stay whole. Units inside a token
 * follow each other with no space. A paragraph of Japanese used to count as
 * one word as soon as the text held a single space or line break elsewhere,
 * so a three-line preview was sized as one line.
 */
export function splitWords(text: string): MeasuredWords {
  const words: string[] = [];
  const noSpaceBefore: boolean[] = [];
  const trimmed = text.trim();
  if (!trimmed) return { words, noSpaceBefore };

  for (const token of trimmed.split(/\s+/u)) {
    if (!token) continue;
    const units = CJK_CHAR.test(token) ? splitCjkToken(token) : [token];
    units.forEach((unit, index) => {
      words.push(unit);
      noSpaceBefore.push(index > 0);
    });
  }
  return { words, noSpaceBefore };
}

function splitCjkToken(token: string): string[] {
  const units: string[] = [];
  let run = "";
  let glueNext = false;
  const push = (unit: string) => {
    const last = units.length - 1;
    if (last >= 0 && (glueNext || NO_LINE_START.test(unit[0] ?? ""))) {
      units[last] += unit;
    } else {
      units.push(unit);
    }
    glueNext = NO_LINE_END.test(unit.slice(-1));
  };
  for (const char of token) {
    if (CJK_CHAR.test(char) || NO_LINE_START.test(char) || NO_LINE_END.test(char)) {
      if (run) push(run);
      run = "";
      push(char);
    } else {
      run += char;
    }
  }
  if (run) push(run);
  return units;
}
