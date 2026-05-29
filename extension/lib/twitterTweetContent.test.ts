import { beforeEach, describe, expect, it } from "vitest";

import "./twitterThreadSelection.js";
import "./twitterTweetContent.js";

type TweetContent = {
  extractTweetContentParts: (article: Element) => {
    mainText: string;
    media: string[];
    quotes: Array<{ text: string; media: string[] }>;
  };
  extractTweetContent: (article: Element) => { text: string; media: string[] };
};

const tweetContent = (globalThis as unknown as {
  MineTwitterTweetContent: TweetContent;
}).MineTwitterTweetContent;

function renderTweet(inner: string) {
  document.body.innerHTML = `
    <main>
      <div data-testid="cellInnerDiv">
        <article data-testid="tweet">
          <div data-testid="User-Name"><a href="/a16z">@a16z</a></div>
          <a href="/a16z/status/2060036559173501349">
            <time datetime="2026-05-29T00:00:00Z"></time>
          </a>
          ${inner}
        </article>
      </div>
      <div data-testid="cellInnerDiv">
        <article data-testid="tweet">
          <div data-testid="User-Name"><a href="/reply">@reply</a></div>
          <a href="/reply/status/900"><time datetime="2026-05-29T00:00:00Z"></time></a>
          <div data-testid="tweetText">This reply must never be clipped with the target tweet.</div>
        </article>
      </div>
    </main>
  `;
}

function targetArticle() {
  const article = document.querySelector('article[data-testid="tweet"]');
  if (!article) throw new Error("Missing test article");
  return article;
}

describe("twitter tweet content extraction", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps quote tweet text and media inside the parent tweet body", () => {
    renderTweet(`
      <div data-testid="tweetText">Main post text with a <a href="https://example.com/report">source link</a>.</div>
      <a href="/a16z/status/2060036559173501349/photo/1">
        <div data-testid="tweetPhoto">
          <img src="https://pbs.twimg.com/media/main-one?format=jpg&name=small" />
        </div>
      </a>
      <a href="/a16z/status/2060036559173501349/photo/2">
        <div data-testid="tweetPhoto">
          <img src="https://pbs.twimg.com/media/main-two?format=jpg&name=small" />
        </div>
      </a>
      <div>Quote</div>
      <div role="link">
        <div data-testid="User-Name"><a href="/marty_kausas">@marty_kausas</a></div>
        <a href="/marty_kausas/status/2060028343315988884">
          <time datetime="2026-05-29T00:00:00Z"></time>
        </a>
        <div data-testid="tweetText">Quoted post text that belongs to the saved parent post.</div>
        <a href="/marty_kausas/status/2060028343315988884/photo/1">
          <div data-testid="tweetPhoto">
            <img src="https://pbs.twimg.com/media/quote-one?format=jpg&name=small" />
          </div>
        </a>
      </div>
    `);

    const content = tweetContent.extractTweetContent(targetArticle());

    expect(content.media).toEqual([
      "https://pbs.twimg.com/media/main-one?format=jpg&name=large",
      "https://pbs.twimg.com/media/main-two?format=jpg&name=large",
    ]);
    expect(content.text).toContain("Main post text with a [source link](https://example.com/report).");
    expect(content.text).toContain("> Quoted post text that belongs to the saved parent post.");
    expect(content.text).toContain("> ![](https://pbs.twimg.com/media/quote-one?format=jpg&name=large)");
    expect(content.text).not.toContain("This reply must never be clipped");
  });

  it("does not treat an inline status link in the main tweet text as a quote card", () => {
    renderTweet(`
      <div data-testid="tweetText">
        Main post links to <a href="/someone/status/123">another status</a> inline.
      </div>
    `);

    const parts = tweetContent.extractTweetContentParts(targetArticle());

    expect(parts.mainText).toContain("Main post links to another status inline.");
    expect(parts.quotes).toEqual([]);
  });

  it("supports older nested quote tweet article markup without selecting it as a thread item", () => {
    renderTweet(`
      <div data-testid="tweetText">Parent tweet text.</div>
      <article data-testid="tweet">
        <div data-testid="User-Name"><a href="/quoted">@quoted</a></div>
        <a href="/quoted/status/401"><time datetime="2026-05-29T00:00:00Z"></time></a>
        <div data-testid="tweetText">Nested quoted tweet text.</div>
        <div data-testid="tweetPhoto">
          <img src="https://pbs.twimg.com/media/nested-quote?format=jpg&name=small" />
        </div>
      </article>
    `);

    const content = tweetContent.extractTweetContent(targetArticle());

    expect(content.text).toContain("Parent tweet text.");
    expect(content.text).toContain("> Nested quoted tweet text.");
    expect(content.text).toContain("> ![](https://pbs.twimg.com/media/nested-quote?format=jpg&name=large)");
    expect(content.media).toEqual([]);
  });
});
