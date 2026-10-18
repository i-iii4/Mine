import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { preprocessWikilinks } from "@/lib/markdownWikilinks";
import {
  MEDIA_LINK_EXTENSIONS,
  NOTE_EMBED_FRAGMENT_PROPERTY,
  NOTE_EMBED_LABEL_PROPERTY,
  NOTE_EMBED_PROPERTY,
  noteEmbedTarget,
} from "./remarkNoteEmbeds";
import { hastElementsNamed, readingHast } from "@/test/readingPipeline";

/** The strings of a Rust `&[&str]` constant. */
function rustStrings(source: string, name: string): string[] {
  const match = new RegExp(`${name}: &\\[&str\\] = &\\[([^\\]]*)\\]`).exec(source);
  if (!match?.[1]) throw new Error(`${name} is not a list of strings`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1] ?? "");
}

function embeds(body: string) {
  return hastElementsNamed(readingHast(preprocessWikilinks(body)), "span")
    .filter((span) => span.properties?.[NOTE_EMBED_PROPERTY] !== undefined)
    .map((span) => span.properties);
}

// SPEC_READING_MODE.md, Ч11.1.
describe("noteEmbedTarget", () => {
  it.each([
    ["Note", { note: "Note", fragment: null }],
    ["Note.md", { note: "Note.md", fragment: null }],
    ["Notes/Peer", { note: "Notes/Peer", fragment: null }],
    ["Meeting 18.10.2026", { note: "Meeting 18.10.2026", fragment: null }],
    ["Note#Heading", { note: "Note", fragment: "Heading" }],
    ["Note#^block", { note: "Note", fragment: "^block" }],
  ])("reads %s as a note", (target, expected) => {
    expect(noteEmbedTarget(target)).toEqual(expected);
  });

  it.each([
    "photo.jpg",
    "clip.MP4",
    "Graph #td (video 1).mp4",
    "song.mp3",
    "paper.pdf",
    "board.canvas",
    "table.base",
    "https://example.com/page",
    "#heading",
    "",
  ])("leaves %s to the picture path", (target) => {
    expect(noteEmbedTarget(target)).toBeNull();
  });

  it("knows the core's extensions of media and files", () => {
    const block = readFileSync("mine-core/src/domain/block.rs", "utf8");
    const links = readFileSync("mine-core/src/links.rs", "utf8");
    const core = [
      ...rustStrings(block, "IMAGE_MEDIA_EXTS"),
      ...rustStrings(block, "VIDEO_MEDIA_EXTS"),
      ...rustStrings(links, "FILE_EXTENSIONS").filter((extension) => extension !== "md"),
    ];
    expect([...MEDIA_LINK_EXTENSIONS].sort()).toEqual(core.sort());
  });
});

describe("remarkNoteEmbeds", () => {
  it("makes a wikilink embed of a note an embed with its target, fragment and caption", () => {
    expect(embeds("![[Note#Heading|Caption]]")).toEqual([{
      [NOTE_EMBED_PROPERTY]: "Note",
      [NOTE_EMBED_FRAGMENT_PROPERTY]: "Heading",
      [NOTE_EMBED_LABEL_PROPERTY]: "Caption",
    }]);
  });

  it("makes a Markdown embed of a note an embed too", () => {
    expect(embeds("![](Note.md)")).toEqual([{ [NOTE_EMBED_PROPERTY]: "Note.md" }]);
  });

  it("leaves media and other files as pictures", () => {
    const tree = readingHast(preprocessWikilinks("![[photo.jpg]] ![[Graph #td (video 1).mp4]] ![[board.canvas]]"));
    expect(hastElementsNamed(tree, "img")).toHaveLength(3);
    expect(embeds("![[photo.jpg]]")).toEqual([]);
  });

  it("draws an embed in a table cell as a link to the note", () => {
    const tree = readingHast(preprocessWikilinks("| Embed |\n|---|\n| ![[Note]] |"));
    const [link] = hastElementsNamed(tree, "a");
    expect(link?.properties?.href).toBe("#mine-wikilink:Note");
    expect(embeds("| Embed |\n|---|\n| ![[Note]] |")).toEqual([]);
  });

  it("keeps the embed's place in the source", () => {
    const markdown = preprocessWikilinks("Lead ![[Note]]");
    const [span] = hastElementsNamed(readingHast(markdown), "span");
    expect(markdown.slice(span?.position?.start.offset, span?.position?.end.offset)).toBe("![](Note)");
  });
});
