import { describe, expect, it } from "vitest";
import { splitWords } from "./lineUnits";
import { countLines } from "./wordWrap";

describe("line units", () => {
  it("breaks after a hyphen inside a word, keeping the hyphen with what precedes it", () => {
    expect(splitWords("well-known -flag a--b end-")).toEqual({
      words: ["well-", "known", "-flag", "a--b", "end-"],
      noSpaceBefore: [false, true, false, false, false],
    });
  });

  it("counts the line a hyphenated link takes beyond the column (the card that cut its author)", () => {
    // `// https://behance.net/gallery/248293523/D130-2…`: the browser puts
    // `//` on one line, the link up to its hyphen on the next, overflowing,
    // and `2…` on a third.
    const { words, noSpaceBefore } = splitWords("// https://behance.net/gallery/248293523/D130-2…");
    expect(words).toEqual(["//", "https://behance.net/gallery/248293523/D130-", "2…"]);
    const widths = words.map((word) => word.length * 7);
    expect(countLines(widths, 4, 226, noSpaceBefore)).toBe(3);
  });

  it("keeps space-separated words whole", () => {
    expect(splitWords("  suitable dashboard\nfor it  ")).toEqual({
      words: ["suitable", "dashboard", "for", "it"],
      noSpaceBefore: [false, false, false, false],
    });
  });

  it("splits CJK text per character, with no space between characters", () => {
    expect(splitWords("雪山を歩く")).toEqual({
      words: ["雪", "山", "を", "歩", "く"],
      noSpaceBefore: [false, true, true, true, true],
    });
  });

  it("keeps digits and Latin runs inside CJK text whole", () => {
    expect(splitWords("本日も18時まで").words).toEqual(["本", "日", "も", "18", "時", "ま", "で"]);
  });

  it("keeps closing marks and small kana with the character before, opening marks with the one after", () => {
    expect(splitWords("撮った。「山」").words).toEqual(["撮っ", "た。", "「山」"]);
  });

  it("measures a Japanese paragraph as the lines it takes, even when the text has a line break elsewhere", () => {
    // The card that lost its author line: a space-free paragraph, then a
    // second paragraph. The paragraph alone used to count as one line.
    const body =
      "公募に応募した写真作品。裏には名前もあります。雪山を連なって歩く姿が良いリズム。元々色彩薄めの写真だったと思いますが、更に日焼けでほぼモノクロに。\n\n本日も18時まで。";
    const { words, noSpaceBefore } = splitWords(body);
    const widths = words.map((word) => [...word].length * 14);
    // 240px holds 17 characters of 14px: the 73-character paragraph needs 5
    // lines, and the short second one fits on the last of them.
    expect(countLines(widths, 4, 240, noSpaceBefore)).toBe(5);
  });
});
