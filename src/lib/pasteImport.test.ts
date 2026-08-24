import { describe, expect, it } from "vitest";
import { createParamsForClipboardPayload } from "./pasteImport";

describe("createParamsForClipboardPayload", () => {
  it("imports files like drops, typed by extension, titled by name", () => {
    const params = createParamsForClipboardPayload(
      { kind: "files", paths: ["/tmp/some-photo.JPG", "/tmp/notes.pdf"] },
      "inbox",
    );
    expect(params).toEqual([
      {
        block_type: "image",
        title: "some photo",
        url: null,
        tags: ["inbox"],
        file_path: "/tmp/some-photo.JPG",
      },
      {
        block_type: "file",
        title: "notes",
        url: null,
        tags: ["inbox"],
        file_path: "/tmp/notes.pdf",
      },
    ]);
  });

  it("lands outside a collection with no tags", () => {
    const params = createParamsForClipboardPayload({ kind: "image", path: "/tmp/x.png" });
    expect(params[0]!.tags).toEqual([]);
    expect(params[0]!.block_type).toBe("image");
  });

  it("turns a lone URL into a link element", () => {
    const params = createParamsForClipboardPayload(
      { kind: "text", text: "  https://example.com/a?b=1  " },
    );
    expect(params).toEqual([{
      block_type: "link",
      title: null,
      url: "https://example.com/a?b=1",
      tags: [],
      file_path: null,
    }]);
  });

  it("keeps a URL inside prose as prose", () => {
    const params = createParamsForClipboardPayload(
      { kind: "text", text: "see https://example.com for details" },
    );
    expect(params[0]!.block_type).toBe("article");
  });

  it("titles pasted text by its first non-empty line, capped", () => {
    const long = "x".repeat(80);
    const params = createParamsForClipboardPayload(
      { kind: "text", text: `\n\n${long}\nsecond line` },
    );
    expect(params[0]!.title).toHaveLength(65); // 64 + ellipsis
    expect(params[0]!.body).toContain("second line");
  });

  it("produces nothing for whitespace or an empty board", () => {
    expect(createParamsForClipboardPayload({ kind: "text", text: "   \n " })).toEqual([]);
    expect(createParamsForClipboardPayload({ kind: "empty" })).toEqual([]);
  });
});
