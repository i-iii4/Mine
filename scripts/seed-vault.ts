#!/usr/bin/env bun
// Seed a vault with test blocks of all types for UI testing.
// Usage: bun run scripts/seed-vault.ts <vault_path>

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const VAULT = process.argv[2] || "/Users/i_iii/Desktop/Тест";

interface TestBlock {
  slug: string;
  type: string;
  title: string;
  tags: string[];
  url?: string;
  file?: string;
  description?: string;
  author?: string;
  body?: string;
  width?: number;
  height?: number;
}

const BLOCKS: TestBlock[] = [
  // Links
  { slug: "stripe-homepage", type: "link", title: "Stripe — Financial Infrastructure", tags: ["web-design", "fintech"], url: "https://stripe.com", description: "Financial infrastructure for the internet" },
  { slug: "linear-app", type: "link", title: "Linear — Plan and build products", tags: ["web-design", "tools"], url: "https://linear.app", description: "Streamline software projects, sprints, tasks, and bug tracking" },
  { slug: "are-na-platform", type: "link", title: "Are.na — Visual bookmarking", tags: ["tools", "inspiration"], url: "https://are.na", description: "Save and organize the content that inspires you" },
  { slug: "vercel-platform", type: "link", title: "Vercel — Build and deploy the best Web", tags: ["web-design", "tools"], url: "https://vercel.com", description: "Frontend cloud platform" },
  { slug: "cosmos-so", type: "link", title: "Cosmos — Visual bookmarking with AI", tags: ["tools", "inspiration"], url: "https://cosmos.so", description: "Organize your inspiration with visual AI" },
  { slug: "mymind-app", type: "link", title: "mymind — The extension for your mind", tags: ["tools", "inspiration"], url: "https://mymind.com", description: "Save anything, find it later" },
  { slug: "obsidian-md", type: "link", title: "Obsidian — A second brain", tags: ["tools", "knowledge"], url: "https://obsidian.md", description: "Private and flexible writing app" },
  { slug: "figma-design", type: "link", title: "Figma — Design tool for teams", tags: ["web-design", "tools"], url: "https://figma.com" },

  // Articles
  { slug: "local-first-software", type: "article", title: "Local-first software: You own your data", tags: ["programming", "architecture"], url: "https://www.inkandswitch.com/local-first/", author: "Ink & Switch", body: "Cloud apps like Google Docs and Trello are popular because they enable real-time collaboration with colleagues, and they make it easy for us to access our work from all of our devices.\n\nHowever, by centralizing data storage on servers, cloud apps also take away ownership and agency from users. If a service shuts down, the software stops functioning, and data created with that software is lost.\n\nIn this article we propose local-first software: a set of principles for software that enables both collaboration and ownership for users." },
  { slug: "crdt-explained", type: "article", title: "An introduction to CRDTs", tags: ["programming", "distributed-systems"], author: "Lars Hupel", body: "CRDTs (Conflict-free Replicated Data Types) are data structures that can be replicated across multiple computers in a network. They have a mathematically proven property: replicas can be updated independently and concurrently without coordination between the replicas, and it is always mathematically possible to resolve inconsistencies." },
  { slug: "tauri-vs-electron", type: "article", title: "Tauri vs Electron: a comparison", tags: ["programming", "tools"], body: "Tauri applications are built with a Rust backend and use the operating system's native WebView for rendering. This means significantly smaller bundle sizes (3-6 MB vs 150+ MB), lower memory usage, and better performance.\n\nElectron bundles Chromium, which provides consistent rendering across platforms but at a significant cost in terms of size and resources.\n\nFor macOS-first applications, Tauri is the clear winner." },
  { slug: "design-systems-guide", type: "article", title: "Building a design system from scratch", tags: ["web-design", "typography"], author: "Nathan Curtis", body: "A design system is a collection of reusable components, guided by clear standards, that can be assembled together to build any number of applications.\n\nStart with tokens: colors, spacing, typography. Then build atoms: buttons, inputs, labels. Molecules come next: search bars, cards, navigation items. Finally, organisms: headers, footers, complex forms.\n\nThe key is consistency and documentation." },
  { slug: "brutalist-web-design", type: "article", title: "Brutalist Web Design", tags: ["web-design", "architecture"], url: "https://brutalistwebdesign.com", body: "Raw content true to its construction. Websites that offer no apologies for lack of visual polish or design sophistication.\n\nBrutalist web design challenges the expectation that websites should conform to established visual standards." },

  // Images (we create colored SVG placeholders)
  { slug: "tokyo-sunset", type: "image", title: "Sunset in Tokyo", tags: ["photography", "japan"], width: 1920, height: 1280 },
  { slug: "brutalist-building", type: "image", title: "Barbican Centre, London", tags: ["architecture", "photography"], width: 1600, height: 2400 },
  { slug: "swiss-typography", type: "image", title: "Swiss International Style poster", tags: ["typography", "graphic-design"], width: 1200, height: 1600 },
  { slug: "pixel-cityscape", type: "image", title: "Pixel art cityscape", tags: ["pixel-art", "inspiration"], width: 800, height: 600 },
  { slug: "terminal-aesthetic", type: "image", title: "Terminal aesthetic", tags: ["pixel-art", "tools"], width: 1920, height: 1080 },
  { slug: "paper-texture", type: "image", title: "Handmade paper texture", tags: ["typography", "texture"], width: 2000, height: 2000 },
  { slug: "kyoto-garden", type: "image", title: "Zen garden in Kyoto", tags: ["japan", "photography"], width: 2400, height: 1600 },
  { slug: "concrete-surface", type: "image", title: "Raw concrete surface", tags: ["architecture", "texture"], width: 1800, height: 1200 },

  // Videos
  { slug: "design-talk-2026", type: "video", title: "The Future of Design Tools", tags: ["web-design", "tools"], url: "https://youtube.com/watch?v=example1" },
  { slug: "tokyo-walk", type: "video", title: "Walking through Shibuya at night", tags: ["japan", "photography"], url: "https://youtube.com/watch?v=example2" },

  // Files
  { slug: "design-systems-book", type: "file", title: "Design Systems Handbook", tags: ["web-design", "typography"] },
  { slug: "color-palette-ase", type: "file", title: "Brutalist color palette", tags: ["web-design", "graphic-design"] },
];

function createColorSvg(width: number, height: number, hue: number): string {
  const bg = `hsl(${hue}, 30%, 20%)`;
  const fg = `hsl(${hue}, 40%, 60%)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${bg}"/>
  <circle cx="${width/2}" cy="${height/2}" r="${Math.min(width, height) * 0.3}" fill="${fg}" opacity="0.5"/>
  <rect x="${width*0.1}" y="${height*0.1}" width="${width*0.3}" height="${height*0.3}" fill="${fg}" opacity="0.3"/>
</svg>`;
}

function buildFrontmatter(block: TestBlock): string {
  const lines = ["---"];
  lines.push(`type: ${block.type}`);
  if (block.title) lines.push(`title: ${block.title}`);
  if (block.description) lines.push(`description: ${block.description}`);
  if (block.url) lines.push(`url: ${block.url}`);
  if (block.file) lines.push(`file: ${block.file}`);
  if (block.author) lines.push(`author: ${block.author}`);
  if (block.width) lines.push(`width: ${block.width}`);
  if (block.height) lines.push(`height: ${block.height}`);
  lines.push(`tags: [${block.tags.join(", ")}]`);
  lines.push(`saved_at: ${new Date(Date.now() - Math.random() * 30 * 86400000).toISOString().replace(/\.\d+Z$/, "Z")}`);
  lines.push(`source: seed-script`);
  lines.push("---");
  return lines.join("\n");
}

function main() {
  console.log(`Seeding vault: ${VAULT}`);
  mkdirSync(join(VAULT, ".arena", "cache", "thumbs"), { recursive: true });

  let imageIdx = 0;
  for (const block of BLOCKS) {
    // Write .md
    const fm = buildFrontmatter({
      ...block,
      file: block.type === "image" ? `${block.slug}.svg` :
            block.type === "file" ? `${block.slug}.pdf` :
            block.file,
    });
    const body = block.body ? `\n${block.body}\n` : "\n";
    writeFileSync(join(VAULT, `${block.slug}.md`), fm + body);

    // Create placeholder media for images
    if (block.type === "image" && block.width && block.height) {
      const hue = (imageIdx * 47) % 360;
      const svg = createColorSvg(block.width, block.height, hue);
      writeFileSync(join(VAULT, `${block.slug}.svg`), svg);
      imageIdx++;
    }

    // Create placeholder for files
    if (block.type === "file") {
      writeFileSync(join(VAULT, `${block.slug}.pdf`), `%PDF-1.4 placeholder for ${block.title}`);
    }

    console.log(`  ${block.type.padEnd(7)} ${block.slug}`);
  }

  console.log(`\nDone! Created ${BLOCKS.length} blocks in ${VAULT}`);
  console.log("Restart the app or re-select the vault to see them.");
}

main();
