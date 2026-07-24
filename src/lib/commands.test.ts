import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import {
  createBlock,
  deleteOrphanMedia,
  extractInlineMedia,
  getVaultPath,
  promoteOrphanMedia,
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

  it("sends orphan batch commands through a typed request DTO", async () => {
    const fileNames = ["loose-photo.jpg", "loose-video.mp4"];

    await promoteOrphanMedia(fileNames);
    await deleteOrphanMedia(fileNames);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "promote_orphan_media", {
      request: { file_names: fileNames },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "delete_orphan_media", {
      request: { file_names: fileNames },
    });
  });
});
