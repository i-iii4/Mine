import { beforeEach, describe, expect, it } from "vitest";
import "./tweetTextCompletion.js";

type Completion = {
  preferCompleteTweetText: (domText: unknown, apiText: unknown) => string;
  tweetTextPlain: (text: unknown) => string;
};

describe("tweet text completion", () => {
  let completion: Completion;

  beforeEach(() => {
    completion = (window as unknown as { MineTweetTextCompletion: Completion })
      .MineTweetTextCompletion;
  });

  it("takes the API text when the page stopped mid-sentence", () => {
    // The real failure: X collapsed the post behind "Show more" and the saved
    // card ended on "automating it would".
    const dom = "the value of ths process actually lies within myself. aka, automating it would";
    const api = `${dom} defeat the point entirely.`;

    expect(completion.preferCompleteTweetText(dom, api)).toBe(api);
  });

  it("keeps the page text when it is already complete", () => {
    // The DOM reading carries markdown links the API flattens, so it wins
    // whenever nothing is missing.
    const dom = "read [the post](https://example.com/a) today";
    const api = "read https://t.co/x today";

    expect(completion.preferCompleteTweetText(dom, api)).toBe(dom);
  });

  it("compares through markdown links rather than raw characters", () => {
    const dom = "check [this](https://example.com/very/long/url) out";
    const api = "check this out — and the rest of the post that was hidden";

    expect(completion.preferCompleteTweetText(dom, api)).toBe(api);
  });

  it("refuses an API text that is not the same post", () => {
    // A longer answer about something else must not replace what was read.
    const dom = "morning notes on typography";
    const api = "a completely different post that happens to be longer than the other one";

    expect(completion.preferCompleteTweetText(dom, api)).toBe(dom);
  });

  it("falls back to whichever side has anything at all", () => {
    expect(completion.preferCompleteTweetText("", "only the api")).toBe("only the api");
    expect(completion.preferCompleteTweetText("only the dom", "")).toBe("only the dom");
    expect(completion.preferCompleteTweetText("", "")).toBe("");
    expect(completion.preferCompleteTweetText(null, undefined)).toBe("");
  });
});

describe("thread separator", () => {
  it("never writes the front matter delimiter into a body", async () => {
    // `---` on its own line is also how front matter is delimited: a body that
    // opens with it can be read as a second front matter block.
    const { readFileSync } = await import("node:fs");
    const content = readFileSync("extension/content.js", "utf8");

    expect(content).toContain('parts.push("***")');
    expect(content).not.toContain('parts.push("---")');
  });
});
