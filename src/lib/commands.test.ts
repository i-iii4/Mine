import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import { takeOwnFeedChanges } from "./feedChanges";
import {
  addTag,
  checkCollectionName,
  createBlock,
  createMediaAssetCard,
  deleteOrphanMedia,
  getVaultPath,
  isSearchSuperseded,
  nameRefusal,
  promoteOrphanMedia,
  renameChannel,
  searchGridBlocks,
  selectVault,
} from "./commands";

const mockInvoke = vi.mocked(tauriInvoke);

describe("IPC command adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(null);
  });

  // SPEC_DEEP_AUDIT.md, Е6.15: the words of the dictionary, Space not vault.
  it("says no space is open in the words of the dictionary", async () => {
    mockInvoke.mockRejectedValueOnce({ kind: "no_vault" });
    await expect(getVaultPath()).rejects.toThrow("No space is open.");
  });

  it("turns the generated generic command error into a readable Error", async () => {
    mockInvoke.mockRejectedValueOnce({
      kind: "internal",
      message: "database failed",
    });

    await expect(getVaultPath()).rejects.toThrow("database failed");
  });

  it("names the note an outside edit or unwritable properties stopped (Г1.5, Г1.8)", async () => {
    mockInvoke.mockRejectedValueOnce({
      kind: "source_changed",
      message: { path: "/vault/Cards/Note.md" },
    });
    await expect(getVaultPath()).rejects.toThrow("“Note.md” changed outside Mine; nothing was changed.");

    mockInvoke.mockRejectedValueOnce({
      kind: "frontmatter_not_writable",
      message: { path: "/vault/Cards/Flow.md" },
    });
    await expect(getVaultPath()).rejects.toThrow("The properties of “Flow.md” are written in a form Mine cannot edit in place");
  });

  it("names the space whose identity file Mine cannot read (Д2.1)", async () => {
    mockInvoke.mockRejectedValueOnce({
      kind: "space_identity_unreadable",
      message: { path: "/Users/me/Mine" },
    });
    await expect(selectVault("/Users/me/Mine")).rejects.toThrow(
      "Mine cannot read the identity file of “Mine”, so it did not open the space and changed nothing.",
    );
  });

  it("tells a search the backend stopped for a newer one from a failed search (SPEC_SEARCH.md, «Отмена устаревшего запроса»)", async () => {
    mockInvoke.mockRejectedValueOnce({ kind: "search_superseded" });
    const stopped = await searchGridBlocks(undefined, "metal", 200).catch((error: unknown) => error);
    expect(isSearchSuperseded(stopped)).toBe(true);

    mockInvoke.mockRejectedValueOnce({ kind: "internal", message: "database failed" });
    const failed = await searchGridBlocks(undefined, "metal", 200).catch((error: unknown) => error);
    expect(isSearchSuperseded(failed)).toBe(false);
    expect(isSearchSuperseded(new Error("network"))).toBe(false);
  });

  it("carries a refused name's reason in words, and the check answers with it (05.10.2026)", async () => {
    const reason = "A collection named “Photos” already exists.";
    mockInvoke.mockRejectedValueOnce({ kind: "name_refused", message: reason });
    const refused = await renameChannel("Art", "Photos").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect(nameRefusal(refused)).toBe(reason);
    expect(nameRefusal(new Error("database failed"))).toBeNull();

    mockInvoke.mockRejectedValueOnce({ kind: "name_refused", message: reason });
    await expect(checkCollectionName(null, "Photos")).resolves.toBe(reason);
    expect(mockInvoke).toHaveBeenLastCalledWith("check_collection_name", { old_tag: null, new_tag: "Photos" });

    // A check that fails for another reason names none; the save will say.
    mockInvoke.mockRejectedValueOnce({ kind: "internal", message: "database failed" });
    await expect(checkCollectionName("Art", "Pictures")).resolves.toBeNull();
    // A name the rules let through has no reason either.
    await expect(checkCollectionName("Art", "Pictures")).resolves.toBeNull();
  });

  it("preserves specialized tagged errors for feature-specific handling", async () => {
    mockInvoke.mockRejectedValueOnce({ kind: "no_vault" });

    await expect(
      createMediaAssetCard({
        source_slug: "source",
        media_ref: "image.png",
        target_tag: "Images",
      }),
    ).rejects.toEqual({ kind: "no_vault" });
  });

  it("sends generated request DTOs as one params object", async () => {
    const params = {
      block_type: "image",
      title: "Example",
      url: null,
      tags: ["Inbox"],
      file_path: "/tmp/example.png",
    };

    mockInvoke.mockResolvedValueOnce({ value: { slug: "Example" }, cards: [7] });
    await createBlock(params);

    expect(mockInvoke).toHaveBeenCalledWith("create_block", { params });
  });

  // SPEC_FRONTEND.md, «Обновление ленты»: a command that changes a space
  // answers with its value and the cards it changed. The caller gets the
  // value, as before; the cards go to the page's journal.
  it("hands a changing command's value to the caller and its cards to the journal", async () => {
    takeOwnFeedChanges();
    mockInvoke.mockResolvedValueOnce({ value: { slug: "Example" }, cards: [7, 9] });
    mockInvoke.mockResolvedValueOnce({ value: null, cards: [9, 12] });

    await expect(createBlock({ block_type: "article", title: null, url: null, tags: [], file_path: null }))
      .resolves.toEqual({ slug: "Example" });
    await expect(addTag("Example", "Inbox")).resolves.toBeUndefined();

    expect(takeOwnFeedChanges()).toEqual({ cards: [7, 9, 12], unknown: false });
  });

  it("says the cards are not known when a changing command named none or failed", async () => {
    takeOwnFeedChanges();
    mockInvoke.mockResolvedValueOnce({ value: { tag: "Renamed" }, cards: null });
    await renameChannel("Old", "Renamed");
    expect(takeOwnFeedChanges()).toEqual({ cards: [], unknown: true });

    mockInvoke.mockRejectedValueOnce({ kind: "internal", message: "the note could not be written" });
    await expect(addTag("Example", "Inbox")).rejects.toThrow("the note could not be written");
    expect(takeOwnFeedChanges()).toEqual({ cards: [], unknown: true });
  });

  it("leaves the journal alone for a command that only reads", async () => {
    takeOwnFeedChanges();
    mockInvoke.mockResolvedValueOnce("/vault");
    await getVaultPath();
    expect(takeOwnFeedChanges()).toBeNull();
  });

  it("sends orphan batch commands through a typed request DTO bound to their space", async () => {
    const fileNames = ["loose-photo.jpg", "loose-video.mp4"];

    await promoteOrphanMedia("space-id", fileNames);
    await deleteOrphanMedia("space-id", fileNames);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "promote_orphan_media", {
      request: { vault_id: "space-id", file_names: fileNames },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "delete_orphan_media", {
      request: { vault_id: "space-id", file_names: fileNames },
    });
  });
});
