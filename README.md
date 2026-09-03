# Mine

> A local-first alternative to Are.na for visual bookmarking. Your collections live as plain files on disk — Markdown + media — not in someone else's cloud.

![Mine](docs/mine.png)

**Mine** is a macOS desktop app for visually collecting and organizing what you find on the web: images, articles, links, videos. Everything is stored as flat Markdown files with frontmatter in a folder you choose. Collections are Obsidian-compatible pages, and membership is plain wikilinks. No cloud, no Electron, no lock-in.

## Why

- **You own your data.** Every block is a Markdown file plus an optional media file on your disk. Open it in Obsidian, grep it, back it up, sync it through iCloud — it is just files.
- **Built for scale.** A custom virtualized masonry grid stays smooth at 10,000+ blocks.
- **Capture anywhere.** A Chrome/Safari web clipper saves pages, articles, tweets, and YouTube transcripts straight into your vault.

## Features

- Visual masonry grid with five adaptive card types: image, link, article, video, social
- Channels (collections) as Obsidian pages — counts, colors, drag-to-sort
- Web clipper (Chrome + Safari) with article extraction (Defuddle) over native messaging
- Full-text search across the vault (SQLite FTS5)
- One-click import from Are.na
- Two-phase thumbnails: instant native placeholder, async high-quality upgrade
- Obsidian-compatible storage: `.md` files and `![[wikilink]]` media, no proprietary IDs
- iOS companion app (SwiftUI + a shared Rust core via UniFFI) — early

## Stack

Tauri v2 · Rust · SQLite (rusqlite + FTS5) · React 19 · TypeScript · TailwindCSS v4 · shadcn/ui

## Build

```bash
bun install
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.120 --locked
cargo tauri dev      # development build with HMR
cargo tauri build    # production .app / .dmg
bun run build:extension  # required extension bundle → extension/dist
```

`extension/dist/` and `extension/generated/save-core/` are generated and ignored by Git. The desktop build does not
build the browser extension; run `bun run build:extension` before loading the
unpacked `extension/` directory in Chrome or Dia.

Requires Rust ≥ 1.88, Node.js ≥ 22, Bun ≥ 1.2, and the Tauri CLI (`cargo install tauri-cli`).
The WebAssembly binding tool must match the pinned Rust dependency (0.2.120).
`bun run test:save-core` compares the same fixtures through native Rust and real WASM.

## Status

Active development (v0.1.0). The macOS desktop app is the primary target; the iOS app is early.

The shared save core is implemented in `mine-core`: native Rust and browser WASM
use one document model, serializer, naming policy and recovery decisions. The
browser adapter has no independent JavaScript save engine. Native capture does
not require a writable SQLite index. Desktop/CLI mutation rollback remains intact.

The stable development extension ID is `eioalidaccoahofcggkbinalibpajokh`.
The app installs the bundled runtime at
`~/Library/Application Support/com.mine.app/clipper/extension` and registers
its bundled helper on launch; load that stable folder once with `Load unpacked`.
`bun run clipper:install-host` updates both parts of a development installation.
A missing helper response does not mean
the app is uninstalled. Standalone setup opens an extension-origin window.

Implementation and verified acceptance are separate: see [acceptance report](docs/save-core-acceptance.md)
and [SC0–SC7](PLAN.md#save-core-plan). Manual Chrome/Dia folder-permission and
installation-order acceptance is still open; public store release is deferred.
Do not remove a previous unpacked extension with pending saves: a new extension
ID has separate browser storage, and pending state is not migrated automatically.
Resolve old pending outcomes **before launching the new app, repairing helper
registration, or running `clipper:install-host`**: these replace the old allowlist.
If an outcome is unknown, keep the old extension, helper and registration intact.

## License

[MIT](LICENSE) © 2026 Sergey Seleznev
