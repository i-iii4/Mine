import { describe, expect, it } from "vitest";
import type { LightBlock, SearchMatch } from "@/types";
import { deriveSearchResultRow, windowNameAroundMark, windowTextAroundMark } from "./searchResultRow";

function makeBlock(overrides: Partial<LightBlock> = {}): LightBlock {
  return {
    id: 1,
    slug: "test-block",
    card_kind: "article",
    block_type: "article",
    title: "Card title",
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    width: null,
    height: null,
    author: null,
    body: "Body text",
    preview_text: "Normal preview text",
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    collections: [],
    feed_playback: null,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<SearchMatch> = {}): SearchMatch {
  return {
    field: "body",
    kind: "exact",
    excerpt: "…around the first match…",
    ranges: [{ start: 12, end: 17 }],
    score: 100,
    ...overrides,
  };
}

describe("deriveSearchResultRow", () => {
  it("names the result by its file name, never the visible title (05.10.2026)", () => {
    const block = makeBlock({
      slug: "Cards/Шуховская башня",
      title: "Legacy title",
      content_heading: "Radio tower",
      display_title: "Radio tower",
      fallback_label: "Шуховская башня",
    });
    expect(deriveSearchResultRow(block).title).toBe("Шуховская башня");
    expect(deriveSearchResultRow(makeBlock({ slug: "Flat card" })).title).toBe("Flat card");
  });

  it("title match highlights the file name and keeps the plain preview snippet", () => {
    const block = makeBlock({
      slug: "Cards/Card name",
      content_heading: "Visible heading",
      search_match: makeMatch({ field: "title", excerpt: "Card name", ranges: [{ start: 0, end: 4 }] }),
    });
    const row = deriveSearchResultRow(block);
    expect(row.title).toBe("Card name");
    expect(row.titleMatch?.excerpt).toBe(row.title);
    expect(row.titleMatch?.ranges).toEqual([{ start: 0, end: 4 }]);
    expect(row.snippet).toBe("Normal preview text");
    expect(row.snippetMatch).toBeNull();
  });

  it("body match renders the backend excerpt with mark ranges", () => {
    const match = makeMatch({ field: "body" });
    const row = deriveSearchResultRow(makeBlock({ search_match: match }));
    expect(row.titleMatch).toBeNull();
    expect(row.snippet).toBe(match.excerpt);
    expect(row.snippetMatch).toBe(match);
  });

  it("description match renders the backend excerpt with mark ranges", () => {
    const match = makeMatch({ field: "description" });
    const row = deriveSearchResultRow(makeBlock({ search_match: match }));
    expect(row.snippet).toBe(match.excerpt);
    expect(row.snippetMatch).toBe(match);
  });

  it("semantic match renders the excerpt without highlight ranges", () => {
    const match = makeMatch({ field: "semantic", kind: "semantic", ranges: [] });
    const row = deriveSearchResultRow(makeBlock({ search_match: match }));
    expect(row.snippet).toBe(match.excerpt);
    expect(row.snippetMatch?.ranges).toEqual([]);
  });

  it("author match keeps the normal preview and never leaks matched metadata", () => {
    const match = makeMatch({ field: "author", excerpt: "@matched-author", ranges: [] });
    const row = deriveSearchResultRow(makeBlock({ search_match: match }));
    expect(row.snippet).toBe("Normal preview text");
    expect(row.snippet).not.toContain("@matched-author");
    expect(row.snippetMatch).toBeNull();
  });

  it("url match keeps the normal preview without highlight", () => {
    const match = makeMatch({ field: "url", excerpt: "https://example.com/x", ranges: [] });
    const row = deriveSearchResultRow(makeBlock({ search_match: match }));
    expect(row.snippet).toBe("Normal preview text");
    expect(row.snippetMatch).toBeNull();
  });

  it("media block without any text yields a single-line row without snippet", () => {
    const block = makeBlock({
      card_kind: "media",
      block_type: "image",
      title: null,
      body: "",
      preview_text: null,
      media_file: "photo.jpg",
      search_match: makeMatch({ field: "title", excerpt: "photo", ranges: [] }),
    });
    const row = deriveSearchResultRow(block);
    expect(row.title.length).toBeGreaterThan(0);
    expect(row.snippet).toBeNull();
  });

  it("an H1 match in the body names the result by file name and shows the heading in the snippet", () => {
    const match = makeMatch({ field: "body", excerpt: "Шуховская башня Гиперболоидная конструкция", ranges: [{ start: 0, end: 9 }] });
    const row = deriveSearchResultRow(makeBlock({
      slug: "Cards/tower-notes",
      content_heading: "Шуховская башня",
      search_match: match,
    }));
    expect(row.title).toBe("tower-notes");
    expect(row.titleMatch).toBeNull();
    expect(row.snippet).toBe(match.excerpt);
    expect(row.snippetMatch).toBe(match);
  });

  it("block without search_match renders plain title and preview", () => {
    const row = deriveSearchResultRow(makeBlock());
    expect(row.titleMatch).toBeNull();
    expect(row.snippet).toBe("Normal preview text");
    expect(row.snippetMatch).toBeNull();
    expect(row.text).toBe("Normal preview text");
    expect(row.textMatch).toBeNull();
    expect(row.nameMatch).toBeNull();
  });
});

// One-line row (user's decision of 06.10.2026): the name, then the text that
// does not repeat it. The cut changes only what the row shows.
describe("deriveSearchResultRow: the line after the name", () => {
  function lineOf(slug: string, previewText: string | null, match?: SearchMatch) {
    return deriveSearchResultRow(makeBlock({
      slug: `Cards/${slug}`,
      preview_text: previewText,
      ...(match ? { search_match: match } : {}),
    }));
  }

  it("shows the name alone when the text says exactly what the name says", () => {
    const row = lineOf("Шуховская башня", "Шуховская башня");
    expect(row.title).toBe("Шуховская башня");
    expect(row.text).toBeNull();
    expect(row.textMatch).toBeNull();
    // The micro preview still gets the whole text.
    expect(row.snippet).toBe("Шуховская башня");
  });

  it("starts the text at the first word the name does not say", () => {
    expect(lineOf("Шуховская башня", "Шуховская башня гиперболоидная конструкция").text)
      .toBe("гиперболоидная конструкция");
  });

  it("continues after the whole word when the name was cut in the middle of it", () => {
    const name = "Long ago the sea kings sailed the northern ways for a wager. A wager for glor";
    const text = "Long ago the sea kings sailed the northern ways for a wager. A wager for glory or fall; there's no going back";
    expect(lineOf(name, text).text).toBe("or fall; there's no going back");
    expect(lineOf("… A wager for glor", "… A wager for glory or fall; there's no…").text)
      .toBe("or fall; there's no…");
  });

  it("does not treat a short name as a cut word of a longer one", () => {
    expect(lineOf("Cat", "Category theory basics").text).toBe("Category theory basics");
    expect(lineOf("Report 2", "Report 2025 summary").text).toBe("Report 2025 summary");
  });

  it("reads a slash the file name turned into a space, and a dash, as the same gap", () => {
    expect(lineOf("good-night", "/good-night").text).toBeNull();
    expect(lineOf("good night moon", "good/night: moon rises").text).toBe("rises");
    expect(lineOf("good-night", "/good-night and sleep well").text).toBe("and sleep well");
  });

  it("compares without case", () => {
    expect(lineOf("THE QUIET ROOM", "The quiet room was empty").text).toBe("was empty");
  });

  it("ignores the trailing period a file name drops", () => {
    expect(lineOf("Hello world", "Hello world.").text).toBeNull();
    expect(lineOf("Hello world", "Hello world. Next sentence").text).toBe("Next sentence");
  });

  it("shows the name alone when the text is only the start of the name", () => {
    expect(lineOf("A wager for glory or fall", "A wager for glory…").text).toBeNull();
    expect(lineOf("A wager for glory or fall", "A wager for gl").text).toBeNull();
  });

  it("keeps opening brackets, quotes, hashtags and mentions with the next word", () => {
    expect(lineOf("Design notes", "Design notes (draft) for review").text).toBe("(draft) for review");
    expect(lineOf("Design notes", "Design notes «черновик»").text).toBe("«черновик»");
    expect(lineOf("Design notes", "Design notes #design @team").text).toBe("#design @team");
  });

  it("keeps the text whole when it does not begin with the name", () => {
    expect(lineOf("1.0 (5)", "105 ways to sleep").text).toBe("105 ways to sleep");
    expect(lineOf("Notes on design systems", "Notes on typography").text).toBe("Notes on typography");
    expect(lineOf("CleanShot 2026 10 03 at 15.43.17@2x", "Screenshot of a settings window").text)
      .toBe("Screenshot of a settings window");
  });

  it("shows the name alone when there is no text", () => {
    expect(lineOf("1.0 (5)", null).text).toBeNull();
    expect(lineOf("1.0 (5)", "   ").text).toBeNull();
  });

  it("keeps a 300-character name whole and still finds the text after it", () => {
    const name = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ").slice(0, 300).trim();
    expect(name.length).toBeGreaterThanOrEqual(299);
    const row = lineOf(name, `${name} and then the rest`);
    expect(row.title).toBe(name);
    expect(row.text).toBe("and then the rest");
    expect(lineOf(name, "Something else entirely").text).toBe("Something else entirely");
  });

  it("shifts the excerpt's ranges by the cut", () => {
    // `сетка` is code points 31 to 36; the cut removes the first 16.
    const excerpt = "Шуховская башня гиперболоидная сетка";
    const match = makeMatch({ excerpt, ranges: [{ start: 31, end: 36 }] });
    const row = lineOf("Шуховская башня", null, match);
    expect(row.text).toBe("гиперболоидная сетка");
    expect(row.textMatch?.excerpt).toBe("гиперболоидная сетка");
    expect(row.textMatch?.ranges).toEqual([{ start: 15, end: 20 }]);
    expect(row.nameMatch).toBeNull();
    // The untouched snippet still carries the backend's ranges for the preview.
    expect(row.snippetMatch?.ranges).toEqual([{ start: 31, end: 36 }]);
  });

  it("counts ranges in code points across emoji before the cut", () => {
    // `bright` is code points 18 to 24: the emoji is one code point.
    const match = makeMatch({ excerpt: "🔥 Fire notes burn bright", ranges: [{ start: 18, end: 24 }] });
    const row = lineOf("Fire notes", null, match);
    expect(row.text).toBe("burn bright");
    expect(row.textMatch?.ranges).toEqual([{ start: 5, end: 11 }]);
  });

  it("carries a range inside the cut fragment onto the same words of the name", () => {
    const match = makeMatch({
      excerpt: "Шуховская башня гиперболоидная сетка",
      ranges: [{ start: 10, end: 15 }],
    });
    const row = lineOf("Шуховская башня", null, match);
    expect(row.text).toBe("гиперболоидная сетка");
    expect(row.textMatch?.ranges).toEqual([]);
    expect(row.nameMatch?.excerpt).toBe("Шуховская башня");
    expect(row.nameMatch?.ranges).toEqual([{ start: 10, end: 15 }]);
  });

  it("splits a range across the cut between the name and the text", () => {
    const match = makeMatch({ excerpt: "Fire notes burn bright", ranges: [{ start: 5, end: 15 }] });
    const row = lineOf("Fire notes", null, match);
    expect(row.text).toBe("burn bright");
    expect(row.nameMatch?.ranges).toEqual([{ start: 5, end: 10 }]);
    expect(row.textMatch?.ranges).toEqual([{ start: 0, end: 4 }]);
  });

  it("keeps an excerpt intact when its start does not repeat the name", () => {
    const match = makeMatch({ excerpt: "...around the first match...", ranges: [{ start: 20, end: 25 }] });
    const row = lineOf("Шуховская башня", null, match);
    expect(row.text).toBe(match.excerpt);
    expect(row.textMatch).toBe(match);
  });

  it("starts the note's text after the name for a match in the name only", () => {
    const match = makeMatch({ field: "title", excerpt: "Шуховская башня", ranges: [{ start: 10, end: 15 }] });
    const row = lineOf("Шуховская башня", "Шуховская башня стоит на Шаболовке", match);
    expect(row.nameMatch).toBe(match);
    expect(row.text).toBe("стоит на Шаболовке");
    expect(row.textMatch).toBeNull();
  });
});

// A truncated name never hides its first mark (06.10.2026).
describe("windowNameAroundMark", () => {
  // Monospace stand-in: one unit per code point.
  const measure = (text: string) => Array.from(text).length;
  const post = "Every sea king knows the tide does not wait, and neither does the wind that carries a wager for glor";
  const marked = (window: { text: string; ranges: SearchMatch["ranges"] }) =>
    window.ranges.map((range) => Array.from(window.text).slice(range.start, range.end).join(""));

  it("leaves the name alone when the mark is already in view", () => {
    expect(windowNameAroundMark("Шуховская башня", [{ start: 10, end: 15 }], 40, measure)).toBeNull();
    // Long name, early mark: the line's own ellipsis comes after it.
    expect(windowNameAroundMark(post, [{ start: 4, end: 7 }], 40, measure)).toBeNull();
    expect(windowNameAroundMark(post, [], 40, measure)).toBeNull();
  });

  it("keeps the head and skips to the words before a mark at the name's end", () => {
    const start = post.indexOf("glor");
    const window = windowNameAroundMark(post, [{ start, end: start + 4 }], 60, measure)!;
    expect(window.text.startsWith("Every sea king")).toBe(true);
    expect(window.text.endsWith("a wager for glor")).toBe(true);
    expect(window.text).toContain("…");
    expect(marked(window)).toEqual(["glor"]);
    expect(measure(window.text)).toBeLessThanOrEqual(60);
  });

  it("cuts at whole words on both sides of the ellipsis", () => {
    const start = post.indexOf("glor");
    const window = windowNameAroundMark(post, [{ start, end: start + 4 }], 60, measure)!;
    const [head, tail] = window.text.split("…");
    expect(post.startsWith(head!)).toBe(true);
    expect(post.endsWith(tail!)).toBe(true);
    // The head ends at a word's end, the tail begins at a word's start.
    expect(post.charAt(head!.length)).toMatch(/[\s,]/);
    expect(post.charAt(post.length - tail!.length - 1)).toMatch(/\s/);
  });

  it("shows a mark in the middle and leaves the rest to the line's ellipsis", () => {
    const start = post.indexOf("wind");
    const window = windowNameAroundMark(post, [{ start, end: start + 4 }], 40, measure)!;
    expect(marked(window)).toEqual(["wind"]);
    // Head, ellipsis and the words up to the mark fit with room for the end ellipsis.
    const upToMark = Array.from(window.text).slice(0, window.ranges[0]!.end).join("");
    expect(measure(upToMark) + 1).toBeLessThanOrEqual(40);
  });

  it("keeps every later mark, shifted into the window", () => {
    const wind = post.indexOf("wind");
    const glor = post.indexOf("glor");
    const window = windowNameAroundMark(post, [{ start: glor, end: glor + 4 }, { start: wind, end: wind + 4 }], 60, measure)!;
    expect(marked(window)).toEqual(["glor", "wind"]);
  });

  it("drops the head when the head and the mark do not fit together", () => {
    const name = `${"long ".repeat(10)}supercalifragilistic`;
    const start = name.indexOf("supercalifragilistic");
    const window = windowNameAroundMark(name, [{ start, end: name.length }], 22, measure)!;
    expect(window.text).toBe("…supercalifragilistic");
    expect(marked(window)).toEqual(["supercalifragilistic"]);
  });

  it("gives up when the mark alone is wider than the room", () => {
    const name = `${"long ".repeat(10)}supercalifragilistic`;
    const start = name.indexOf("supercalifragilistic");
    expect(windowNameAroundMark(name, [{ start, end: name.length }], 10, measure)).toBeNull();
  });

  it("holds for a 300-character name", () => {
    const name = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ").slice(0, 300).trim();
    const start = name.indexOf("word40");
    const window = windowNameAroundMark(name, [{ start, end: start + 6 }], 50, measure)!;
    expect(marked(window)).toEqual(["word40"]);
    expect(window.text.startsWith("word0")).toBe(true);
  });
});

// The text after the name never hides its first mark either (07.10.2026).
describe("windowTextAroundMark", () => {
  // Monospace stand-in: one unit per code point.
  const measure = (text: string) => Array.from(text).length;
  const excerpt = "… using special computer chips that are optimized for running many operations in parallel, known as GPUs.";
  const known = Array.from(excerpt.slice(0, excerpt.indexOf("known"))).length;
  const marked = (window: { text: string; ranges: SearchMatch["ranges"] }) =>
    window.ranges.map((range) => Array.from(window.text).slice(range.start, range.end).join(""));

  it("leaves the text alone when the mark is already in view", () => {
    expect(windowTextAroundMark(excerpt, [{ start: 8, end: 15 }], 50, measure)).toBeNull();
    expect(windowTextAroundMark(excerpt, [], 50, measure)).toBeNull();
    expect(windowTextAroundMark("short known text", [{ start: 6, end: 11 }], 50, measure)).toBeNull();
  });

  it("starts at the earliest word from which a short rest fits whole", () => {
    const window = windowTextAroundMark(excerpt, [{ start: known, end: known + 5 }], 50, measure)!;
    expect(window.text).toBe("…many operations in parallel, known as GPUs.");
    expect(marked(window)).toEqual(["known"]);
    expect(excerpt.endsWith(window.text.slice(1))).toBe(true);
  });

  it("gives the words before the mark at most 40% of the room when the rest runs on", () => {
    const long = `${excerpt} The rest of the note goes on for a long while after the mark and past the line.`;
    const window = windowTextAroundMark(long, [{ start: known, end: known + 5 }], 50, measure)!;
    // The ellipsis included, the lead is at most 20 of the 50 units.
    expect(window.text.startsWith("…in parallel, known as GPUs.")).toBe(true);
    expect(marked(window)).toEqual(["known"]);
  });

  it("keeps an opening quote or bracket with its word", () => {
    const text = `${"x".repeat(60)} "tranquil" known`;
    const start = text.indexOf("known");
    const window = windowTextAroundMark(text, [{ start, end: start + 5 }], 30, measure)!;
    expect(window.text).toBe('…"tranquil" known');
    expect(marked(window)).toEqual(["known"]);
  });

  it("starts at the mark itself when no word before it fits the lead", () => {
    const text = `${"a".repeat(80)} supercalifragilisticexpialidocious known as kura`;
    const start = text.indexOf("known");
    const window = windowTextAroundMark(text, [{ start, end: start + 5 }], 30, measure)!;
    expect(window.text).toBe("…known as kura");
    expect(marked(window)).toEqual(["known"]);
  });

  it("keeps every later mark, shifted into the window", () => {
    const gpus = Array.from(excerpt.slice(0, excerpt.indexOf("GPUs"))).length;
    const window = windowTextAroundMark(excerpt, [{ start: gpus, end: gpus + 4 }, { start: known, end: known + 5 }], 50, measure)!;
    expect(marked(window)).toEqual(["GPUs", "known"]);
  });

  it("gives up when the mark alone is wider than the room", () => {
    expect(windowTextAroundMark(excerpt, [{ start: known, end: known + 5 }], 6, measure)).toBeNull();
  });

  it("counts code points, so an emoji before the mark keeps the ranges right", () => {
    const text = `${"🌊 wave ".repeat(12)}and the tide known as kura`;
    const start = Array.from(text.slice(0, text.indexOf("known"))).length;
    const window = windowTextAroundMark(text, [{ start, end: start + 5 }], 40, measure)!;
    expect(marked(window)).toEqual(["known"]);
    expect(window.text.startsWith("…")).toBe(true);
  });
});
