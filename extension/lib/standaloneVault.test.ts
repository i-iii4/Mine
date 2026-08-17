// The standalone writer's contract is byte-parity with the Rust side: a file
// written with no app installed must be indistinguishable from one the native
// host wrote. Format cases here are copied from the Rust tests they mirror
// (src-tauri/src/domain/block.rs), so a drift shows up as a failing pair.

import { beforeEach, describe, expect, it } from "vitest";

import "./standaloneVault.js";

type StandaloneVault = {
  sanitizeForFilename: (raw: string) => string;
  suggestSlug: (title: string | null, url: string | null) => string;
  resolveNameConflict: (name: string, existing: Set<string>) => string;
  yamlQuote: (s: string) => string;
  buildMarkdown: (fm: Record<string, unknown>, body: string) => string;
  mediaExtension: (contentType: string | null, url: string | null) => string;
  resolveLayout: (dir: unknown) => Promise<{ cards: string; media: string; collections: string }>;
  existingStems: (dir: unknown, layout: unknown) => Promise<Set<string>>;
  saveStandaloneBlock: (
    request: Record<string, unknown>,
    options?: { fetch?: typeof fetch },
  ) => Promise<{ ok: boolean; slug?: string; error?: string }>;
  loadDirectoryHandle: () => Promise<unknown>;
  storeDirectoryHandle: (handle: unknown) => Promise<void>;
};

const vault = (globalThis as Record<string, unknown>)
  .MineStandaloneVault as StandaloneVault;

// ── A faithful in-memory FileSystemDirectoryHandle ─────────────────────────

class FakeFile {
  constructor(public content: Uint8Array | string) {}
  text(): string {
    return typeof this.content === "string"
      ? this.content
      : new TextDecoder().decode(this.content);
  }
}

class FakeDirectory {
  kind = "directory" as const;
  files = new Map<string, FakeFile>();
  directories = new Map<string, FakeDirectory>();
  permission = "granted";

  constructor(public name: string) {}

  async queryPermission(): Promise<string> {
    return this.permission;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!options?.create) throw new DOMException("not found", "NotFoundError");
    const created = new FakeDirectory(name);
    this.directories.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException("not found", "NotFoundError");
      this.files.set(name, new FakeFile(""));
    }
    const file = this.files.get(name)!;
    return {
      kind: "file" as const,
      name,
      getFile: async () => ({ text: async () => file.text() }),
      createWritable: async () => {
        let buffer: Array<Uint8Array | string> = [];
        return {
          write: async (chunk: unknown) => {
            if (typeof chunk === "string") buffer.push(chunk);
            else if (chunk instanceof Blob) buffer.push(new Uint8Array(await chunk.arrayBuffer()));
            else buffer.push(chunk as Uint8Array);
          },
          close: async () => {
            const text = buffer
              .map((part) => (typeof part === "string" ? part : new TextDecoder().decode(part)))
              .join("");
            file.content = text;
          },
        };
      },
    };
  }

  async *entries(): AsyncGenerator<[string, { kind: string }]> {
    for (const [name] of this.files) yield [name, { kind: "file" }];
    for (const [name, dir] of this.directories) yield [name, dir];
  }
}

// The engine loads its handle from IndexedDB in life; tests inject a fake.
let fakeRoot: FakeDirectory;
const dir = () => ({ directory: fakeRoot });
beforeEach(() => {
  fakeRoot = new FakeDirectory("Mine");
});

// ── Format parity ──────────────────────────────────────────────────────────

describe("filename rules mirror the Rust side", () => {
  it("replaces reserved characters with single spaces and trims dots", () => {
    expect(vault.sanitizeForFilename('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
    expect(vault.sanitizeForFilename("  name...  ")).toBe("name");
    expect(vault.sanitizeForFilename("")).toBe("Untitled");
  });

  it("derives a slug from the title, then the url without its scheme", () => {
    expect(vault.suggestSlug("A Fine Article", null)).toBe("A Fine Article");
    expect(vault.suggestSlug(null, "https://example.com/path")).toBe("example.com path");
    expect(vault.suggestSlug(null, null)).toBe("Untitled");
  });

  it("resolves collisions with the host's numbered suffix", () => {
    const taken = new Set(["photo", "photo (2)"]);
    expect(vault.resolveNameConflict("Photo", taken)).toBe("Photo (3)");
    expect(vault.resolveNameConflict("Fresh", taken)).toBe("Fresh");
  });
});

describe("yaml quoting mirrors the Rust side", () => {
  it("quotes exactly what the Rust serializer quotes", () => {
    expect(vault.yamlQuote("plain title")).toBe("plain title");
    expect(vault.yamlQuote("a: b")).toBe('"a: b"');
    expect(vault.yamlQuote("[[wiki]]")).toBe('"[[wiki]]"');
    expect(vault.yamlQuote('he said "hi"')).toBe('"he said \\"hi\\""');
    expect(vault.yamlQuote("#lead")).toBe('"#lead"');
    expect(vault.yamlQuote("")).toBe('""');
  });
});

describe("markdown output", () => {
  it("writes the host's field order with wikilinked file and collections", () => {
    const markdown = vault.buildMarkdown(
      {
        type: "image",
        title: "Sunset",
        url: "https://example.com/post",
        file: "Sunset.jpg",
        tags: ["moods"],
        saved_at: "2026-08-16T10:00:00Z",
        author: null,
      },
      "",
    );
    expect(markdown).toBe(
      [
        "---",
        "type: image",
        "title: Sunset",
        "url: https://example.com/post",
        'file: "[[Sunset.jpg]]"',
        "Mine Collections:",
        '  - "[[moods]]"',
        "saved_at: 2026-08-16T10:00:00Z",
        "source: web-clipper",
        "---",
        "",
      ].join("\n"),
    );
  });

  it("appends the body after the fences when present", () => {
    const markdown = vault.buildMarkdown(
      { type: "article", title: null, url: null, file: null, tags: [], saved_at: "2026-08-16T10:00:00Z", author: null },
      "Body text.",
    );
    expect(markdown.endsWith("---\nBody text.")).toBe(true);
  });
});

// ── Vault behaviour ────────────────────────────────────────────────────────

describe("layout resolution mirrors the app", () => {
  it("creates the standard layout in an empty folder and records it", async () => {
    const layout = await vault.resolveLayout(fakeRoot);
    expect(layout).toEqual({ cards: "Cards", media: "Media", collections: "Collections" });
    const mine = await fakeRoot.getDirectoryHandle(".mine");
    const recorded = JSON.parse(mine.files.get("layout.json")!.text());
    expect(recorded.cards).toBe("Cards");
  });

  it("writes flat into a folder that already has loose files", async () => {
    fakeRoot.files.set("note.md", new FakeFile("x"));
    const layout = await vault.resolveLayout(fakeRoot);
    expect(layout).toEqual({ cards: "", media: "", collections: "" });
  });

  it("prefers the layout the app recorded over detection", async () => {
    const mine = new FakeDirectory(".mine");
    mine.files.set(
      "layout.json",
      new FakeFile(JSON.stringify({ cards: "Notes", media: "Files", collections: "Sets" })),
    );
    fakeRoot.directories.set(".mine", mine);
    const layout = await vault.resolveLayout(fakeRoot);
    expect(layout.cards).toBe("Notes");
  });
});

describe("saving a clip with no app installed", () => {
  it("writes the card into Cards and the image into Media, media first", async () => {
    const fetched: string[] = [];
    const result = await vault.saveStandaloneBlock(
      {
        block_type: "image",
        title: "Sunset",
        url: "https://example.com/post",
        image_url: "https://example.com/sunset.jpg",
        tags: ["moods"],
        body: "",
      },
      {
        ...dir(),
        fetch: (async (url: string) => {
          fetched.push(url);
          return {
            ok: true,
            headers: { get: () => "image/jpeg" },
            blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
          };
        }) as unknown as typeof fetch,
      },
    );

    expect(result).toMatchObject({ ok: true, slug: "Sunset" });
    expect(fetched).toEqual(["https://example.com/sunset.jpg"]);

    const cards = await fakeRoot.getDirectoryHandle("Cards");
    const markdown = cards.files.get("Sunset.md")!.text();
    expect(markdown).toContain('file: "[[Sunset.jpg]]"');
    expect(markdown).toContain("source: web-clipper");
    const media = await fakeRoot.getDirectoryHandle("Media");
    expect(media.files.has("Sunset.jpg")).toBe(true);
  });

  it("numbers the clip when the stem is already taken anywhere in the vault", async () => {
    await vault.resolveLayout(fakeRoot);
    const cards = await fakeRoot.getDirectoryHandle("Cards");
    cards.files.set("Sunset.md", new FakeFile("existing"));

    const result = await vault.saveStandaloneBlock(
      {
        block_type: "link",
        title: "Sunset",
        url: "https://example.com",
        body: "",
      },
      dir(),
    );

    expect(result).toMatchObject({ ok: true, slug: "Sunset (2)" });
    expect(cards.files.has("Sunset (2).md")).toBe(true);
    expect(cards.files.get("Sunset.md")!.text()).toBe("existing");
  });

  it("refuses to write when the folder permission expired", async () => {
    fakeRoot.permission = "prompt";
    const result = await vault.saveStandaloneBlock(
      {
        block_type: "link",
        title: "Anything",
        body: "",
      },
      dir(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("choose the folder again");
  });

  it("does not leave a card behind when the image download fails", async () => {
    const result = await vault.saveStandaloneBlock(
      {
        block_type: "image",
        title: "Broken",
        image_url: "https://example.com/broken.jpg",
        body: "",
      },
      {
        ...dir(),
        fetch: (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch,
      },
    );

    expect(result.ok).toBe(false);
    const cards = await fakeRoot.getDirectoryHandle("Cards");
    expect(cards.files.has("Broken.md")).toBe(false);
  });
});
