/// What a clipboard payload becomes in the vault.
///
/// One pure decision, shared by ⌘V and testable without a pasteboard: files
/// import like drops, a bitmap becomes an image card, a lone URL becomes a
/// link card, any other text becomes a markdown card titled by its first line.

import type { BlockType, ClipboardPayload, CreateBlockParams } from "@/types";

export function inferBlockType(ext: string): BlockType {
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  return "file";
}

export function fileNameToTitle(path: string): string {
  const name = path.split("/").pop() ?? path;
  const stem = name.replace(/\.[^.]+$/, "");
  return stem
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const IMAGE_EXTS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "svg",
]);

const VIDEO_EXTS = new Set([
  "mp4", "mov", "avi", "mkv", "webm", "m4v",
]);

const PASTED_TITLE_LIMIT = 64;

function isLoneUrl(text: string): boolean {
  const trimmed = text.trim();
  if (/\s/.test(trimmed)) return false;
  return /^https?:\/\/\S+$/i.test(trimmed);
}

function firstLineTitle(text: string): string | null {
  const line = text
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (!line) return null;
  return line.length > PASTED_TITLE_LIMIT
    ? `${line.slice(0, PASTED_TITLE_LIMIT).trimEnd()}…`
    : line;
}

export function createParamsForClipboardPayload(
  payload: ClipboardPayload,
  currentTag?: string,
): CreateBlockParams[] {
  const tags = currentTag ? [currentTag] : [];
  switch (payload.kind) {
    case "files":
      return payload.paths.map((filePath) => {
        const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
        return {
          block_type: inferBlockType(ext),
          title: fileNameToTitle(filePath),
          url: null,
          tags,
          file_path: filePath,
        };
      });
    case "image":
      return [{
        block_type: "image",
        title: "Pasted image",
        url: null,
        tags,
        file_path: payload.path,
      }];
    case "text": {
      const text = payload.text;
      if (isLoneUrl(text)) {
        return [{
          block_type: "link",
          title: null,
          url: text.trim(),
          tags,
          file_path: null,
        }];
      }
      const trimmed = text.replace(/\s+$/, "");
      if (!trimmed.trim()) return [];
      return [{
        block_type: "article",
        title: firstLineTitle(trimmed),
        url: null,
        tags,
        file_path: null,
        body: trimmed,
      }];
    }
    case "empty":
      return [];
  }
}
