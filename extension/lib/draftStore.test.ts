import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Draft = { schemaVersion: number; revision: number; draftId: string; state: Record<string, unknown> };
type Storage = { get: (key: string) => Promise<Record<string, unknown>>; set: (values: Record<string, unknown>) => Promise<void>; remove: (key: string) => Promise<void> };
interface DraftStore {
  read(url: string, storage: Storage): Promise<Draft | null>;
  write(url: string, draft: Draft, expectedRevision: number, storage: Storage): Promise<Draft>;
  clear(url: string, draftId: string, expectedRevision: number, storage: Storage): Promise<void>;
}
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "draftStore.js"), "utf8");
function load(): DraftStore {
  const context = createContext({});
  runInContext(source, context);
  return context.MineDraftStore;
}
function storage() {
  const data: Record<string, unknown> = {};
  const store: Storage = {
    get: async key => ({ [key]: data[key] }),
    set: async values => { Object.assign(data, structuredClone(values)); },
    remove: async key => { delete data[key]; },
  };
  return { data, store };
}
const url = "https://example.com/page";
const edition = (revision = 1): Draft => ({ schemaVersion: 1, revision, draftId: "draft-one",
  state: { title: "Edited", selectedTags: ["B", "A"], screenshotDataUrl: "data:image/png;base64,AQID", media: ["second", "first"] } });

describe("durable draft editions", () => {
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
