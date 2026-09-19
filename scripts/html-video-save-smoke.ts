// Real HTML normalization -> installed native host -> local media decoding.
// Uses a new disposable vault, never the user's cards or active vault config.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { normalizeArticleMedia } from "../extension/popup/lib/normalizeArticleMedia";
import fixture from "../extension/popup/lib/fixtures/objkt-video.json";

const run = promisify(execFile);
const host = "/Applications/Mine.app/Contents/MacOS/native-host";
const vault = await mkdtemp(join(tmpdir(), "mine-html-video-"));
await mkdir(join(vault, ".mine"));
await writeFile(join(vault, ".mine/vault-id"), randomUUID());
await writeFile(join(vault, ".mine/layout.json"), JSON.stringify({ cards: "Cards", media: "Media", collections: "Collections" }));
const article = normalizeArticleMedia(fixture.article, fixture.pageUrl);
assert.ok(article.content.includes(`![](${fixture.mediaUrl})`));
assert.ok(!article.content.includes("<video"));

function wire(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const json = Buffer.from(JSON.stringify(request));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length);
    const child = execFile(host, [], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024, encoding: "buffer" }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${error.message}\n${stderr.toString()}`));
      try {
        assert.ok(stdout.length >= 4);
        const length = stdout.readUInt32LE();
        resolve(JSON.parse(stdout.subarray(4, 4 + length).toString()));
      } catch (cause) { reject(cause); }
    });
    child.stdin?.end(Buffer.concat([header, json]));
  });
}
const status = await wire({ action: "get_status", vault_path: vault });
assert.equal(status.ok, true, JSON.stringify(status));
const response = await wire({
  action: "save_block", vault_path: vault, binding_id: status.binding_id,
  operation_id: randomUUID(), block_type: "article", title: article.title,
  url: fixture.pageUrl, body: article.content, tags: [],
  saved_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
});
assert.equal(response.ok, true, JSON.stringify(response));
assert.equal(response.outcome, "committed");
assert.equal(typeof response.slug, "string");
const card = join(vault, `${response.slug}.md`);
const markdown = await readFile(card, "utf8");
assert.ok(card.startsWith(join(vault, "Cards/")));
assert.ok(!markdown.includes(fixture.mediaUrl), "Remote source must be replaced by a local media reference");
assert.match(markdown, /!\[\[Media\/[^\]]+\.mp4\]\]/);
const mediaFiles = await readdir(join(vault, "Media"));
const videos = mediaFiles.filter((name) => name.endsWith(".mp4"));
assert.equal(videos.length, 1);
const media = join(vault, "Media", videos[0]!);
const bytes = (await stat(media)).size;
assert.ok(bytes > 0);
const { stdout } = await run("/opt/homebrew/bin/ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", media]);
const probe = JSON.parse(stdout);
assert.ok(probe.streams.some((stream: { codec_type: string }) => stream.codec_type === "video"));
// Protocol allowlist prevents a hidden network reference during full decoding.
await run("/opt/homebrew/bin/ffmpeg", ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", media, "-f", "null", "-"], { timeout: 120_000 });
const report = { ok: true, host, vault, card, media, bytes, response, probe, verification: "Actual native save and full local decode with network protocols disabled; not a native UI playback test" };
await writeFile(join(vault, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: true, vault, card, media, bytes, duration: probe.format.duration }, null, 2));
