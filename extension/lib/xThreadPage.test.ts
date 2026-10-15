import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  bookmarksResponse, likesResponse, listResponse, QUOTE_POST_ID, REPLY_ID, REPOSTED_ID, userRepliesResponse, userVideoNextResponse,
  VIDEO_POST_ID,
} from "./xFeed.fixtures";

// The MAIN world of an X page: the page's own fetch and XHR, observed by the
// sources the manifest loads there (SPEC_CLIPPER.md, «Кнопка Mine в ленте X»).
const sources = ["extension/lib/xThread.js", "extension/lib/xThreadPage.js"].map((path) => readFileSync(path, "utf8"));

interface PagePost { id: string; handle: string; text: string; quote: { id: string } | null }
interface PageApi { post(id: string): Promise<PagePost | null> }

/// The XHR of one page; the test answers each request.
function xhrClass() {
  return class FakeXhr {
    status = 0;
    responseType = "";
    responseText = "";
    response: unknown = null;
    private listeners: Array<() => void> = [];
    open(_method: string, _url: string) { return undefined; }
    setRequestHeader(_name: string, _value: string) { return undefined; }
    send() { return undefined; }
    addEventListener(type: string, listener: () => void) { if (type === "loadend") this.listeners.push(listener); }
    answer(status: number, body: unknown) {
      this.status = status;
      this.responseText = JSON.stringify(body);
      for (const listener of this.listeners) listener();
    }
  };
}

function xPage(origin = "https://x.com") {
  const fetch = vi.fn(async (_input: unknown, _init?: unknown) => new Response(JSON.stringify(listResponse()), { status: 200 }));
  const Xhr = xhrClass();
  const context = createContext({
    location: { href: `${origin}/i/lists/123`, origin },
    fetch, XMLHttpRequest: Xhr, Headers, Request, Response, URL, AbortController,
    setTimeout, clearTimeout, addEventListener: () => undefined, removeEventListener: () => undefined,
  });
  context.window = context;
  for (const source of sources) runInContext(source, context);
  const page = context.MineXThreadPage as PageApi;
  return { page, fetch, Xhr, context, request: (url: string, init?: RequestInit) => (context.fetch as typeof globalThis.fetch)(url, init) };
}

const LIST = "/i/api/graphql/Q1/ListLatestTweetsTimeline?variables=%7B%22listId%22%3A%22123%22%2C%22count%22%3A20%7D";

describe("posts a feed of the page delivered", () => {
  it("keeps every post of a list page by its ID and leaves X's response as it was", async () => {
    const { page, request } = xPage();
    const response = await request(`https://x.com${LIST}`);
    expect(await response.json()).toEqual(listResponse());
    expect((await page.post(QUOTE_POST_ID))?.quote?.id).toBe("2108000000000000001");
    expect((await page.post(VIDEO_POST_ID))?.handle).toBe("GasprArt");
    // The repost card stands for the reposted post.
    expect((await page.post(REPOSTED_ID))?.text).toBe("post 2099105293938708797");
  });

  it("reads a home feed asked with POST and an X Pro column on its own origin", async () => {
    const home = xPage();
    await home.request("https://x.com/i/api/graphql/H1/HomeLatestTimeline", { method: "POST", body: "{}" });
    expect(await home.page.post(QUOTE_POST_ID)).not.toBeNull();
    const pro = xPage("https://pro.x.com");
    await pro.request(`https://pro.x.com/i/api/graphql/U1/UserOriginalsTimeline?variables=%7B%7D`);
    expect(await pro.page.post(VIDEO_POST_ID)).not.toBeNull();
  });

  // Е3.18: the feeds of the Bookmarks, Likes, Media and Replies pages, on
  // x.com and in an X Pro column.
  it.each(["https://x.com", "https://pro.x.com"])("reads Bookmarks, Likes, Media and Replies on %s", async (origin) => {
    const feeds: Array<[string, unknown, string]> = [
      ["Bookmarks", bookmarksResponse(), VIDEO_POST_ID],
      ["Likes", likesResponse(), REPOSTED_ID],
      ["UserVideoTimeline", userVideoNextResponse(), QUOTE_POST_ID],
      ["UserRepliesTimeline", userRepliesResponse(), REPLY_ID],
    ];
    for (const [operation, response, id] of feeds) {
      const { page, request, fetch } = xPage(origin);
      fetch.mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }));
      await request(`${origin}/i/api/graphql/Q1/${operation}?variables=%7B%22count%22%3A20%7D`);
      expect((await page.post(id))?.id, operation).toBe(id);
    }
  });

  it("reads a feed answered over XHR", async () => {
    const { page, Xhr } = xPage();
    // The observer wraps the prototype the page's requests use.
    const xhr = new Xhr();
    xhr.open("GET", `https://x.com${LIST}`);
    xhr.send();
    xhr.answer(200, listResponse());
    expect((await page.post(QUOTE_POST_ID))?.handle).toBe("artignatev");
  });

  it("ignores other origins, other operations and failed answers", async () => {
    const { page, request, fetch } = xPage();
    await request(`https://api.example.com${LIST}`);
    await request("https://x.com/i/api/graphql/B1/UserByScreenName?variables=%7B%7D");
    fetch.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    await request(`https://x.com${LIST}`);
    expect(await page.post(QUOTE_POST_ID)).toBeNull();
    expect(await page.post("not-a-number")).toBeNull();
  });

  it("waits for a feed answer still on its way", async () => {
    const { page, request, fetch } = xPage();
    let answer!: (response: Response) => void;
    fetch.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    void request(`https://x.com${LIST}`);
    const read = page.post(QUOTE_POST_ID);
    answer(new Response(JSON.stringify(listResponse()), { status: 200 }));
    expect((await read)?.id).toBe(QUOTE_POST_ID);
  });

  it("keeps at most 500 posts, the oldest leaving first", async () => {
    const { page, request, fetch } = xPage();
    const many = Array.from({ length: 501 }, (_, index) => ({ __typename: "Tweet", rest_id: String(1000 + index),
      core: { user_results: { result: { rest_id: "1", core: { screen_name: "many" } } } },
      legacy: { id_str: String(1000 + index), full_text: `post ${index}` } }));
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(listResponse(many)), { status: 200 }));
    await request(`https://x.com${LIST}`);
    expect(await page.post("1000")).toBeNull();
    expect((await page.post("1001"))?.text).toBe("post 1");
    expect((await page.post("1500"))?.text).toBe("post 500");
  });

  // Background puts the page world's scripts again only into a page without
  // the cache (SPEC_CLIPPER.md, К4, «Открытые страницы после перезагрузки»);
  // put twice anyway, the cache stays the one the page had.
  it("runs once per page: a second run keeps the cache, its posts and the one observer of fetch and XHR", async () => {
    const { page, request, fetch, context, Xhr } = xPage();
    await request(`https://x.com${LIST}`);
    const observed = { fetch: context.fetch, open: Xhr.prototype.open, send: Xhr.prototype.send };
    for (const source of sources) runInContext(source, context);
    expect(context.MineXThreadPage).toBe(page);
    expect({ fetch: context.fetch, open: Xhr.prototype.open, send: Xhr.prototype.send }).toEqual(observed);
    expect((await page.post(QUOTE_POST_ID))?.handle).toBe("artignatev");
    await request(`https://x.com${LIST}`);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
