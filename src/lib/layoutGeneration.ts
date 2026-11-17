import type { LightBlock } from "@/types";
import { parsePreviewManifest } from "@/lib/cardLayout";
import { cardTextIdentity } from "@/lib/cardTextIdentity";

export type LayoutGenerationKey = string;
export type BlockLayoutSignature = string;

/** The two 32-bit halves of a hash. */
type HashPair = readonly [number, number];

const HASH_SEED: HashPair = [0x811c9dc5, 0x9e3779b1];
const HASH_PRIME_1 = 0x01000193;
const HASH_PRIME_2 = 0x85ebca6b;

function hashPair(input: string): HashPair {
  let h1 = HASH_SEED[0];
  let h2 = HASH_SEED[1];
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, HASH_PRIME_1) >>> 0;
    h2 ^= code;
    h2 = Math.imul(h2, HASH_PRIME_2) >>> 0;
  }
  return [h1, h2];
}

function hashText(h1: number, h2: number): string {
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** Between two parts of a signature: no part holds it. */
const PART_END = "\u0000";

function previewManifestSignature(block: LightBlock): string {
  const manifest = parsePreviewManifest(block);
  if (!manifest) return "none";
  return [
    manifest.kind,
    manifest.tiles.length,
    manifest.overflowCount,
    manifest.width ?? "na",
    manifest.height ?? "na",
    manifest.primaryPreviewPath ? "1" : "0",
    manifest.previewWidth ?? "na",
    manifest.previewHeight ?? "na",
    ...manifest.tiles.map((tile) => [
      tile.previewWidth ?? "na", tile.previewHeight ?? "na",
      tile.isVideo, tile.isVideoPoster,
    ].join(":")),
  ].join(":");
}

export function buildBlockLayoutSignature(block: LightBlock): BlockLayoutSignature {
  // The parts as they are, each ended by a sign none of them holds: the
  // signature is hashed whole, once (`blockLayoutSignatureHash`). The card's
  // title and text enter by the hash of the text its words are measured for
  // (`cardTextIdentity`): the layout reads them through those words alone,
  // and the row's text is then read once for the signature and the measure.
  return [
    `id=${block.id}`,
    `type=${block.block_type}`,
    `kind=${block.card_kind}`,
    `text=${cardTextIdentity(block).textHash}`,
    `author=${block.author ?? ""}`,
    `url=${block.url ?? ""}`,
    `thumb=${block.thumbnail ?? ""}`,
    `file=${block.media_file ?? ""}`,
    `first=${block.first_image ?? ""}`,
    `urls=${block.media_urls ?? ""}`,
    `dims=${block.media_dimensions ?? ""}`,
    // The row's declared size shapes the envelope of an unmeasured media slot
    // (SPEC_CARD_MEDIA_GEOMETRY.md, «Пропорция конверта из заметки»).
    `size=${block.width ?? ""}x${block.height ?? ""}`,
    `preview=${previewManifestSignature(block)}`,
  ].join(PART_END);
}

/// The hash of a row's layout signature, kept by the row (SPEC_GRID.md, «Кэш
/// при карточке и продолжение раскладки»): a row is a value, a card that
/// changes is a new object, so the signature of an object is computed once.
const signatureHashes = new WeakMap<LightBlock, HashPair>();

export function blockLayoutSignatureHash(block: LightBlock): HashPair {
  let hash = signatureHashes.get(block);
  if (hash === undefined) {
    hash = hashPair(buildBlockLayoutSignature(block));
    signatureHashes.set(block, hash);
  }
  return hash;
}

/**
 * The cards' layout signatures folded into one hash in the list's order, with
 * the fold after every card kept: the signature of a list that agrees with
 * this one up to some card goes on from there (`buildFeedSignature`). It
 * depends on the cards alone, not on the width or the presentation they are
 * laid out at.
 */
export interface FeedSignature {
  /** The list the signature is of. */
  readonly blocks: readonly LightBlock[];
  /** Each card's signature hash, by halves. */
  readonly card1: Uint32Array;
  readonly card2: Uint32Array;
  /** The fold of the first `i` cards at `i`, by halves. */
  readonly fold1: Uint32Array;
  readonly fold2: Uint32Array;
  /** The hash of the whole list, as the generation key writes it. */
  readonly hash: string;
}

/**
 * The signature of `blocks`. Given the signature of another list, the cards
 * that are the same objects at the same places are not hashed again, and the
 * fold starts at the first card that differs: a page added to the end folds
 * its own cards alone. The result is the same whatever `previous` is.
 */
export function buildFeedSignature(
  blocks: readonly LightBlock[],
  previous?: FeedSignature | null,
): FeedSignature {
  const count = blocks.length;
  const held = previous?.blocks ?? [];
  const shared = Math.min(count, held.length);
  let start = 0;
  while (start < shared && held[start] === blocks[start]) start += 1;
  if (previous && start === count && held.length === count) return previous;

  const card1 = new Uint32Array(count);
  const card2 = new Uint32Array(count);
  const fold1 = new Uint32Array(count + 1);
  const fold2 = new Uint32Array(count + 1);
  fold1[0] = HASH_SEED[0];
  fold2[0] = HASH_SEED[1];
  if (previous && start > 0) {
    card1.set(previous.card1.subarray(0, start));
    card2.set(previous.card2.subarray(0, start));
    fold1.set(previous.fold1.subarray(0, start + 1));
    fold2.set(previous.fold2.subarray(0, start + 1));
  }
  for (let index = start; index < count; index += 1) {
    const block = blocks[index]!;
    if (previous && index < shared && held[index] === block) {
      card1[index] = previous.card1[index]!;
      card2[index] = previous.card2[index]!;
    } else {
      const hash = blockLayoutSignatureHash(block);
      card1[index] = hash[0];
      card2[index] = hash[1];
    }
    fold1[index + 1] = Math.imul(fold1[index]! ^ card1[index]!, HASH_PRIME_1);
    fold2[index + 1] = Math.imul(fold2[index]! ^ card2[index]!, HASH_PRIME_2);
  }
  return { blocks, card1, card2, fold1, fold2, hash: hashText(fold1[count]!, fold2[count]!) };
}

export function buildLayoutGenerationKey({
  blocks,
  signature,
  routeKey,
  columnWidth,
  columnCount,
  layoutGap,
  show,
}: {
  blocks: readonly LightBlock[];
  /** The signature of `blocks`, when the caller holds it; computed otherwise. */
  signature?: FeedSignature;
  routeKey?: string;
  /**
   * Exact masonry column width the layout is computed at. The masonry layout
   * is a pure function of (columnWidth, columnCount, gap, block heights), so
   * keying on the exact column geometry — not the raw parent width — keeps the
   * module-level layout cache alive across sub-column-width resizes (sidebar
   * drag, scrollbar gutter) while never serving a layout built for a different
   * column width.
   */
  columnWidth: number;
  /** Column count the layout is computed at. */
  columnCount: number;
  /** Card gap the layout was computed with (design variants change it). */
  layoutGap?: number;
  /** Card presentation (SPEC_FEED_DISPLAY.md): each has its own heights. */
  show?: string;
}): LayoutGenerationKey {
  return [
    routeKey ?? "__all__",
    `cw=${Math.round(columnWidth)}`,
    `cc=${columnCount}`,
    `gap=${layoutGap ?? 32}`,
    `show=${show ?? "cards"}`,
    `n=${blocks.length}`,
    `sig=${(signature ?? buildFeedSignature(blocks)).hash}`,
  ].join("|");
}
