// The article of the card opening check (`bun run test:card-open`,
// scripts/card-open-audit.mjs; SPEC_READING_MODE.md, Ч0.5): a body shaped as
// the clipper saves an article, of a given size in bytes. Sections with
// headings, paragraphs with bold text and links, lists, quotes, a block of
// code and a table now and then, and every picture written as the clipper
// writes it, a wikilink embed on a line of its own. Generated the same way
// every time, so the check carries no fixture of 100 KB and two runs open
// the same text. Dev only.

/** The title, which the clipper also names the article's pictures by. */
export const CARD_OPEN_ARTICLE_TITLE = "A long article about the state of the world";
/** The article's last paragraph: the card shows the whole body once it
 *  shows this one. */
export const CARD_OPEN_ARTICLE_END = "The article ends here.";

const WORDS = [
  "the", "of", "and", "to", "in", "is", "that", "for", "it", "as", "was", "with", "be", "by", "on", "not", "this",
  "are", "or", "from", "at", "which", "but", "have", "an", "had", "they", "you", "were", "their", "one", "all", "we",
  "can", "has", "there", "been", "if", "more", "when", "will", "would", "who", "so", "no", "out", "up", "into",
  "than", "them", "only", "its", "time", "new", "some", "could", "these", "two", "may", "then", "do", "first", "any",
  "now", "such", "like", "our", "over", "even", "most", "made", "after", "also", "many", "before", "must", "through",
  "years", "where", "much", "way", "well", "down", "should", "because", "each", "just", "those", "people", "how",
  "little", "state", "good", "very", "make", "world", "still", "own", "see", "work", "long", "here", "between",
  "both", "life", "being", "under", "never", "day", "same", "another", "know", "while", "last", "might", "great",
  "old", "year", "off", "come", "since", "against", "right", "used", "take", "three",
];

/** The share of blocks of each kind, as a clipped article of a magazine has
 *  them: mostly paragraphs, a picture every dozen blocks. */
const SHARE = { heading: 0.06, picture: 0.08, list: 0.06, quote: 0.03, code: 0.02, table: 0.02 };

/** A small generator of the same numbers for the same seed (mulberry32). */
function numbers(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sentence(next: () => number): string {
  const count = 8 + Math.floor(next() * 14);
  const words = Array.from({ length: count }, () => WORDS[Math.floor(next() * WORDS.length)] ?? "the");
  const first = words[0] ?? "the";
  words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return `${words.join(" ")}.`;
}

function paragraph(next: () => number): string {
  const sentences = Array.from({ length: 3 + Math.floor(next() * 4) }, () => sentence(next));
  if (next() < 0.3) sentences[1] = (sentences[1] ?? "").replace(/ (\w+) /, " **$1** ");
  if (next() < 0.3) sentences[0] = (sentences[0] ?? "").replace(/ (\w+)\.$/, " [$1](https://example.com/page).");
  return sentences.join(" ");
}

/** The name of the article's picture `index`, as the clipper names it. */
export function cardOpenPictureName(index: number): string {
  return `${CARD_OPEN_ARTICLE_TITLE} (image ${index}).jpg`;
}

function block(next: () => number, counts: { pictures: number; sections: number }): string {
  const kind = next();
  let edge = SHARE.heading;
  if (kind < edge) {
    counts.sections += 1;
    return `## Section ${counts.sections}: ${sentence(next).slice(0, 40)}`;
  }
  edge += SHARE.picture;
  if (kind < edge) {
    counts.pictures += 1;
    return `![[${cardOpenPictureName(counts.pictures)}]]`;
  }
  edge += SHARE.list;
  if (kind < edge) return Array.from({ length: 3 + Math.floor(next() * 3) }, () => `- ${sentence(next)}`).join("\n");
  edge += SHARE.quote;
  if (kind < edge) return `> ${sentence(next)} ${sentence(next)}`;
  edge += SHARE.code;
  if (kind < edge) return "```ts\nconst answer = 42;\nconsole.log(answer);\n```";
  edge += SHARE.table;
  if (kind < edge) return "| Name | Value |\n| --- | --- |\n| one | 1 |\n| two | 2 |";
  return paragraph(next);
}

const encoder = new TextEncoder();

/** The article of at least `bytes` bytes of UTF-8. */
export function cardOpenArticle(bytes: number): string {
  const next = numbers(1);
  const counts = { pictures: 0, sections: 0 };
  const blocks = [`# ${CARD_OPEN_ARTICLE_TITLE}`];
  // The text is ASCII, so a block's length is its size in bytes.
  let size = blocks[0]?.length ?? 0;
  while (size + CARD_OPEN_ARTICLE_END.length < bytes) {
    const text = block(next, counts);
    blocks.push(text);
    size += text.length + 2;
  }
  blocks.push(CARD_OPEN_ARTICLE_END);
  const body = `${blocks.join("\n\n")}\n`;
  if (encoder.encode(body).length < bytes) throw new Error("The article came out shorter than asked");
  return body;
}
