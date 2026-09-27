import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import { describe, expect, it } from "vitest";

type Draft = { schemaVersion: number; revision: number; draftId: string; state: Record<string, unknown> };
type Storage = { get: (key: string | null) => Promise<Record<string, unknown>>; set: (values: Record<string, unknown>) => Promise<void>; remove: (key: string) => Promise<void> };
interface DraftStore {
  attach(url: string, options: { ownerId: string; captureId: string; captureScope?: string; captureSession?: string; activeScopes?: string[]; newCapture?: boolean }, storage: Storage): Promise<{ draft: Draft | null; draftId: string; generation: number }>;
  writeOwned(url: string, draft: Draft, expectedRevision: number, ownership: { ownerId: string; generation: number; mutationId: string; sequence?: number }, storage: Storage): Promise<Draft>;
  read(url: string, storage: Storage): Promise<Draft | null>;
  write(url: string, draft: Draft, expectedRevision: number, storage: Storage): Promise<Draft>;
  clear(url: string, draftId: string, expectedRevision: number, storage: Storage): Promise<void>;
  clearOwned(url: string, draftId: string, expectedRevision: number, ownership: { ownerId: string; generation: number }, storage: Storage): Promise<void>;
}
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "draftStore.js"), "utf8");
const storedValueSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "storedValue.js"), "utf8");
function load(): DraftStore {
  const context = createContext({ crypto: webcrypto, TextEncoder });
  runInContext(storedValueSource, context);
  runInContext(source, context);
  return context.MineDraftStore;
}
function storage() {
  const data: Record<string, unknown> = {};
  const store: Storage = {
    get: async key => key === null ? { ...data } : ({ [key]: data[key] }),
    set: async values => { Object.assign(data, structuredClone(values)); },
    remove: async key => { delete data[key]; },
  };
  return { data, store };
}
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortedKeys(item)]));
}
function normalizedStorage() {
  const { data, store } = storage();
  return { data, store: { ...store, set: async (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) data[key] = sortedKeys(value);
  } } };
}
const url = "https://example.com/page";
const edition = (revision = 1): Draft => ({ schemaVersion: 1, revision, draftId: "draft-one",
  state: { title: "Edited", selectedTags: ["B", "A"], screenshotDataUrl: "data:image/png;base64,AQID", media: ["second", "first"] } });

describe("durable draft editions", () => {
  it("restores a prior browser session without its old tab ID and keeps live captures separate", async () => {
    const { store } = storage();
    const worker = load();
    const first = await worker.attach(url, { ownerId: "old", captureId: "old", captureScope: "7", captureSession: "first-session", activeScopes: ["7"] }, store);
    await worker.writeOwned(url, { ...edition(), draftId: first.draftId }, 0, { ownerId: "old", generation: 1, mutationId: "old-write" }, store);
    const restored = await worker.attach(url, { ownerId: "new", captureId: "new", captureScope: "99", captureSession: "second-session", activeScopes: ["99"] }, store);
    expect(restored.draft?.state.title).toBe("Edited");
    expect(restored.draftId).toBe("old");
    const independent = await worker.attach(url, { ownerId: "other", captureId: "other", captureScope: "100", captureSession: "second-session", activeScopes: ["99", "100"] }, store);
    expect(independent.draft).toBeNull();
    expect(independent.draftId).toBe("other");
  });
  it("preserves ambiguous historical captures instead of choosing or overwriting one", async () => {
    const { data, store } = storage();
    const worker = load();
    for (const id of ["a", "b"]) {
      const attached = await worker.attach(url, { ownerId: id, captureId: id, captureScope: id, captureSession: "before", newCapture: true }, store);
      await worker.writeOwned(url, { ...edition(), draftId: id }, 0, { ownerId: id, generation: attached.generation, mutationId: id }, store);
    }
    const before = structuredClone(data);
    await expect(worker.attach(url, { ownerId: "after", captureId: "after", captureScope: "after", captureSession: "after", activeScopes: ["after"] }, store)).rejects.toMatchObject({ code: "draft_ambiguous" });
    expect(data).toEqual(before);
  });
  it("does not mistake a reused tab ID for its capture from another session", async () => {
    const { store } = storage();
    const worker = load();
    for (const id of ["7", "8"]) {
      const attached = await worker.attach(url, { ownerId: id, captureId: id, captureScope: id, captureSession: "before", newCapture: true }, store);
      await worker.writeOwned(url, { ...edition(), draftId: id }, 0, { ownerId: id, generation: attached.generation, mutationId: id }, store);
    }
    await expect(worker.attach(url, { ownerId: "after", captureId: "after", captureScope: "7", captureSession: "after", activeScopes: ["7"] }, store)).rejects.toMatchObject({ code: "draft_ambiguous" });
  });
  it("recovers a closed tab in the same session and does not take a live legacy capture", async () => {
    const { store } = storage();
    const worker = load();
    const first = await worker.attach(url, { ownerId: "old", captureId: "old", captureScope: "7" }, store);
    await worker.writeOwned(url, { ...edition(), draftId: first.draftId }, 0, { ownerId: "old", generation: 1, mutationId: "old-write" }, store);
    const live = await worker.attach(url, { ownerId: "other", captureId: "other", captureScope: "9", captureSession: "now", activeScopes: ["7", "9"] }, store);
    expect(live.draft).toBeNull();
    const restored = await worker.attach(url, { ownerId: "new", captureId: "new", captureScope: "99", captureSession: "now", activeScopes: ["99", "9"] }, store);
    expect(restored.draftId).toBe("old");
    expect(restored.draft?.state.title).toBe("Edited");
  });
  it("assigns durable revisions to immediate snapshots and fences duplicates and stale sequences", async () => {
    const { store } = storage();
    const worker = load();
    await worker.attach(url, { ownerId: "owner", captureId: "draft-one" }, store);
    const first = { ownerId: "owner", generation: 1, mutationId: "first", sequence: 1 };
    const second = { ownerId: "owner", generation: 1, mutationId: "second", sequence: 2 };
    const next = { ...edition(), state: { title: "Latest" } };
    expect((await worker.writeOwned(url, edition(), 0, first, store)).revision).toBe(1);
    expect((await worker.writeOwned(url, next, 0, second, store)).revision).toBe(2);
    expect((await worker.writeOwned(url, next, 0, second, store)).revision).toBe(2);
    await expect(worker.writeOwned(url, edition(), 0, first, store)).rejects.toMatchObject({ code: "draft_snapshot_superseded" });
    await expect(worker.writeOwned(url, edition(), 0, second, store)).rejects.toThrow("retry changed");
  });
  it("queues concurrent snapshots with the same client revision and rejects the old owner after restore", async () => {
    const { store } = storage();
    const worker = load();
    await worker.attach(url, { ownerId: "owner", captureId: "draft-one" }, store);
    const first = { ownerId: "owner", generation: 1, mutationId: "first", sequence: 1 };
    const next = { ...edition(), state: { title: "Latest" } };
    const results = await Promise.all([
      worker.writeOwned(url, edition(), 0, first, store),
      worker.writeOwned(url, next, 0, { ...first, mutationId: "second", sequence: 2 }, store),
    ]);
    expect(results.map(draft => draft.revision)).toEqual([1, 2]);
    const restored = await worker.attach(url, { ownerId: "new", captureId: "new" }, store);
    expect(restored.draft?.state.title).toBe("Latest");
    await expect(worker.writeOwned(url, edition(), 0, { ...first, sequence: 3 }, store)).rejects.toMatchObject({ code: "draft_owner_replaced" });
    expect((await worker.writeOwned(url, next, 2, { ownerId: "new", generation: restored.generation, mutationId: "new", sequence: 1 }, store)).revision).toBe(3);
  });
  it("confirms a legacy edition when storage reorders object keys", async () => {
    const { store } = normalizedStorage();
    expect(await load().write(url, edition(), 0, store)).toEqual(edition());
    expect(await load().read(url, store)).toEqual(edition());
  });
  it("attaches and confirms owned editions when storage reorders nested object keys", async () => {
    const { store } = normalizedStorage();
    const attached = await load().attach(url, { ownerId: "owner", captureId: "capture" }, store);
    const draft = { ...edition(), draftId: attached.draftId };
    const ownership = { ownerId: "owner", generation: attached.generation, mutationId: "one" };
    expect(await load().writeOwned(url, draft, 0, ownership, store)).toEqual(draft);
    expect((await load().attach(url, { ownerId: "owner", captureId: "capture" }, store)).draft).toEqual(draft);
  });
  it("confirms the same mutation after stored keys change order and the worker restarts", async () => {
    const { data, store } = storage();
    const attached = await load().attach(url, { ownerId: "owner", captureId: "capture" }, store);
    const draft = { ...edition(), draftId: attached.draftId };
    const ownership = { ownerId: "owner", generation: attached.generation, mutationId: "uncertain" };
    await load().writeOwned(url, draft, 0, ownership, store);
    data["mineDurableDraftRecord:capture"] = sortedKeys(data["mineDurableDraftRecord:capture"]);
    expect(await load().writeOwned(url, draft, 0, ownership, store)).toEqual(draft);
    await expect(load().writeOwned(url, { ...draft, state: { ...draft.state, media: ["first", "second"] } },
      0, ownership, store)).rejects.toThrow("retry changed");
  });
  it("migrates normalized legacy data and clears its confirmed edition without restoring it again", async () => {
    const { data, store } = normalizedStorage();
    await load().write(url, edition(), 0, store);
    const attached = await load().attach(url, { ownerId: "owner", captureId: "candidate" }, store);
    expect(attached.draft).toEqual(edition());
    const marker = data["mineDurableDraftMigration:" + url];
    expect(marker).toMatch(/^[a-f0-9]{64}$/);
    expect((await load().attach(url, { ownerId: "owner", captureId: "candidate" }, store)).draft).toEqual(edition());
    expect(data["mineDurableDraftMigration:" + url]).toBe(marker);
    await load().clearOwned(url, attached.draftId, 1, { ownerId: "owner", generation: attached.generation }, store);
    expect(await load().read(url, store)).toBeNull();
    expect((await load().attach(url, { ownerId: "next", captureId: "next" }, store)).draft).toBeNull();
  });
  it("rejects confirmation when storage drops data or changes array order", async () => {
    for (const state of [{ title: "Edited" }, { ...edition().state, media: ["first", "second"] }]) {
      const { data, store } = storage();
      const damaged: Storage = { ...store, set: async values => {
        for (const key of Object.keys(values)) data[key] = { ...edition(), state };
      } };
      await expect(load().write(url, edition(), 0, damaged)).rejects.toThrow("could not be confirmed");
    }
  });
  it("does not let legacy clear delete an owned draft with a coincident revision", async () => {
    const { store } = storage();
    const worker = load();
    await worker.write(url, edition(), 0, store);
    const attached = await worker.attach(url, { ownerId: "new", captureId: "candidate" }, store);
    const owned = { ...edition(2), state: { title: "New editor content" } };
    await worker.writeOwned(url, owned, 1, { ownerId: "new", generation: attached.generation, mutationId: "new" }, store);
    await worker.write(url, { ...edition(2), state: { title: "Legacy editor content" } }, 1, store);
    await worker.clear(url, edition().draftId, 2, store);
    const restored = await worker.attach(url, { ownerId: "next", captureId: "candidate" }, store);
    expect(restored.draft).toEqual(owned);
  });
  it("retains a changed legacy edition after a later owned revision is saved", async () => {
    const { store } = storage();
    const worker = load();
    await worker.write(url, edition(), 0, store);
    const attached = await worker.attach(url, { ownerId: "new", captureId: "candidate" }, store);
    const ownership = { ownerId: "new", generation: attached.generation, mutationId: "two" };
    await worker.writeOwned(url, edition(2), 1, ownership, store);
    await worker.writeOwned(url, edition(3), 2, { ...ownership, mutationId: "three" }, store);
    const legacyEdit = { ...edition(2), state: { title: "Independent legacy edit" } };
    await worker.write(url, legacyEdit, 1, store);
    await worker.clearOwned(url, attached.draftId, 3, ownership, store);
    expect(await worker.read(url, store)).toEqual(legacyEdit);
  });
  it("rejects completion from a replaced owner even when its revision still matches", async () => {
    const { store } = storage();
    const worker = load();
    const attached = await worker.attach(url, { ownerId: "old", captureId: "first" }, store);
    const ownership = { ownerId: "old", generation: attached.generation, mutationId: "one" };
    await worker.writeOwned(url, { ...edition(), draftId: attached.draftId }, 0, ownership, store);
    await worker.attach(url, { ownerId: "new", captureId: "candidate" }, store);
    await expect(worker.clearOwned(url, attached.draftId, 1, ownership, store)).rejects.toThrow("reopened");
    const restored = await worker.attach(url, { ownerId: "new", captureId: "candidate" }, store);
    expect(restored.draft?.revision).toBe(1);
  });
  it("orders a restore after an in-flight write and rejects writes from the closed editor", async () => {
    const { store } = storage();
    const worker = load();
    const first = await worker.attach(url, { ownerId: "old", captureId: "capture", captureScope: "tab" }, store);
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const stalled: Storage = { ...store, set: async values => {
      entered?.();
      await new Promise<void>(resolve => { release = resolve; });
      await store.set(values);
    } };
    const writing = worker.writeOwned(url, { ...edition(), draftId: first.draftId }, 0,
      { ownerId: "old", generation: first.generation, mutationId: "write-one" }, stalled);
    await started;
    const attaching = worker.attach(url, { ownerId: "new", captureId: "candidate", captureScope: "tab" }, store);
    release?.();
    await writing;
    const restored = await attaching;
    expect(restored.draft?.revision).toBe(1);
    expect(restored.generation).toBe(2);
    await expect(worker.writeOwned(url, { ...edition(2), draftId: first.draftId }, 1,
      { ownerId: "old", generation: first.generation, mutationId: "late-old" }, store)).rejects.toThrow("reopened");
  });
  it("confirms the same mutation after a lost reply and worker replacement", async () => {
    const { store } = storage();
    const first = await load().attach(url, { ownerId: "owner", captureId: "capture" }, store);
    const draft = { ...edition(), draftId: first.draftId };
    const ownership = { ownerId: "owner", generation: first.generation, mutationId: "uncertain" };
    await load().writeOwned(url, draft, 0, ownership, store);
    expect(await load().writeOwned(url, draft, 0, ownership, store)).toEqual(draft);
    const attached = await load().attach(url, { ownerId: "owner", captureId: "capture" }, store);
    expect(attached.generation).toBe(1);
    expect(attached.draft?.revision).toBe(1);
    await expect(load().writeOwned(url, { ...draft, state: { title: "changed retry" } }, 0, ownership, store)).rejects.toThrow("retry changed");
  });
  it("separates captures and tabs at the same URL while preserving remount identity", async () => {
    const { store } = storage();
    const worker = load();
    const first = await worker.attach(url, { ownerId: "a", captureId: "a", captureScope: "tab-a" }, store);
    await worker.writeOwned(url, { ...edition(), draftId: first.draftId }, 0, { ownerId: "a", generation: 1, mutationId: "a" }, store);
    const other = await worker.attach(url, { ownerId: "b", captureId: "b", captureScope: "tab-b" }, store);
    const remount = await worker.attach(url, { ownerId: "c", captureId: "candidate", captureScope: "tab-a" }, store);
    const fresh = await worker.attach(url, { ownerId: "d", captureId: "d", captureScope: "tab-a", newCapture: true }, store);
    expect(other.draftId).toBe("b");
    expect(other.draft).toBeNull();
    expect(remount.draftId).toBe("a");
    expect(remount.draft?.state).toEqual(edition().state);
    expect(fresh.draftId).toBe("d");
    expect(fresh.draft).toBeNull();
    // The older capture remains addressable, independent of the source index.
    const older = await worker.attach(url, { ownerId: "c", captureId: "a", captureScope: "tab-a", newCapture: true }, store);
    expect(older.draft?.revision).toBe(1);
  });
  it("preserves legacy and unknown records during ownership migration", async () => {
    const { data, store } = storage();
    const worker = load();
    await worker.write(url, edition(), 0, store);
    const attached = await worker.attach(url, { ownerId: "owner", captureId: "candidate" }, store);
    expect(attached.draft).toEqual(edition());
    expect(await worker.read(url, store)).toEqual(edition());
    const unknownUrl = url + "/unknown";
    data["mineDurableDraft:" + unknownUrl] = { ...edition(), schemaVersion: 9 };
    await expect(worker.attach(unknownUrl, { ownerId: "owner", captureId: "unknown" }, store)).rejects.toThrow("preserved");
    expect(data["mineDurableDraft:" + unknownUrl]).toMatchObject({ schemaVersion: 9 });
  });
  it("retains newer owned revisions and gives a post-save capture a new identity", async () => {
    const { store } = storage();
    const worker = load();
    const attached = await worker.attach(url, { ownerId: "owner", captureId: "first" }, store);
    const ownership = { ownerId: "owner", generation: attached.generation, mutationId: "one" };
    await worker.writeOwned(url, { ...edition(), draftId: attached.draftId }, 0, ownership, store);
    await worker.writeOwned(url, { ...edition(2), draftId: attached.draftId }, 1, { ...ownership, mutationId: "two" }, store);
    await expect(worker.clearOwned(url, attached.draftId, 1, ownership, store)).rejects.toThrow("newer draft");
    await worker.clearOwned(url, attached.draftId, 2, ownership, store);
    const next = await worker.attach(url, { ownerId: "new", captureId: "next" }, store);
    expect(next.draftId).toBe("next");
    expect(next.draft).toBeNull();
  });
  it("restores the confirmed state and attachment bytes after worker destruction", async () => {
    const { store } = storage();
    await load().write(url, edition(), 0, store);
    expect(await load().read(url, store)).toEqual(edition());
  });
  it("serializes competing edits and preserves the winning edition", async () => {
    const { store } = storage();
    const worker = load();
    const results = await Promise.allSettled([worker.write(url, edition(), 0, store), worker.write(url, { ...edition(), draftId: "other" }, 0, store)]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(await worker.read(url, store)).toEqual(edition());
  });
  it("quota failure retains the last acknowledged edition", async () => {
    const { store } = storage();
    await load().write(url, edition(), 0, store);
    const full = { ...store, set: async () => { throw new Error("quota exceeded"); } };
    await expect(load().write(url, edition(2), 1, full)).rejects.toThrow("quota exceeded");
    expect(await load().read(url, store)).toEqual(edition());
  });
  it("does not acknowledge a silently lost write", async () => {
    const { store } = storage();
    await expect(load().write(url, edition(), 0, { ...store, set: async () => undefined })).rejects.toThrow("could not be confirmed");
  });
  it("preserves unknown formats and refuses their replacement or deletion", async () => {
    const { data, store } = storage();
    data["mineDurableDraft:" + url] = { ...edition(), schemaVersion: 2 };
    const before = structuredClone(data);
    await expect(load().read(url, store)).rejects.toThrow("preserved");
    await expect(load().write(url, edition(), 0, store)).rejects.toThrow("preserved");
    await expect(load().clear(url, "draft-one", 1, store)).rejects.toThrow("preserved");
    expect(data).toEqual(before);
  });
  it("cannot clear a different draft after an older save response", async () => {
    const { store } = storage();
    await load().write(url, edition(), 0, store);
    await expect(load().clear(url, "older-draft", 1, store)).rejects.toThrow("draft now owns");
    expect(await load().read(url, store)).toEqual(edition());
  });

  it("retains a newer edition of the same draft after an older save completes", async () => {
    const { store } = storage();
    const worker = load();
    await worker.write(url, edition(), 0, store);
    await worker.write(url, edition(2), 1, store);
    await expect(worker.clear(url, "draft-one", 1, store)).rejects.toThrow("newer draft");
    expect(await worker.read(url, store)).toEqual(edition(2));
  });
});
