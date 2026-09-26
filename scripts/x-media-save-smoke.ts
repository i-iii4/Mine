// Run with Bun. Authenticated transport is a fixture; downloads and native writes are real.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { hydrateTwitterPosts } from "../extension/popup/lib/twitterMedia";

const tweetId = "2103621844733714547";
const video = "https://video.twimg.com/amplify_video/2103618771441360896/vid/avc1/1280x720/SRz40Vsis3bFBscQ.mp4?tag=14";
const gif = "https://video.twimg.com/tweet_video/HTGOUI-a8AA8ROt.mp4";
const host = join(homedir(), "Library/Application Support/com.mine.app/clipper/native-host");
const output = join(import.meta.dir, "../output/playwright");
await mkdir(output, { recursive: true });
const vault = await mkdtemp(join(output, "x-media-save-"));

async function wire(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const body = Buffer.from(JSON.stringify(request));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return new Promise((resolve, reject) => {
    const child = execFile(host, [], { timeout: 120_000, encoding: "buffer", maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      assert.equal(stdout.readUInt32LE(0), stdout.length - 4);
      resolve(JSON.parse(stdout.subarray(4).toString()));
    });
    child.stdin!.end(Buffer.concat([header, body]));
  });
}

const article = await hydrateTwitterPosts({
  title: "X mixed animations", content: `Post\n\n![](${gif})`, byline: null, excerpt: "",
  twitterPosts: [{ id: tweetId, text: "Post", media: [{ kind: "video", url: gif, poster: null }] }],
}, {
  publicMedia: async () => ({ ok: true, media: [] }),
  authenticatedMedia: async () => ({ ok: true, media: [
    { kind: "video", src: video, poster: "https://pbs.twimg.com/amplify_video_thumb/2103618771441360896/img/S3Q12YRWjxuEvwWU.jpg" },
    { kind: "video", src: gif, poster: "https://pbs.twimg.com/tweet_video_thumb/HTGOUI-a8AA8ROt.jpg" },
  ] }),
  frame: async () => null,
});
assert.deepEqual(article.embeddedVideos?.map(m => m.src), [video, gif]);
const status = await wire({ action: "get_status", vault_path: vault });
assert.equal(status.ok, true);
const saved = await wire({ action: "save_block", vault_path: vault, binding_id: status.binding_id,
  operation_id: `x-media-${randomUUID()}`, block_type: "article", title: article.title,
  body: article.content, url: `https://x.com/GasprArt/status/${tweetId}`, tags: [], saved_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
});
assert.equal(saved.ok, true, JSON.stringify(saved));
assert.equal(saved.outcome, "committed");
const markdown = await readFile(join(vault, `${saved.slug}.md`), "utf8");
const files = await readdir(vault, { recursive: true });
const videos = files.filter(p => p.endsWith(".mp4")).sort();
assert.equal(videos.length, 2, markdown);
assert.equal((markdown.match(/!\[\[.*?\.mp4\]\]/g) ?? []).length, 2, markdown);
const hashes = await Promise.all(videos.map(async p => ({ path: p,
  sha256: createHash("sha256").update(await readFile(join(vault, p))).digest("hex"),
})));
assert.equal(hashes[1]?.sha256, "347081a589f437e86208e9a739a63230c52ae01c48bfc6c05a325a8aea85a88c");
assert.equal(hashes[0]?.sha256, "9110a0aed8849754f7195e1059eac9c9d521c85e730027d73dae0d07fcd8eb19");
console.log(JSON.stringify({ ok: true, vault, previewCount: 2, savedFiles: hashes,
  transport: "authenticated response fixture; real native save and CDN downloads" }, null, 2));
