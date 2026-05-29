import { beforeEach, describe, expect, it } from "vitest";

import "./twitterThreadSelection.js";
import "./xLongformArticleExtraction.js";

type XLongformExtraction = {
  extractXLongformArticle: (input: {
    document: Document;
    locationHref: string;
    fallbackTitle?: string;
    fallbackByline?: string | null;
  }) => null | {
    status: "article" | "empty";
    article: {
      title: string;
      content: string;
      byline: string | null;
      excerpt: string;
      embeddedVideos: Array<unknown>;
    };
  };
};

const xLongform = (globalThis as unknown as {
  MineXLongformArticleExtraction: XLongformExtraction;
}).MineXLongformArticleExtraction;

function tweetArticle(handle: string, tweetId: string, inner: string) {
  return `
    <article data-testid="tweet">
      <div data-testid="User-Name">
        <a href="/${handle}">@${handle}</a>
      </div>
      <a href="/${handle}/status/${tweetId}">
        <time datetime="2026-05-28T00:00:00Z"></time>
      </a>
      ${inner}
      <button data-testid="reply">Reply</button>
      <button data-testid="like">Like</button>
    </article>
  `;
}

function renderTweet(inner: string) {
  document.body.innerHTML = `
    <main>
      <section aria-label="Timeline">
        <div data-testid="cellInnerDiv">
          ${tweetArticle("joeschmidtiv", "2059642470334677472", inner)}
        </div>
      </section>
    </main>
  `;
}

function extract() {
  return xLongform.extractXLongformArticle({
    document,
    locationHref: "https://x.com/joeschmidtiv/status/2059642470334677472",
    fallbackTitle: "Fallback X Title",
    fallbackByline: "@joeschmidtiv",
  });
}

describe("X long-form article extraction", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("extracts visible long-form body before the tweet/thread fallback", () => {
    renderTweet(`
      <div data-testid="tweetText">Launch note for the article</div>
      <div data-testid="x-longform-article">
        <h1>Avoiding Death on the Yellow Brick Road</h1>
        <div dir="auto">The first paragraph explains why a story about Oz became a meditation on illness, fear, and the strange comfort of returning to a childhood image when adult life becomes hard to parse.</div>
        <div dir="auto">The second paragraph continues the argument with enough prose to prove this is not a card, not a recommendation, and not a short tweet body pretending to be an article preview.</div>
        <div dir="auto">The third paragraph keeps the same source surface and gives the extractor a stable article body without depending on generic Defuddle over the entire X timeline.</div>
        <img src="https://pbs.twimg.com/media/article-cover.jpg" />
      </div>
    `);

    const result = extract();

    expect(result?.status).toBe("article");
    expect(result?.article.byline).toBe("@joeschmidtiv");
    expect(result?.article.title).toBe("Avoiding Death on the Yellow Brick Road");
    expect(result?.article.content).toContain("The first paragraph explains");
    expect(result?.article.content).toContain("The third paragraph keeps");
    expect(result?.article.content).toContain("![](https://pbs.twimg.com/media/article-cover.jpg)");
    expect(result?.article.content).not.toContain("Launch note for the article");
    expect(result?.article.content).not.toContain("Reply");
  });

  it("extracts X DraftEditor long-form article blocks from the real read-view surface", () => {
    renderTweet(`
      <div data-testid="twitterArticleReadView">
        <a href="/joeschmidtiv/article/2059642470334677472/media/2059494901952503808">
          <div data-testid="tweetPhoto">
            <img src="https://pbs.twimg.com/media/HJTLs5-bYAA662h?format=jpg&name=small" />
          </div>
        </a>
        <div data-testid="twitter-article-title">Avoiding Death on the Yellow Brick Road</div>
        <div role="group">78 256 1.5K 1M</div>
        <div data-testid="twitterArticleRichTextView">
          <div>
            <div class="DraftEditor-root">
              <div class="DraftEditor-editorContainer">
                <div data-testid="longformRichTextComponent" class="public-DraftEditor-content">
                  <div data-contents="true">
                    <h2 class="longform-header-two" data-block="true">
                      <div><span><span data-text="true">Why The App Layer Isn't Dead</span></span></div>
                    </h2>
                    <div class="longform-unstyled" data-block="true">
                      <div><span><span data-text="true">The question I keep getting from founders and prospective employees: is there any AI application layer left to build, or are OpenAI and Anthropic going to kill everything?</span></span></div>
                    </div>
                    <div class="longform-unstyled" data-block="true">
                      <div>
                        <span><span data-text="true">We’re seeing this play out in real time as OpenAI and Anthropic are effectively telling the market they cannot solve every problem with a generic AI coworker.</span></span>
                        <a href="https://example.com/report"><span><span data-text="true"> massive forward-deployed joint ventures</span></span></a>
                        <span><span data-text="true"> to build whole companies around configuring and customizing their models for the enterprise.</span></span>
                      </div>
                    </div>
                    <div class="longform-unstyled" data-block="true">
                      <div><span><span data-text="true">So if you want to get rich building AI apps, avoid the yellow brick road and build somewhere else in Oz where the product surface is specific, operational, and hard to flatten into a generic chat box.</span></span></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div role="status">Want to publish your own Article? Upgrade to Premium</div>
      </div>
    `);

    const result = extract();

    expect(result?.status).toBe("article");
    expect(result?.article.title).toBe("Avoiding Death on the Yellow Brick Road");
    expect(result?.article.content).toContain("## Why The App Layer Isn't Dead");
    expect(result?.article.content).toContain("[massive forward-deployed joint ventures](https://example.com/report)");
    expect(result?.article.content).toContain("![](https://pbs.twimg.com/media/HJTLs5-bYAA662h?format=jpg&name=large)");
    expect(result?.article.content.indexOf("![](https://pbs.twimg.com/media/HJTLs5-bYAA662h?format=jpg&name=large)")).toBeLessThan(
      result?.article.content.indexOf("## Why The App Layer Isn't Dead") ?? 0,
    );
    expect(result?.article.content).not.toContain("78 256");
    expect(result?.article.content).not.toContain("Want to publish your own Article");
  });

  it("returns null for a normal media tweet so the existing tweet fallback remains valid", () => {
    renderTweet(`
      <div data-testid="tweetText">A short normal tweet.</div>
      <div data-testid="tweetPhoto">
        <img src="https://pbs.twimg.com/media/photo.jpg" />
      </div>
    `);

    expect(extract()).toBeNull();
  });

  it("does not treat nested quote tweet content as the target long-form article", () => {
    renderTweet(`
      <div data-testid="tweetText">A short normal tweet with a quote.</div>
      <article data-testid="tweet">
        <div data-testid="User-Name"><a href="/quoted">@quoted</a></div>
        <a href="/quoted/status/111"><time datetime="2026-05-28T00:00:00Z"></time></a>
        <div data-testid="x-longform-article">
          <div dir="auto">Quoted paragraph one is intentionally long enough to look like article prose if the extractor forgets to scope itself to the target tweet article.</div>
          <div dir="auto">Quoted paragraph two continues that fake article body and should still be ignored because it belongs to a nested quoted tweet, not the URL target.</div>
          <div dir="auto">Quoted paragraph three closes the fake body and protects normal quote tweet saves from being misclassified as long-form articles.</div>
        </div>
      </article>
    `);

    expect(extract()).toBeNull();
  });

  it("returns an explicit empty article when a long-form shell exists without body text", () => {
    renderTweet(`
      <div data-testid="tweetText">Read the full article</div>
      <div data-testid="x-longform-article">
        <img src="https://pbs.twimg.com/media/article-cover.jpg" />
      </div>
    `);

    const result = extract();

    expect(result?.status).toBe("empty");
    expect(result?.article.content).toBe("");
    expect(result?.article.embeddedVideos).toEqual([]);
  });
});
