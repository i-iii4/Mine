import type { LightBlock } from "@/types";
import { normalizeFeedPreviewManifest } from "@/lib/feedPreview";

export type LayoutGenerationKey = string;
export type BlockLayoutSignature = string;

function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= code;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

function previewManifestSignature(raw: string | null): string {
  const manifest = normalizeFeedPreviewManifest(raw);
  if (!manifest) return "none";
  return [
    manifest.kind,
    manifest.tiles.length,
    manifest.overflowCount,
    manifest.width ?? "na",
    manifest.height ?? "na",
    manifest.primaryPreviewPath ? "1" : "0",
  ].join(":");
}

export function buildBlockLayoutSignature(block: LightBlock): BlockLayoutSignature {
  return [
    `id=${block.id}`,
    `type=${block.block_type}`,
    `title=${hashString(block.title ?? "")}`,
    `author=${hashString(block.author ?? "")}`,
    `preview=${hashString(block.preview_text ?? block.body)}`,
    `url=${hashString(block.url ?? "")}`,
    `thumb=${block.thumbnail ?? ""}`,
    `file=${block.media_file ?? ""}`,
    `first=${block.first_image ?? ""}`,
    `urls=${hashString(block.media_urls ?? "")}`,
    `dims=${block.media_dimensions ?? ""}`,
    `preview=${previewManifestSignature(block.preview_manifest)}`,
  ].join("|");
}

export function buildLayoutGenerationKey({
  blocks,
  routeKey,
  heightBucket,
  parentWidth,
}: {
  blocks: readonly LightBlock[];
  routeKey?: string;
  heightBucket: number;
  parentWidth: number;
}): LayoutGenerationKey {
  const blockSignatures = blocks.map((block, index) => `${index}:${buildBlockLayoutSignature(block)}`);
  const orderedHash = hashString(blockSignatures.join("||"));
  const edgeSample = [
    blockSignatures[0] ?? "none",
    blockSignatures[1] ?? "none",
    blockSignatures[2] ?? "none",
    blockSignatures[blockSignatures.length - 3] ?? "none",
    blockSignatures[blockSignatures.length - 2] ?? "none",
    blockSignatures[blockSignatures.length - 1] ?? "none",
  ].join("||");

  return [
    routeKey ?? "__all__",
    `hb=${heightBucket}`,
    `pw=${Math.round(parentWidth)}`,
    `n=${blocks.length}`,
    `sig=${orderedHash}`,
    `edge=${hashString(edgeSample)}`,
  ].join("|");
}
