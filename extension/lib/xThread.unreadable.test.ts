import { describe, expect, it } from "vitest";
import "./xThread.js";
import { listResponse, QUOTE_POST_ID, quotePost } from "./xFeed.fixtures";

const api = globalThis.MineXThread;

// A feed answer the reader does not know gives no posts, never an error
// (SPEC_CLIPPER.md, «Кнопка Mine в ленте X», rule 6). A part of the answer
// that is not an object is such a shape: it is skipped, and the posts beside
// it are still read.
describe("parts of an X answer that are not objects", () => {
  it("skips an instruction or an entry that is null and keeps the posts beside it", () => {
    const answer = listResponse([quotePost()]);
    const instructions: unknown[] = answer.data.list.tweets_timeline.timeline.instructions;
    instructions.unshift(null);
    const added = answer.data.list.tweets_timeline.timeline.instructions[2];
    if (!added?.entries) throw new Error("the list has no entries to add to");
    const entries: unknown[] = added.entries;
    entries.unshift(null);

    expect(api.feed(answer).map((post) => post.id)).toEqual([QUOTE_POST_ID]);
  });

  it("reads a post whose media list holds null as incomplete", () => {
    const result = quotePost();
    const legacy: Record<string, unknown> = result.legacy;
    legacy.extended_entities = { media: [null] };

    const post = api.post(result);

    expect(post?.id).toBe(QUOTE_POST_ID);
    expect(post?.incomplete).toBe(true);
    expect(post?.mediaComplete).toBe(false);
  });
});
