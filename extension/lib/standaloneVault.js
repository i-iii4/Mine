// Standalone writing: the clipper saves to disk with no app installed.
//
// The extension owns a directory handle the user granted once
// (File System Access API); clips become the same files the native host would
// have written — same layout, same frontmatter, same naming — so the app's
// first launch picks them up with an ordinary folder scan and nothing has to
// migrate. Everything here mirrors the Rust side field for field; where the
// two could drift, the Rust file is named so the drift has an address.
// See SPEC_ONBOARDING.md О1–О4.
//
// Runs in the background service worker (writes, via the handle stored in
// IndexedDB) and in the popup window (folder picking, which needs a user
// gesture and a window). Classic-script + globalThis export, like every other
// file in lib/.

(function (root) {
  "use strict";

  const DB_NAME = "mine-standalone";
  const STORE = "vault";
  const HANDLE_KEY = "directory";

  const MAX_FILENAME_STEM_CHARS = 100;

  // ── Pure formatting, mirrors src-tauri/src/domain/block.rs ────────────────

  /** Mirror of `sanitize_for_filename`. */
  function sanitizeForFilename(raw) {
    const normalized = String(raw ?? "").normalize("NFC");
    let result = "";
    let prevSpace = false;
    for (const c of normalized) {
      if ("/\\:*?\"<>|\0".includes(c)) {
        if (!prevSpace) {
          result += " ";
          prevSpace = true;
        }
      } else if (/\s/.test(c)) {
        if (!prevSpace) {
          result += " ";
          prevSpace = true;
        }
      } else if (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) {
        continue;
      } else {
        result += c;
        prevSpace = false;
      }
    }
    const trimmed = result.replace(/^[ .]+|[ .]+$/g, "");
    const truncated = Array.from(trimmed).slice(0, MAX_FILENAME_STEM_CHARS).join("").trimEnd();
    return truncated === "" ? "Untitled" : truncated;
  }

  /** Mirror of `suggest_slug`. */
  function suggestSlug(title, url) {
    let raw;
    if (title && title.trim() !== "") {
      raw = title;
    } else if (url) {
      raw = url.replace(/^https:\/\//, "").replace(/^http:\/\//, "");
    } else {
      return "Untitled";
    }
    return sanitizeForFilename(raw);
  }

  /** Mirror of `resolve_slug_conflict`: `Name`, then `Name (2)` … `Name (1000)`. */
  function resolveNameConflict(name, existingLowercase) {
    if (!existingLowercase.has(name.toLowerCase())) return name;
    for (let n = 2; n <= 1000; n += 1) {
      const candidate = `${name} (${n})`;
      if (!existingLowercase.has(candidate.toLowerCase())) return candidate;
    }
    throw new Error(`no free name for "${name}"`);
  }

  /** Mirror of `yaml_quote`. */
  function yamlQuote(s) {
    const needsQuoting =
      s.includes(": ") ||
      s.includes(" #") ||
      s.includes("[") ||
      s.includes("]") ||
      s.includes("{") ||
      s.includes("}") ||
      s.includes(",") ||
      s.includes('"') ||
      s.includes("'") ||
      s.startsWith(" ") ||
      s.endsWith(" ") ||
      s.startsWith("#") ||
      s.startsWith("&") ||
      s.startsWith("*") ||
      s.startsWith("!") ||
      s.startsWith("|") ||
      s.startsWith(">") ||
      s.startsWith("%") ||
      s.startsWith("@") ||
      s.startsWith("`") ||
      s === "";
    if (!needsQuoting) return s;
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  /** `saved_at` the way the host writes it: second precision, Z suffix. */
  function nowSavedAt() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  /**
   * Mirror of `serialize_frontmatter` for the fields a clip carries, in the
   * same order: type, title, url, file, Mine Collections, saved_at, source,
   * author. `source: web-clipper` matches what the native host stamps, so
   * files are indistinguishable regardless of which path wrote them.
   */
  function serializeFrontmatter(fm) {
    const lines = [`type: ${fm.type}`];
    if (fm.title) lines.push(`title: ${yamlQuote(fm.title)}`);
    if (fm.url) lines.push(`url: ${yamlQuote(fm.url)}`);
    if (fm.file) lines.push(`file: ${yamlQuote(`[[${fm.file}]]`)}`);
    if (fm.tags && fm.tags.length > 0) {
      lines.push("Mine Collections:");
      for (const tag of fm.tags) {
        lines.push(`  - ${yamlQuote(`[[${tag}]]`)}`);
      }
    }
    lines.push(`saved_at: ${fm.saved_at}`);
    lines.push("source: web-clipper");
    if (fm.author) lines.push(`author: ${yamlQuote(fm.author)}`);
    return lines.join("\n");
  }

  /** Mirror of `serialize_block`: frontmatter fences plus optional body. */
  function buildMarkdown(fm, body) {
    const yaml = serializeFrontmatter(fm);
    const trimmedBody = (body ?? "").replace(/\n{3,}/g, "\n\n");
    if (trimmedBody === "") return `---\n${yaml}\n---\n`;
    return `---\n${yaml}\n---\n${trimmedBody}`;
  }

  /** File extension for a downloaded media blob, content type first. */
  function mediaExtension(contentType, url) {
    const byType = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/avif": "avif",
      "image/heic": "heic",
      "video/mp4": "mp4",
      "video/webm": "webm",
    }[String(contentType ?? "").split(";")[0].trim().toLowerCase()];
    if (byType) return byType;
    const match = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(url ?? "");
    if (match) return match[1].toLowerCase();
    return "jpg";
  }

  // ── Handle persistence ────────────────────────────────────────────────────

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function storeDirectoryHandle(handle) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(handle, HANDLE_KEY);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadDirectoryHandle() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const get = tx.objectStore(STORE).get(HANDLE_KEY);
      get.onsuccess = () => resolve(get.result ?? null);
      get.onerror = () => reject(get.error);
    });
  }

  async function clearDirectoryHandle() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(HANDLE_KEY);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
  }

  // ── Layout, mirrors src-tauri/src/domain/vault.rs VaultWriteLayout ────────

  const STANDARD_LAYOUT = { cards: "Cards", media: "Media", collections: "Collections" };
  const FLAT_LAYOUT = { cards: "", media: "", collections: "" };

  async function directoryExists(dir, name) {
    try {
      await dir.getDirectoryHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  async function readLayoutFile(dir) {
    try {
      const mine = await dir.getDirectoryHandle(".mine");
      const file = await (await mine.getFileHandle("layout.json")).getFile();
      const parsed = JSON.parse(await file.text());
      if (
        typeof parsed.cards === "string" &&
        typeof parsed.media === "string" &&
        typeof parsed.collections === "string"
      ) {
        return { cards: parsed.cards, media: parsed.media, collections: parsed.collections };
      }
    } catch {
      // No stored layout — fall through to detection.
    }
    return null;
  }

  async function directoryHasEntries(dir) {
    for await (const [name] of dir.entries()) {
      if (!name.startsWith(".")) return true;
    }
    return false;
  }

  /**
   * The stored layout wins; otherwise all three folders mean standard, any
   * other non-empty folder means flat — the same reading the app applies. An
   * empty folder becomes a standard vault, and the choice is written to
   * `.mine/layout.json` so the app later agrees without re-deriving it.
   */
  async function resolveLayout(dir) {
    const stored = await readLayoutFile(dir);
    if (stored) return stored;

    const [cards, media, collections] = await Promise.all([
      directoryExists(dir, STANDARD_LAYOUT.cards),
      directoryExists(dir, STANDARD_LAYOUT.media),
      directoryExists(dir, STANDARD_LAYOUT.collections),
    ]);
    if (cards && media && collections) return STANDARD_LAYOUT;
    if (await directoryHasEntries(dir)) return FLAT_LAYOUT;

    await dir.getDirectoryHandle(STANDARD_LAYOUT.cards, { create: true });
    await dir.getDirectoryHandle(STANDARD_LAYOUT.media, { create: true });
    await dir.getDirectoryHandle(STANDARD_LAYOUT.collections, { create: true });
    const mine = await dir.getDirectoryHandle(".mine", { create: true });
    const layoutFile = await mine.getFileHandle("layout.json", { create: true });
    const writable = await layoutFile.createWritable();
    await writable.write(JSON.stringify(STANDARD_LAYOUT, null, 2));
    await writable.close();
    return STANDARD_LAYOUT;
  }

  async function subdirectory(dir, name, create) {
    if (name === "") return dir;
    return dir.getDirectoryHandle(name, { create: Boolean(create) });
  }

  /**
   * Names already taken, lowercased. Card stems, collection stems and media
   * stems all share one namespace, the same way the host's stem inventory
   * treats them: a media file is named after its card.
   */
  async function existingStems(dir, layout) {
    const stems = new Set();
    const folders = new Set([layout.cards, layout.media, layout.collections, ""]);
    for (const folder of folders) {
      let handle;
      try {
        handle = await subdirectory(dir, folder, false);
      } catch {
        continue;
      }
      for await (const [name, entry] of handle.entries()) {
        if (entry.kind !== "file" || name.startsWith(".")) continue;
        const stem = name.replace(/\.[^.]+$/, "");
        if (stem !== "") stems.add(stem.toLowerCase());
      }
    }
    return stems;
  }

  async function writeFile(dir, layout, folder, fileName, data) {
    const target = await subdirectory(dir, folder, true);
    const fileHandle = await target.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  // ── Status and save ───────────────────────────────────────────────────────

  /** The granted directory: injected by tests, loaded from IndexedDB in life. */
  async function resolveHandle(options) {
    if (options && options.directory) return options.directory;
    return loadDirectoryHandle();
  }

  /** What the popup needs to decide the mode. Never throws. */
  async function getStandaloneStatus(options) {
    try {
      const handle = await resolveHandle(options);
      if (!handle) return { configured: false };
      const permission = await handle.queryPermission({ mode: "readwrite" });
      return { configured: true, folderName: handle.name, permission };
    } catch (error) {
      return { configured: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * Save a clip with no app installed. Takes the same request the native
   * host's `save_block` takes, so the popup builds one payload and picks a
   * road. Media first, then the card that references it: a card pointing at a
   * file that failed to arrive would be a broken clip, the reverse is only an
   * orphan file.
   */
  async function saveStandaloneBlock(request, options) {
    const handle = await resolveHandle(options);
    if (!handle) return { ok: false, error: "No folder chosen for saving" };
    const permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      return { ok: false, error: "Folder access expired — choose the folder again" };
    }

    const layout = await resolveLayout(handle);
    const stems = await existingStems(handle, layout);
    const name = resolveNameConflict(suggestSlug(request.title, request.url), stems);

    let mediaRef = null;
    if (request.screenshot_data_url) {
      const blob = await (await fetch(request.screenshot_data_url)).blob();
      const ext = mediaExtension(blob.type, null);
      mediaRef = `${name}.${ext}`;
      await writeFile(handle, layout, layout.media, mediaRef, blob);
    } else if (request.image_url) {
      const fetcher = options?.fetch ?? fetch;
      const response = await fetcher(request.image_url);
      if (!response.ok) {
        return { ok: false, error: `Image download failed: HTTP ${response.status}` };
      }
      const blob = await response.blob();
      const ext = mediaExtension(
        response.headers?.get ? response.headers.get("content-type") : blob.type,
        request.image_url,
      );
      mediaRef = `${name}.${ext}`;
      await writeFile(handle, layout, layout.media, mediaRef, blob);
    }

    const markdown = buildMarkdown(
      {
        type: request.block_type,
        title: request.title || null,
        url: request.url || null,
        file: mediaRef,
        tags: request.tags ?? [],
        saved_at: nowSavedAt(),
        author: request.author || null,
      },
      request.body ?? "",
    );
    await writeFile(handle, layout, layout.cards, `${name}.md`, markdown);
    return { ok: true, slug: name, standalone: true };
  }

  /** Collections are their own documents; a clip's tags alone do not create them. */
  async function createStandaloneChannel(tag, options) {
    const handle = await resolveHandle(options);
    if (!handle) return { ok: false, error: "No folder chosen for saving" };
    const layout = await resolveLayout(handle);
    const stems = await existingStems(handle, layout);
    const name = resolveNameConflict(sanitizeForFilename(tag), stems);
    const markdown = `---\ntype: channel\nsaved_at: ${nowSavedAt()}\n---\n`;
    await writeFile(handle, layout, layout.collections, `${name}.md`, markdown);
    return { ok: true, tag: name };
  }

  /** Collection documents on disk; counts are not known without an index. */
  async function listStandaloneChannels(options) {
    const handle = await resolveHandle(options);
    if (!handle) return { ok: false, error: "No folder chosen for saving" };
    const layout = await resolveLayout(handle);
    const channels = [];
    let folder;
    try {
      folder = await subdirectory(handle, layout.collections, false);
    } catch {
      return { ok: true, channels };
    }
    for await (const [name, entry] of folder.entries()) {
      if (entry.kind !== "file" || !name.endsWith(".md") || name.startsWith(".")) continue;
      channels.push({ tag: name.replace(/\.md$/, ""), block_count: 0 });
    }
    channels.sort((a, b) => a.tag.localeCompare(b.tag));
    return { ok: true, channels };
  }

  root.MineStandaloneVault = {
    // Pure, unit-tested.
    sanitizeForFilename,
    suggestSlug,
    resolveNameConflict,
    yamlQuote,
    serializeFrontmatter,
    buildMarkdown,
    mediaExtension,
    // Handle store.
    storeDirectoryHandle,
    loadDirectoryHandle,
    clearDirectoryHandle,
    // Vault operations.
    resolveLayout,
    existingStems,
    getStandaloneStatus,
    saveStandaloneBlock,
    createStandaloneChannel,
    listStandaloneChannels,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
