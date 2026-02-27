#!/usr/bin/env bun
// Import channels from Are.na into Local Arena vault.
// Usage: bun run scripts/import-arena.ts <vault_path>

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const VAULT_PATH = process.argv[2] || "/Users/i_iii/Desktop/Тест";
const ARENA_API = "https://api.are.na/v2";
const THUMB_MAX = 240;

// Channels to import (slug -> title)
const CHANNELS: Record<string, string> = {
  "comma-lsu1rhwrpoe": "Бумага, книги и типографика",
  "trath7qinim": "Одежда",
  "wtqxv_sni6w": "Интерфейсы",
  "ii6wjsxdz1q": "Красивый веб",
  "comma-ufrmtdeewas": "Города, здания и обитаемые пространства",
  "bnvagttakyk": "Странные миры",
  "ascii-vokxnkmfzy0": "Пиксельарт и ascii",
  "nsv1_kaei68": "Периферия",
  "6izuigv5cge": "Поверхности и текстуры",
};

interface ArenaBlock {
  id: number;
  title: string | null;
  description: string | null;
  content: string | null;
  source: { url: string } | null;
  image: { original: { url: string }; thumb: { url: string } } | null;
  attachment: { url: string; file_name: string } | null;
  class: string; // "Image", "Link", "Text", "Media", "Attachment"
  created_at: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "untitled";
}

function uniqueSlug(base: string, existing: Set<string>): string {
  if (!existing.has(base)) {
    existing.add(base);
    return base;
  }
  let i = 2;
  while (existing.has(`${base}-${i}`)) i++;
  const slug = `${base}-${i}`;
  existing.add(slug);
  return slug;
}

function mapBlockType(arenaClass: string): string {
  switch (arenaClass) {
    case "Image": return "image";
    case "Link": return "link";
    case "Text": return "article";
    case "Media": return "video";
    case "Attachment": return "file";
    default: return "link";
  }
}

async function downloadFile(url: string, dest: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return false;
    const buffer = await res.arrayBuffer();
    writeFileSync(dest, Buffer.from(buffer));
    return true;
  } catch {
    return false;
  }
}

function getExtFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split(".").pop()?.toLowerCase();
    if (ext && ext.length <= 5 && ext.match(/^[a-z0-9]+$/)) return ext;
  } catch {}
  return "jpg";
}

async function fetchChannel(slug: string): Promise<ArenaBlock[]> {
  const blocks: ArenaBlock[] = [];
  let page = 1;
  const per = 50;

  while (true) {
    const url = `${ARENA_API}/channels/${slug}/contents?page=${page}&per=${per}`;
    console.log(`  Fetching page ${page}...`);

    const res = await fetch(url);
    if (!res.ok) {
      console.log(`  Error: ${res.status}`);
      break;
    }

    const data = await res.json();
    const contents = data.contents || [];

    for (const item of contents) {
      // Skip channels (connected channels show up in contents)
      if (item.base_class === "Channel" || item.class === "Channel") continue;
      blocks.push(item);
    }

    if (contents.length < per) break;
    page++;
    // Rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  return blocks;
}

async function importBlock(
  block: ArenaBlock,
  tags: string[],
  existingSlugs: Set<string>,
): Promise<void> {
  const titleText = block.title || `arena-${block.id}`;
  const slug = uniqueSlug(slugify(titleText), existingSlugs);
  const blockType = mapBlockType(block.class);

  let mediaFile: string | null = null;
  let thumbnailFile: string | null = null;

  // Download image/media
  if (block.class === "Image" && block.image?.original?.url) {
    const ext = getExtFromUrl(block.image.original.url);
    mediaFile = `${slug}.${ext}`;
    const dest = join(VAULT_PATH, mediaFile);
    const ok = await downloadFile(block.image.original.url, dest);
    if (!ok) {
      console.log(`    Failed to download image for ${slug}`);
      mediaFile = null;
    }
  } else if (block.class === "Attachment" && block.attachment?.url) {
    const ext = getExtFromUrl(block.attachment.url);
    mediaFile = `${slug}.${ext}`;
    const dest = join(VAULT_PATH, mediaFile);
    const ok = await downloadFile(block.attachment.url, dest);
    if (!ok) mediaFile = null;
  }

  // Download thumbnail for links
  if (block.class === "Link" && block.image?.thumb?.url) {
    const ext = getExtFromUrl(block.image.thumb.url);
    thumbnailFile = `${slug}-thumb.${ext}`;
    const dest = join(VAULT_PATH, thumbnailFile);
    const ok = await downloadFile(block.image.thumb.url, dest);
    if (!ok) thumbnailFile = null;
  }

  // Build frontmatter
  const fm: Record<string, unknown> = { type: blockType };
  if (block.title) fm.title = block.title;
  if (block.description) fm.description = block.description;
  if (block.source?.url) fm.url = block.source.url;
  if (mediaFile) fm.file = mediaFile;
  if (thumbnailFile) fm.thumbnail = thumbnailFile;
  fm.tags = tags;

  // Parse date
  const savedAt = block.created_at
    ? new Date(block.created_at).toISOString().replace(/\.\d+Z$/, "Z")
    : new Date().toISOString().replace(/\.\d+Z$/, "Z");
  fm.saved_at = savedAt;
  fm.source = "arena-import";

  // Serialize frontmatter
  const lines = ["---"];
  for (const [key, value] of Object.entries(fm)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map(v => String(v)).join(", ")}]`);
    } else if (typeof value === "string" && (value.includes(":") || value.includes('"') || value.includes("'"))) {
      lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");

  // Body
  const body = block.class === "Text" && block.content ? `\n${block.content}` : "";

  const content = lines.join("\n") + body + "\n";
  const mdPath = join(VAULT_PATH, `${slug}.md`);
  writeFileSync(mdPath, content);
}

async function main() {
  console.log(`Vault: ${VAULT_PATH}`);
  console.log(`Channels: ${Object.keys(CHANNELS).length}`);
  console.log("");

  const existingSlugs = new Set<string>();
  let totalBlocks = 0;
  let totalDownloads = 0;

  for (const [slug, title] of Object.entries(CHANNELS)) {
    console.log(`[${title}] (${slug})`);

    // Normalize tag from channel title
    const tag = title.toLowerCase().replace(/[,\s]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

    let blocks: ArenaBlock[];
    try {
      blocks = await fetchChannel(slug);
    } catch (e) {
      console.log(`  Error fetching channel: ${e}`);
      continue;
    }

    console.log(`  Found ${blocks.length} blocks`);

    for (const block of blocks) {
      try {
        await importBlock(block, [tag], existingSlugs);
        totalBlocks++;
        if (block.class === "Image" || block.class === "Attachment") totalDownloads++;
      } catch (e) {
        console.log(`  Error importing block ${block.id}: ${e}`);
      }
      // Rate limit downloads
      if (block.class === "Image" || block.class === "Link") {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    console.log(`  Imported ${blocks.length} blocks`);
    console.log("");
  }

  console.log(`Done! Total: ${totalBlocks} blocks, ${totalDownloads} media files`);
  console.log(`Run the app and select vault: ${VAULT_PATH}`);
}

main().catch(console.error);
