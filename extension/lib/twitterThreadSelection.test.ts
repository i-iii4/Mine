import { describe, expect, it, beforeEach } from "vitest";

import "./twitterThreadSelection.js";

const twitterThreadSelection = globalThis.MineTwitterThreadSelection;

function tweetCell(handle: string, tweetId: string, text: string, inner = "") {
  return `
    <div data-testid="cellInnerDiv">
      <article data-testid="tweet">
        <div data-testid="User-Name">
          <a href="/${handle}">@${handle}</a>
        </div>
        <a href="/${handle}/status/${tweetId}"><time datetime="2026-05-09T00:00:00Z"></time></a>
        <div data-testid="tweetText">${text}</div>
        ${inner}
      </article>
    </div>
  `;
}

function boundaryCell(label: string) {
  return `
    <div data-testid="cellInnerDiv">
      <div role="heading">${label}</div>
    </div>
  `;
}

function renderTimeline(cells: string[]) {
  document.body.innerHTML = `
    <main>
      <section aria-label="Timeline">
        <div>${cells.join("")}</div>
      </section>
    </main>
  `;
}

function selectedIds(targetTweetId: string, authorHandle = "kotecinho") {
  return twitterThreadSelection
    .selectTwitterThreadArticles({ document, targetTweetId, authorHandle })
    .map((article: Element) => twitterThreadSelection.getTweetIdentity(article)?.tweetId);
}

describe("twitter thread selection", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("does not include same-author recommendations after a structural boundary", () => {
    renderTimeline([
      tweetCell("kotecinho", "2053125567663284556", "Target tweet"),
      boundaryCell("More tweets"),
      tweetCell("kotecinho", "2059999999999999999", "Recommended same-author tweet"),
    ]);

    expect(selectedIds("2053125567663284556")).toEqual(["2053125567663284556"]);
  });

  it("keeps a contiguous same-author thread around the target tweet", () => {
    renderTimeline([
      tweetCell("kotecinho", "100", "Thread part 1"),
      tweetCell("kotecinho", "101", "Thread part 2"),
      tweetCell("kotecinho", "102", "Thread part 3"),
    ]);

    expect(selectedIds("101")).toEqual(["100", "101", "102"]);
  });

  it("stops before comments or чужие tweets", () => {
    renderTimeline([
      tweetCell("kotecinho", "200", "Target tweet"),
      tweetCell("somebodyelse", "201", "Comment"),
      tweetCell("kotecinho", "202", "Later recommendation"),
    ]);

    expect(selectedIds("200")).toEqual(["200"]);
  });

  it("uses the target tweet id instead of the first visible same-author tweet", () => {
    renderTimeline([
      tweetCell("kotecinho", "300", "Previous same-author tweet"),
      boundaryCell("Conversation boundary"),
      tweetCell("kotecinho", "301", "Target tweet"),
    ]);

    expect(selectedIds("301")).toEqual(["301"]);
  });

  it("ignores nested quote tweet articles as separate thread items", () => {
    const quote = `
      <article data-testid="tweet">
        <div data-testid="User-Name"><a href="/quoted">@quoted</a></div>
        <a href="/quoted/status/401"><time datetime="2026-05-09T00:00:00Z"></time></a>
        <div data-testid="tweetText">Quoted tweet</div>
      </article>
    `;

    renderTimeline([
      tweetCell("kotecinho", "400", "Target tweet", quote),
      tweetCell("kotecinho", "402", "Thread continuation"),
    ]);

    expect(selectedIds("400")).toEqual(["400", "402"]);
  });
});
