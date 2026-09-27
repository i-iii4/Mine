import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachDraft, writeOwnedDraft, DraftStorageError, type DurableClipperDraft } from "./draft";

const options = { ownerId: "owner", captureId: "capture", newCapture: false };
const ownership = { ownerId: "owner", generation: 1, mutationId: "mutation" };
const draft: DurableClipperDraft = {
  schemaVersion: 1, revision: 1, draftId: "capture",
  state: {
    metadata: { url: "https://example.com", title: "Page", description: "", image: null, author: null,
      ogType: null, favicon: null, selection: "", detectedType: "link", isArticle: false },
    articleData: null, title: "Edited", selectedTags: [], currentType: "link", selectedVault: "/v",
    screenshotDataUrl: null, screenshotUploadId: null, executor: "native", bindingId: "native-v",
  },
};
const sendMessage = vi.fn();
beforeEach(() => {
  sendMessage.mockReset();
  vi.stubGlobal("chrome", { runtime: { sendMessage, lastError: undefined } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("draft transport acknowledgements", () => {
  it("bounds an unanswered restore and leaves its outcome unknown", async () => {
    vi.useFakeTimers();
    const restoring = attachDraft("https://example.com", options, 7);
    const rejection = expect(restoring).rejects.toMatchObject({ code: "draft_transport" });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
  });
  it("cancels the response timer when an invalidated context throws", async () => {
    vi.useFakeTimers();
    sendMessage.mockImplementation(() => { throw new Error("Extension context invalidated"); });
    await expect(attachDraft("https://example.com", options, 7)).rejects.toBeInstanceOf(DraftStorageError);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves an uncertain mutation ID and the exact payload on retry", async () => {
    sendMessage.mockImplementationOnce((_request, reply) => reply({ ok: false, code: "draft_transport", error: "Reply interrupted" }))
      .mockImplementationOnce((_request, reply) => reply({ ok: true, draft }));
    await expect(writeOwnedDraft("https://example.com", draft, 0, ownership)).rejects.toMatchObject({ code: "draft_transport" });
    expect(await writeOwnedDraft("https://example.com", draft, 0, ownership)).toEqual(draft);
    expect(sendMessage.mock.calls[0]?.[0]).toEqual(sendMessage.mock.calls[1]?.[0]);
  });
  it("retains typed ownership errors for explicit draft recovery", async () => {
    sendMessage.mockImplementation((_request, reply) => reply({ ok: false, code: "draft_owner_replaced", error: "Editor reopened" }));
    await expect(writeOwnedDraft("https://example.com", draft, 0, ownership)).rejects.toMatchObject({ code: "draft_owner_replaced" });
  });
  it("sends each ordered snapshot before the preceding response is acknowledged", async () => {
    const replies: Array<(response: { ok: boolean; draft: DurableClipperDraft }) => void> = [];
    sendMessage.mockImplementation((_request, reply) => replies.push(reply));
    const first = writeOwnedDraft("https://example.com", draft, 0, { ...ownership, sequence: 1 });
    const next = { ...draft, state: { ...draft.state, title: "Latest" } };
    const second = writeOwnedDraft("https://example.com", next, 0, { ...ownership, mutationId: "second", sequence: 2 });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    replies[1]?.({ ok: true, draft: { ...next, revision: 2 } });
    replies[0]?.({ ok: true, draft });
    expect((await Promise.all([first, second])).map(value => value.revision)).toEqual([1, 2]);
  });
  it("accepts legacy attach replies and rejects invalid snapshot capabilities", async () => {
    sendMessage.mockImplementationOnce((_request, reply) => reply({ ok: true, draft: { draft, draftId: draft.draftId, generation: 1 } }))
      .mockImplementationOnce((_request, reply) => reply({ ok: true, draft: { draft, draftId: draft.draftId, generation: 1, sequence: -1 } }));
    expect((await attachDraft("https://example.com", options, 7)).sequence).toBeUndefined();
    await expect(attachDraft("https://example.com", options, 7)).rejects.toMatchObject({ code: "invalid_draft" });
  });
});
