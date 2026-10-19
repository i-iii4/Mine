import { describe, expect, it } from "vitest";
import {
  decodeCell,
  editCellSource,
  encodeCellText,
  endsWithUnpairedBackslash,
  escapeLoosePipes,
  shownOffset,
  shownOffsetOfRendered,
  smallestReplacement,
  sourceOffset,
  unescapedPipes,
} from "./tableCell";

/** A small generator with a seed, so a failing case can be run again. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const PIECES = ["a", "б", "Ж", " ", "\\|", "\\\\", "\\", "<br>", "<br/>", "<BR />", "`x|y`".replace("|", "\\|"), "**b**", "[l](u)", "😀", "\t"];

/** A cell's source as a table may hold it: no pipe that would end it. */
function randomCellSource(next: () => number): string {
  let source = "";
  const length = Math.floor(next() * 8);
  for (let index = 0; index < length; index += 1) source += PIECES[Math.floor(next() * PIECES.length)] ?? "a";
  return escapeLoosePipes(source.trim());
}

describe("decodeCell", () => {
  it("shows <br> in every form as a line break and \\| as a pipe, the rest as written", () => {
    expect(decodeCell("a<br>b<br/>c<BR />d").text).toBe("a\nb\nc\nd");
    expect(decodeCell("a \\| b").text).toBe("a | b");
    expect(decodeCell("`x \\| y`").text).toBe("`x | y`");
    expect(decodeCell("C:\\\\path").text).toBe("C:\\\\path");
    expect(decodeCell("**жирный** [ссылка](https://e.com)").text).toBe("**жирный** [ссылка](https://e.com)");
  });

  it("maps every shown position to the source between pieces", () => {
    const view = decodeCell("a\\|b<br/>c");
    expect(view.text).toBe("a|b\nc");
    expect(view.sourceAt).toEqual([0, 1, 3, 4, 9, 10]);
    expect(sourceOffset(view, 2)).toBe(3);
    expect(shownOffset(view, 3)).toBe(2);
    // An offset inside `<br/>` falls before it.
    expect(shownOffset(view, 6)).toBe(3);
  });

  it("keeps every source: no edit gives the source back, for random cells", () => {
    const next = random(7);
    for (let round = 0; round < 500; round += 1) {
      const source = randomCellSource(next);
      expect(editCellSource(source, [])).toBe(source);
      const view = decodeCell(source);
      expect(view.sourceAt).toHaveLength(view.text.length + 1);
      expect(view.sourceAt[view.text.length]).toBe(source.length);
    }
  });
});

describe("encode(decode(s)) = s", () => {
  it("re-encoding any shown range with its own text gives the same source, unless it spans a <br> written otherwise", () => {
    const next = random(11);
    for (let round = 0; round < 400; round += 1) {
      const source = randomCellSource(next).replace(/<br\s*\/?>/gi, "<br>");
      const view = decodeCell(source);
      const from = Math.floor(next() * (view.text.length + 1));
      const to = from + Math.floor(next() * (view.text.length - from + 1));
      expect(editCellSource(source, [{ from, to, insert: view.text.slice(from, to) }])).toBe(source);
    }
  });

  it("an insertion between pieces and its removal give the source back", () => {
    const next = random(23);
    for (let round = 0; round < 400; round += 1) {
      const source = randomCellSource(next);
      const view = decodeCell(source);
      const at = Math.floor(next() * (view.text.length + 1));
      // Between the two signs of a `\\` pair text would change what the
      // backslashes pair with: that is no boundary of pieces.
      if (view.text[at - 1] === "\\" && view.text[at] === "\\") continue;
      const inserted = editCellSource(source, [{ from: at, to: at, insert: "xy" }]);
      const back = decodeCell(inserted);
      const start = back.text.indexOf("xy", Math.max(0, at - 1));
      expect(start).toBeGreaterThanOrEqual(0);
      expect(editCellSource(inserted, [{ from: start, to: start + 2, insert: "" }])).toBe(source);
    }
  });
});

describe("editCellSource", () => {
  it("encodes only what is typed: a pipe as \\|, a line break as <br>", () => {
    expect(editCellSource("ab", [{ from: 1, to: 1, insert: "|" }])).toBe("a\\|b");
    expect(editCellSource("ab", [{ from: 1, to: 1, insert: "\n" }])).toBe("a<br>b");
    expect(editCellSource("a<br/>b", [{ from: 3, to: 3, insert: "!" }])).toBe("a<br/>b!");
  });

  it("turns pasted lines into <br>, never into rows", () => {
    expect(editCellSource("", [{ from: 0, to: 0, insert: "one\r\ntwo\rthree\nfour" }])).toBe("one<br>two<br>three<br>four");
  });

  it("changes the source of the edited range only, with Cyrillic, links and <br>", () => {
    const source = "[ссылка](https://e.com)<br/>текст \\| конец";
    const view = decodeCell(source);
    const at = view.text.indexOf("текст");
    const edited = editCellSource(source, [{ from: at, to: at + 5, insert: "слово" }]);
    expect(edited).toBe("[ссылка](https://e.com)<br/>слово \\| конец");
  });

  it("a pipe after an unpaired backslash completes its escape", () => {
    expect(encodeCellText("|", "a\\")).toBe("|");
    expect(editCellSource("a\\", [{ from: 2, to: 2, insert: "|" }])).toBe("a\\|");
    expect(encodeCellText("|", "a\\\\")).toBe("\\|");
  });

  it("never leaves a pipe that would end the cell", () => {
    // A backslash typed before `\|` would pair with it and free the pipe.
    const edited = editCellSource("a\\|b", [{ from: 1, to: 1, insert: "\\" }]);
    expect(unescapedPipes(edited)).toEqual([]);
    // Taking away the first of `\\\|` would leave `\\|`.
    const shortened = editCellSource("\\\\\\|", [{ from: 0, to: 1, insert: "" }]);
    expect(unescapedPipes(shortened)).toEqual([]);
    const next = random(5);
    for (let round = 0; round < 500; round += 1) {
      const source = randomCellSource(next);
      const view = decodeCell(source);
      const from = Math.floor(next() * (view.text.length + 1));
      const to = from + Math.floor(next() * (view.text.length - from + 1));
      const insert = ["", "|", "\\", "\\|", "a\nb", "<br>", "\\\\"][Math.floor(next() * 7)] ?? "";
      expect(unescapedPipes(editCellSource(source, [{ from, to, insert }]))).toEqual([]);
    }
  });

  it("takes edits in the order a transaction gives them", () => {
    expect(editCellSource("abcd", [{ from: 0, to: 1, insert: "X" }, { from: 3, to: 4, insert: "Y" }])).toBe("XbcY");
  });
});

describe("helpers", () => {
  it("knows an unpaired backslash", () => {
    expect(endsWithUnpairedBackslash("a\\")).toBe(true);
    expect(endsWithUnpairedBackslash("a\\\\")).toBe(false);
    expect(endsWithUnpairedBackslash("a\\\\\\")).toBe(true);
    expect(endsWithUnpairedBackslash("")).toBe(false);
  });

  it("finds the pipes that end a cell as micromark does", () => {
    expect(unescapedPipes("a|b\\|c\\\\|d")).toEqual([1, 8]);
  });

  it("gives the smallest single replacement", () => {
    expect(smallestReplacement("abc", "abc")).toBeNull();
    expect(smallestReplacement("abc", "abXc")).toEqual({ from: 2, to: 2, insert: "X" });
    expect(smallestReplacement("aaa", "aa")).toEqual({ from: 2, to: 3, insert: "" });
  });

  it("places the caret of a click by the drawn text", () => {
    const shown = "**жирный** и [ссылка](https://e.com) конец";
    // After «жир» in the drawn «жирный и ссылка конец».
    expect(shown.slice(0, shownOffsetOfRendered("жирный и ссылка конец", shown, 3))).toBe("**жир");
    // After «ссы».
    const drawn = "жирный и ссылка конец";
    expect(shown.slice(0, shownOffsetOfRendered(drawn, shown, drawn.indexOf("ссылка") + 3))).toBe("**жирный** и [ссы");
    // After «кон».
    expect(shown.slice(0, shownOffsetOfRendered(drawn, shown, drawn.indexOf("конец") + 3))).toBe("**жирный** и [ссылка](https://e.com) кон");
    // A sign the source does not have is passed over.
    expect(shownOffsetOfRendered("x²", "$x^2$", 2)).toBe(2);
  });
});
