#!/usr/bin/env bun
// Fetch og:image thumbnails for link blocks in the vault.
// Reads .md files with type: link, fetches og:image from URL,
// saves as .arena/cache/thumbs/{slug}.jpg

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const VAULT = process.argv[2] || "/Users/i_iii/Desktop/Тест";
const THUMBS_DIR = join(VAULT, ".arena", "cache", "thumbs");

mkdirSync(THUMBS_DIR, { recursive: true });

async function fetchOgImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    const html = await res.text();

    // Extract og:image
    const ogMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);

    if (ogMatch?.[1]) return ogMatch[1];

    // Fallback: twitter:image
    const twMatch = html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i);

    return twMatch?.[1] ?? null;
  } catch {
    return null;
  }
}

async function downloadImage(url: string, dest: string): Promise<boolean> {
  try {
    // Resolve relative URLs
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return false;

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) return false;

    const buffer = await res.arrayBuffer();
    writeFileSync(dest, Buffer.from(buffer));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const files = readdirSync(VAULT).filter((f) => f.endsWith(".md"));
  let fetched = 0;

  for (const file of files) {
    const content = readFileSync(join(VAULT, file), "utf-8");
    const slug = file.replace(/\.md$/, "");

    // Check if it's a link block
    if (!content.match(/^type:\s*link/m)) continue;

    // Extract URL
    const urlMatch = content.match(/^url:\s*(.+)$/m);
    if (!urlMatch?.[1]) continue;

    const url = urlMatch[1].replace(/^["']|["']$/g, "").trim();
    console.log(`${slug}: ${url}`);

    // Fetch og:image URL
    const ogUrl = await fetchOgImage(url);
    if (!ogUrl) {
      console.log(`  No og:image found`);
      continue;
    }

    // Resolve relative URL
    const imageUrl = ogUrl.startsWith("http") ? ogUrl : new URL(ogUrl, url).toString();
    console.log(`  og:image: ${imageUrl}`);

    // Download
    const dest = join(THUMBS_DIR, `${slug}.jpg`);
    const ok = await downloadImage(imageUrl, dest);
    if (ok) {
      console.log(`  Saved thumbnail`);
      fetched++;
    } else {
      console.log(`  Failed to download`);
    }
  }

  console.log(`\nDone: ${fetched} thumbnails fetched`);
}

main().catch(console.error);
