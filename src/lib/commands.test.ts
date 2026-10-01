import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import {
  createBlock,
  deleteOrphanMedia,
  extractInlineMedia,
  getVaultPath,
  promoteOrphanMedia,
  selectVault,
  setSidebarMenuCollapsed,
} from "./commands";

const mockInvoke = vi.mocked(tauriInvoke);

describe("IPC command adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(null);
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

  it("preserves specialized tagged errors for feature-specific handling", async () => {
    mockInvoke.mockRejectedValueOnce({ kind: "no_vault" });

    await expect(
      extractInlineMedia({
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

    await createBlock(params);

    expect(mockInvoke).toHaveBeenCalledWith("create_block", { params });
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

  it("synchronizes the native sidebar menu with the React sidebar state", async () => {
    await setSidebarMenuCollapsed(true);

    expect(mockInvoke).toHaveBeenCalledWith("set_sidebar_menu_collapsed", {
      collapsed: true,
    });
  });
});
