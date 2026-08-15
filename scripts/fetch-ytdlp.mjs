#!/usr/bin/env node
// Fetch the yt-dlp binary that ships inside the app bundle.
//
// Saving age-restricted video from X is a primary scenario, not an optional
// extra: the public syndication API refuses those clips to an anonymous caller,
// and yt-dlp is what gets them with the browser's own cookies. Asking a person
// who installed Mine from a store to run `brew install` first is not a path
// anyone walks, so the binary travels with the app.
//
// Downloaded rather than committed: it is a 30 MB third-party artifact with its
// own release cadence, and git is the wrong place for it.

import { createWriteStream } from "node:fs";
import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, "..");
const DESTINATION = join(PROJECT, "src-tauri", "binaries", "yt-dlp");

// macOS universal build, pinned so a rebuild is reproducible.
const VERSION = "2026.07.04";
const URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}/yt-dlp_macos`;

async function alreadyPresent() {
  try {
    const info = await stat(DESTINATION);
    return info.isFile() && info.size > 1_000_000;
  } catch {
    return false;
  }
}

async function main() {
  if (await alreadyPresent()) {
    console.log(`yt-dlp already staged at ${DESTINATION}`);
    return;
  }

  await mkdir(dirname(DESTINATION), { recursive: true });
  console.log(`Downloading yt-dlp ${VERSION}…`);

  const response = await fetch(URL, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`failed to download yt-dlp: HTTP ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(DESTINATION));
  await chmod(DESTINATION, 0o755);

  const info = await stat(DESTINATION);
  if (info.size < 1_000_000) {
    throw new Error(`downloaded yt-dlp looks truncated: ${info.size} bytes`);
  }
  console.log(`yt-dlp staged at ${DESTINATION} (${Math.round(info.size / 1_000_000)} MB)`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
