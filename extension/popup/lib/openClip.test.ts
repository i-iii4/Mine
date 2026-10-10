import { describe, expect, it } from "vitest";
import { parseOpenClip } from "./openClip";

// The clip background keeps for a tab is opened only in the form this version
// writes (SPEC_CLIPPER_DRAFTS_REMOVAL.md, Ч12).
const clip = {
  version: 1, pageUrl: "https://a.example/story",
  metadata: { url: "https://a.example/story", title: "Story", description: "", image: null, author: null, ogType: null,
    favicon: null, selection: "", detectedType: "link", isArticle: false },
  articleData: { title: "Story", content: "Text", byline: null, excerpt: "" }, articleExtractionState: "ready",
  launchedArticle: null, linkTarget: null, title: "Title", selectedTags: ["Design"], currentType: "content",
  destination: { executor: "browser", vaultPath: null, bindingId: "binding", label: "Mine" },
  screenshot: { dataUrl: "data:image/jpeg;base64,AA", uploadId: "shot" }, edited: true,
};

describe("parseOpenClip", () => {
  it("opens the clip this version writes", () => {
    expect(parseOpenClip(structuredClone(clip))).toEqual(clip);
    expect(parseOpenClip({ ...clip, screenshot: null, linkTarget: "https://b.example/" }))
      .toMatchObject({ screenshot: null, linkTarget: "https://b.example/" });
  });

  it.each([
    ["another version", { ...clip, version: 2 }],
    ["no page", { ...clip, pageUrl: undefined }],
    ["an unknown type", { ...clip, currentType: "thread" }],
    ["an unknown extraction state", { ...clip, articleExtractionState: "running" }],
    ["a frame that is not image data", { ...clip, screenshot: { dataUrl: "https://a.example/shot.jpg", uploadId: null } }],
    ["collections that are not names", { ...clip, selectedTags: [1] }],
    ["an unknown executor", { ...clip, destination: { ...clip.destination, executor: "cloud" } }],
    ["content without text", { ...clip, articleData: { title: "Story" } }],
  ])("refuses %s", (_name, value) => {
    expect(parseOpenClip(value)).toBeNull();
  });
});
