import { describe, expect, it } from "vitest";
import { preprocessWikilinksWithMap } from "@/lib/markdownWikilinks";
import { CARD_OPEN_ARTICLE_END, CARD_OPEN_ARTICLE_TITLE, cardOpenArticle, cardOpenPictureName } from "./cardOpenArticle";

// The article of the card opening check (scripts/card-open-audit.mjs).
describe("cardOpenArticle", () => {
  const bytes = 100 * 1024;
  const body = cardOpenArticle(bytes);

  it("is of the size asked, the same every time", () => {
    const size = new TextEncoder().encode(body).length;
    expect(size).toBeGreaterThanOrEqual(bytes);
    // No more than a block over.
    expect(size).toBeLessThan(bytes + 2048);
    expect(cardOpenArticle(bytes)).toBe(body);
  });

  it("starts with its title and ends with the paragraph the check waits for", () => {
    expect(body.startsWith(`# ${CARD_OPEN_ARTICLE_TITLE}\n\n`)).toBe(true);
    expect(body.endsWith(`\n\n${CARD_OPEN_ARTICLE_END}\n`)).toBe(true);
  });

  it("writes its pictures as the clipper does, a wikilink embed on a line of its own", () => {
    const embeds = body.split("\n").filter((line) => line.startsWith("![["));
    expect(embeds.length).toBeGreaterThan(20);
    expect(embeds[0]).toBe(`![[${cardOpenPictureName(1)}]]`);
    // Every one of them is rewritten for the pipeline.
    expect(preprocessWikilinksWithMap(body).rewrites).toHaveLength(embeds.length);
  });
});
