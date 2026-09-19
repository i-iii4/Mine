// Isolated packaged-extension integration test. No personal profile or live X requests.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const extension = join(root, 'build/clipper-extension');
const profile = mkdtempSync(join(tmpdir(), 'mine-x-thread-'));
const tweet = (id, parent = null, author = '7') => ({ __typename: 'Tweet', rest_id: id,
  core: { user_results: { result: { rest_id: author, core: { screen_name: 'author' } } } },
  legacy: { full_text: `PART-${id}`, in_reply_to_status_id_str: parent } });
const response = (posts, cursor) => ({ data: { threaded_conversation_with_injections_v2: { instructions: [{
  type: 'TimelineAddEntries', entries: [
    { entryId: 'conversationthread-author', content: { __typename: 'TimelineTimelineModule', items: [
      ...posts.map(t => ({ item: { itemContent: { itemType: 'TimelineTweet', tweet_results: { result: t } } } })),
      ...(cursor ? [{ item: { itemContent: { __typename: 'TimelineTimelineCursor', cursorType: 'ShowMore', value: cursor } } }] : []),
    ] } },
    { content: { __typename: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'infinite-comments' } },
  ],
}] } } });
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.MINE_TEST_CHROMIUM ? { executablePath: process.env.MINE_TEST_CHROMIUM } : { channel: 'chromium' }),
    headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  let failContinuation = false;
  let repeatCursor = false;
  let completeInitially = false;
  let requests = 0;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/TweetDetail')) {
      requests++;
      const cursor = JSON.parse(url.searchParams.get('variables')).cursor;
      assert.notEqual(cursor, 'infinite-comments', 'must never paginate the unrelated discussion');
      return route.fulfill({ status: cursor && failContinuation ? 503 : 200, contentType: 'application/json',
        body: JSON.stringify(cursor ? response([tweet('11', '10'), tweet('12', '11'), tweet('13', '12'), tweet('20', '10', '8'), tweet('21', '20')], repeatCursor ? 'next' : null) : completeInitially ? response([tweet('10'), tweet('11', '10'), tweet('12', '11'), tweet('13', '12')]) : response([tweet('10')], 'next')) });
    }
    return route.fulfill({ contentType: 'text/html', body: '<html><head><title>Test</title></head><body><article data-testid="tweet"><div data-testid="User-Name"><a href="/author/status/10"><time>now</time></a></div><div data-testid="tweetText">PART-10</div></article></body></html>' });
  });
  const page = await context.newPage();
  await page.goto('https://x.com/author/status/10');
  const requestUrl = 'https://x.com/i/api/graphql/test/TweetDetail?variables=' + encodeURIComponent(JSON.stringify({ focalTweetId: '10' }));
  const original = await page.evaluate(async url => (await fetch(url)).json(), requestUrl);
  assert.equal(original.data.threaded_conversation_with_injections_v2.instructions.length, 1, 'site response is preserved');
  const extract = () => worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://x.com/author/status/10' });
    return chrome.tabs.sendMessage(tab.id, { action: 'extractArticleAsync' });
  });
  const full = await extract();
  assert.equal(full.threadPostCount, 4, JSON.stringify(full));
  for (const id of ['10', '11', '12', '13']) assert.ok(full.content.includes(`PART-${id}`));
  assert.ok(!full.content.includes('PART-20') && !full.content.includes('PART-21'));
  assert.ok(!full.threadWarning, full.threadWarning);
  failContinuation = true;
  const partial = await extract();
  assert.ok(partial.threadWarning.includes('could not load'), JSON.stringify(partial));
  assert.equal(partial.threadPostCount, 1);
  // XHR is the other native X transport; the recorder must support both.
  failContinuation = false;
  await page.evaluate(url => new Promise(resolve => { const xhr = new XMLHttpRequest(); xhr.open('GET', url); xhr.onload = resolve; xhr.send(); }), requestUrl);
  assert.equal((await extract()).threadPostCount, 4);
  repeatCursor = true;
  assert.match((await extract()).threadWarning, /repeated a continuation/);
  await page.reload();
  const missing = await extract();
  assert.match(missing.threadWarning, /Reload this X page/);
  completeInitially = true;
  repeatCursor = false;
  await page.evaluate(async url => (await fetch(url)).json(), requestUrl);
  const before = requests;
  const complete = await extract();
  assert.equal(complete.threadPostCount, 4);
  assert.ok(!complete.threadWarning, complete.threadWarning);
  assert.equal(requests, before, 'complete author chain must cause zero continuation requests');
  console.log('PASS: packaged extension fetch/XHR, pagination, four-part chain, comment exclusion, explicit partial failure, repeated cursor, missing observer data');
} finally {
  await context?.close();
  rmSync(profile, { recursive: true, force: true });
}
