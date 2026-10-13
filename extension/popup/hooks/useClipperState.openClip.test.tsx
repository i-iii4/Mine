// The clip of an open overlay outlives its page: the editor hands every change
// to background, an editor reopened on a new document is the same clip, the
// screenshot takes the page shown now and the card keeps its own page
// (SPEC_CLIPPER.md, «Доработки после живого просмотра», Р7 to Р9;
// SPEC_CLIPPER_DRAFTS_REMOVAL.md, Ч12).
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Message = Record<string, unknown> & { action?: string };
type Reply = (response: unknown) => void;

// The overlay runs in the page's content-script world: no chrome.tabs.
const { sent, answers, local } = vi.hoisted(() => {
  const sent: Message[] = [];
  const answers: { capture: (message: Message, reply: Reply) => void; openClipWrite: (message: Message) => unknown } = {
    capture: () => undefined, openClipWrite: () => undefined,
  };
  const local: Record<string, unknown> = {};
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      sendMessage: (message: Message, callback?: Reply) => {
        sent.push(message);
        if (message.action === "captureForCrop") answers.capture(message, (response) => callback?.(response));
        else if (message.action === "openClipWrite") callback?.(answers.openClipWrite(message));
        else callback?.(undefined);
      },
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
      lastError: undefined,
    },
    storage: {
      local: {
        get: async (keys?: unknown) => (keys === null || keys === undefined ? { ...local }
          : Object.fromEntries([keys].flat().map((key) => [key as string, local[key as string]]))),
        set: async (values: Record<string, unknown>) => { Object.assign(local, values); },
        remove: async (keys: unknown) => { for (const key of [keys].flat() as string[]) delete local[key]; },
      },
      session: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
    },
  };
  return { sent, answers, local };
});

const pageA = "https://a.example/story";
const pageB = "https://b.example/other";
const { page, standaloneSave } = vi.hoisted(() => ({
  // The document the page shows, as the content script reports it.
  page: { documentUrl: "https://a.example/story", captureGeneration: "a:1" },
  standaloneSave: vi.fn(),
}));

vi.mock("../lib/messaging", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/messaging")>(),
  sendToNative: async () => ({ ok: false, error: "No helper" }),
  getClipperLaunch: async () => null,
  extractMetadata: async () => ({
    url: page.documentUrl, documentUrl: page.documentUrl, captureGeneration: page.captureGeneration, title: "Story A",
    description: "", image: null, author: null, ogType: null, favicon: null, selection: "", detectedType: "link", isArticle: false,
  }),
  extractArticleAsync: async () => ({ title: "Story A", content: "Text of A", byline: null, excerpt: "",
    documentUrl: page.documentUrl, captureGeneration: page.captureGeneration }),
  currentCaptureDocument: () => ({ ...page }),
  cacheScreenshotUpload: async () => "cached",
}));
vi.mock("../lib/standalone", () => ({
  getStandaloneStatus: async () => ({ configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-folder" }),
  standaloneListChannels: async () => ({ ok: true, channels: [{ tag: "Design", block_count: 1 }] }),
  standaloneCreateChannel: async () => ({ ok: true }),
  standaloneSave: (payload: unknown) => standaloneSave(payload),
  standaloneLookup: async () => ({ ok: false, outcome: "unknown" }),
  chooseStandaloneFolder: async () => ({ configured: false }),
  regrantStandaloneAccess: async () => ({ configured: false }),
  openStandaloneSetup: async () => ({ ok: true }),
  canPickFolderHere: () => false,
}));
vi.mock("../lib/protocol", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/protocol")>(),
  negotiateWidgetProtocol: async () => undefined,
}));

import { OPEN_CLIP_NOT_KEPT, OPEN_CLIP_SCREENSHOT_NOT_KEPT, SOURCE_PAGE_LEFT, useClipperState } from "./useClipperState";
import { OpenClipContext, type OpenClip } from "../lib/openClip";

const frameA = "data:image/jpeg;base64,AQID";
const frameB = "data:image/jpeg;base64,BAUG";

const writes = () => sent.filter((message) => message.action === "openClipWrite").map((message) => message.clip as Record<string, unknown>);
const lastWrite = () => writes().at(-1);

function keptClip(extra: Partial<OpenClip> = {}): OpenClip {
  return {
    version: 1, pageUrl: pageA,
    metadata: { url: pageA, documentUrl: pageA, captureGeneration: "a:1", title: "Story A", description: "", image: null,
      author: null, ogType: null, favicon: null, selection: "", detectedType: "link", isArticle: false },
    articleData: { title: "", content: "", byline: null, excerpt: "" }, articleExtractionState: "idle", launchedArticle: null,
    linkTarget: null, title: "My title", selectedTags: ["Design"], currentType: "screenshot",
    destination: { executor: "browser", vaultPath: null, bindingId: "browser-folder", label: "Mine" },
    screenshot: { dataUrl: frameA, uploadId: "shot-a" }, edited: true, ...extra,
  };
}

function reopen(clip: OpenClip) {
  return renderHook(() => useClipperState(), {
    wrapper: ({ children }: { children: ReactNode }) => <OpenClipContext.Provider value={clip}>{children}</OpenClipContext.Provider>,
  });
}

beforeEach(() => {
  sent.length = 0;
  for (const key of Object.keys(local)) delete local[key];
  Object.assign(page, { documentUrl: pageA, captureGeneration: "a:1" });
  answers.capture = (_message, reply) => reply({ ok: true, dataUrl: frameA, screenshotId: "shot-a" });
  answers.openClipWrite = () => undefined;
  standaloneSave.mockReset();
  standaloneSave.mockResolvedValue({ ok: true, outcome: "committed", slug: "Cards/Story" });
  (globalThis as unknown as { __mineOverlay?: unknown }).__mineOverlay = { hide: () => undefined, show: () => undefined };
});

afterEach(() => {
  delete (globalThis as unknown as { __mineOverlay?: unknown }).__mineOverlay;
});

describe("the open overlay hands its clip to background (Р7, Ч12)", () => {
  it("writes the clip once it opens, with its page, frame and destination", async () => {
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.screenshotDataUrl).toBe(frameA));
    await waitFor(() => expect(lastWrite()).toMatchObject({
      version: 1, pageUrl: window.location.href, title: "Story A", currentType: "screenshot", edited: false,
      metadata: { url: pageA }, screenshot: { dataUrl: frameA, uploadId: "shot-a" },
      destination: { executor: "browser", bindingId: "browser-folder", label: "Mine" },
    }));
  });

  it("writes every change, sending the frame again only when it changed", async () => {
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(lastWrite()?.screenshot).toMatchObject({ dataUrl: frameA }));
    act(() => result.current.setTitle("Renamed"));
    await waitFor(() => expect(lastWrite()).toMatchObject({ title: "Renamed", edited: true }));
    expect(lastWrite()).not.toHaveProperty("screenshot");
    act(() => result.current.toggleTag("Design"));
    await waitFor(() => expect(lastWrite()).toMatchObject({ selectedTags: ["Design"] }));
    answers.capture = (_message, reply) => reply({ ok: true, dataUrl: frameB, screenshotId: "shot-b" });
    act(() => result.current.retakeScreenshot());
    await waitFor(() => expect(lastWrite()?.screenshot).toEqual({ dataUrl: frameB, uploadId: "shot-b" }));
  });

  it("hands over what is pending when the editor goes with its page", async () => {
    const { result, unmount } = renderHook(() => useClipperState());
    await waitFor(() => expect(lastWrite()).toBeDefined());
    act(() => result.current.setTitle("Typed just before the link"));
    unmount();
    expect(lastWrite()).toMatchObject({ title: "Typed just before the link" });
  });

  // Background answers what session storage could hold (SPEC_DEEP_AUDIT.md,
  // Е3.11); the editor says what a page change would lose.
  it("says when background cannot keep the clip, or keeps it without its frame", async () => {
    answers.openClipWrite = () => ({ ok: false, code: "open_clip_too_large", error: "This clip is too large to keep while the page changes." });
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.openClipNotice).toBe(OPEN_CLIP_NOT_KEPT));

    // Background keeps nothing now: the next write carries the frame again.
    answers.openClipWrite = () => ({ ok: true, screenshotKept: false });
    act(() => result.current.setTitle("Shorter"));
    await waitFor(() => expect(result.current.openClipNotice).toBe(OPEN_CLIP_SCREENSHOT_NOT_KEPT));
    expect(lastWrite()?.screenshot).toMatchObject({ dataUrl: frameA });

    // A change without a new frame leaves background without the frame.
    answers.openClipWrite = () => ({ ok: true });
    act(() => result.current.setTitle("Renamed again"));
    await waitFor(() => expect(lastWrite()).toMatchObject({ title: "Renamed again" }));
    expect(result.current.openClipNotice).toBe(OPEN_CLIP_SCREENSHOT_NOT_KEPT);

    // A new frame kept whole clears it.
    answers.capture = (_message, reply) => reply({ ok: true, dataUrl: frameB, screenshotId: "shot-b" });
    act(() => result.current.retakeScreenshot());
    await waitFor(() => expect(result.current.openClipNotice).toBeNull());
  });

  it("forgets the clip after a Save and writes nothing more", async () => {
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.canSave).toBe(true));
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(sent.some((message) => message.action === "openClipClear")).toBe(true);
    const count = writes().length;
    act(() => result.current.setTitle("After the save"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(writes()).toHaveLength(count);
  });
});

describe("an overlay reopened on a new document is the same clip (Р7)", () => {
  it("opens with the kept clip and reads nothing of the page shown now", async () => {
    Object.assign(page, { documentUrl: pageB, captureGeneration: "b:1" });
    const { result } = reopen(keptClip());
    await waitFor(() => expect(result.current.state).toBe("main"));
    expect(result.current).toMatchObject({
      title: "My title", selectedTags: ["Design"], currentType: "screenshot", screenshotDataUrl: frameA,
      metadata: { url: pageA },
    });
    await waitFor(() => expect(result.current).toMatchObject({ saveMode: "standalone", standaloneFolder: "Mine" }));
    expect(result.current.destinationNotice).toBeNull();
    // No new frame was taken of page B on opening.
    expect(sent.some((message) => message.action === "captureForCrop")).toBe(false);
  });

  it("saves the card of page A with a screenshot taken on page B (Р9)", async () => {
    Object.assign(page, { documentUrl: pageB, captureGeneration: "b:1" });
    const { result } = reopen(keptClip());
    await waitFor(() => expect(result.current.canSave).toBe(true));
    answers.capture = (_message, reply) => reply({ ok: true, dataUrl: frameB, screenshotId: "shot-b" });
    act(() => result.current.retakeScreenshot());
    await waitFor(() => expect(result.current.screenshotDataUrl).toBe(frameB));
    expect(sent.find((message) => message.action === "captureForCrop")).toEqual({ target: "background", action: "captureForCrop" });
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(standaloneSave.mock.calls[0]![0]).toMatchObject({
      block_type: "image", url: pageA, title: "My title", screenshot_data_url: frameB, tags: ["Design"],
    });
  });

  it("says the original page is gone when Content was never read before the page changed (Р8)", async () => {
    Object.assign(page, { documentUrl: pageB, captureGeneration: "b:1" });
    const { result } = reopen(keptClip());
    await waitFor(() => expect(result.current.state).toBe("main"));
    act(() => result.current.setCurrentType("content"));
    await waitFor(() => expect(result.current.articleExtractionState).toBe("empty"));
    expect(result.current.articleData?.unavailableReason).toBe(SOURCE_PAGE_LEFT);
    await act(async () => { expect(await result.current.save()).toEqual({ ok: false, error: SOURCE_PAGE_LEFT }); });
    expect(standaloneSave).not.toHaveBeenCalled();
  });

  it("keeps the content it had read before the page changed", async () => {
    Object.assign(page, { documentUrl: pageB, captureGeneration: "b:1" });
    const { result } = reopen(keptClip({
      currentType: "content", articleExtractionState: "ready",
      articleData: { title: "Story A", content: "Text of A", byline: null, excerpt: "" },
    }));
    await waitFor(() => expect(result.current.canSave).toBe(true));
    await act(async () => { expect(await result.current.save()).toMatchObject({ ok: true }); });
    expect(standaloneSave.mock.calls[0]![0]).toMatchObject({ block_type: "article", url: pageA, body: "Text of A" });
  });
});

describe("the page changes under an open overlay without a new document (Р6, Р8)", () => {
  it("keeps the clip of page A and does not read page B as its content", async () => {
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.state).toBe("main"));
    Object.assign(page, { documentUrl: pageB, captureGeneration: "a:2" });
    act(() => result.current.setCurrentType("content"));
    await waitFor(() => expect(result.current.articleExtractionState).toBe("empty"));
    expect(result.current.articleData?.unavailableReason).toBe(SOURCE_PAGE_LEFT);
    expect(result.current.metadata?.url).toBe(pageA);
  });

  it("reads the page as before while it still shows the clip's document", async () => {
    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.state).toBe("main"));
    act(() => result.current.setCurrentType("content"));
    await waitFor(() => expect(result.current.articleExtractionState).toBe("ready"));
    expect(result.current.articleData?.content).toBe("Text of A");
  });
});

// A Save link clip takes the page shown for its screenshot like any clip, and
// a type chosen in the overlay stays chosen across the capture it starts
// (SPEC_CLIPPER.md, «Доработки после живого просмотра», 12.10.2026).
describe("Screenshot in the overlay for any clip, in any order of types (12.10.2026)", () => {
  const linkB = "https://b.example/linked";

  it("takes the page shown for a Save link clip kept across a new document, naming no page", async () => {
    Object.assign(page, { documentUrl: pageB, captureGeneration: "b:1" });
    const { result } = reopen(keptClip({
      linkTarget: linkB, currentType: "link", screenshot: null,
      metadata: { url: linkB, documentUrl: linkB, title: "", description: "", image: null, author: null, ogType: null,
        favicon: null, selection: "", detectedType: "link", isArticle: false },
    }));
    await waitFor(() => expect(result.current.state).toBe("main"));
    answers.capture = (_message, reply) => reply({ ok: true, dataUrl: frameB, screenshotId: "shot-b" });

    act(() => result.current.setCurrentType("screenshot"));

    await waitFor(() => expect(result.current.screenshotDataUrl).toBe(frameB));
    expect(sent.find((message) => message.action === "captureForCrop")).toEqual({ target: "background", action: "captureForCrop" });
    expect(result.current.captureError).toBeNull();
    expect(result.current.currentType).toBe("screenshot");
    expect(result.current.metadata?.url).toBe(linkB);
  });

  // The keyboard moves to the pressed segment, or the arrows move it, once
  // the event that chose the type is over. The overlay hides after that, so
  // the keyboard it gives back after the capture is on the chosen segment.
  it("hides the overlay after the event that chose Screenshot, then captures", async () => {
    const order: string[] = [];
    (globalThis as unknown as { __mineOverlay: unknown }).__mineOverlay = {
      hide: () => order.push("hide"), show: () => order.push("show"),
    };
    answers.capture = (_message, reply) => { order.push("capture"); reply({ ok: true, dataUrl: frameB, screenshotId: "shot-b" }); };
    const { result } = reopen(keptClip({ currentType: "content", screenshot: null }));
    await waitFor(() => expect(result.current.state).toBe("main"));

    act(() => result.current.setCurrentType("screenshot"));
    expect(order).toEqual([]);
    expect(result.current.capturing).toBe(true);

    await waitFor(() => expect(order).toEqual(["hide", "capture", "show"]));
    expect(result.current.currentType).toBe("screenshot");
    expect(result.current.screenshotDataUrl).toBe(frameB);
  });
});
