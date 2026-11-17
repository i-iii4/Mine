import type { LightBlock } from "@/types";
import { cardTextIdentity } from "@/lib/cardTextIdentity";
import { getFontHash } from "@/lib/fontMetrics";
import { listGrowth } from "./feedIndex";

// Which cards of the feed wait for the widths of their words (SPEC_GRID.md,
// «Кэш при карточке и продолжение раскладки»).
//
// A card is measured again only when it is new to the feed or the text the
// worker measures changed. The plan for a new list looks only at the cards
// that are new objects: a card that did not change stays the same object
// (`reconcileBlocks`), so what was decided for it stands. The whole list is
// read only when cards left it or changed places, and under a new font.

/// The text a card's widths are measured for, kept by the card's row.
function cacheKeyOf(block: LightBlock): string {
  return cardTextIdentity(block).cacheKey;
}

/// What the feed knows of its cards' word widths between two lists.
export interface WordMetricsLedger {
  /// The list the ledger was last planned for.
  blocks: readonly LightBlock[];
  /// The font the ledger was last planned under.
  fontHash: string | null;
  /// The text the widths held for a card were measured for, by card id.
  recorded: Map<number, string>;
  /// Places in `blocks` of the cards asked for and not answered yet, in order.
  waiting: number[];
}

export function createWordMetricsLedger(): WordMetricsLedger {
  return { blocks: [], fontHash: null, recorded: new Map(), waiting: [] };
}

export interface WordMetricsPlan {
  /// The cards to measure, in the feed's order.
  needsCompute: LightBlock[];
  /// The text each of them is measured for, by card id.
  cacheKeys: Map<number, string>;
  /// Cards whose held widths no longer apply: the card left the feed or its
  /// text changed.
  dropped: number[];
}

/// The places of `blocks` to measure when `blocks` is the ledger's list with
/// cards replaced in place and cards added at its end; null when cards left
/// the list or changed places.
function planGrownList(
  ledger: WordMetricsLedger,
  blocks: readonly LightBlock[],
  fontHash: string,
  dropped: number[],
): number[] | null {
  const growth = ledger.fontHash === fontHash ? listGrowth(ledger.blocks, blocks) : null;
  if (growth === null) return null;
  const fresh = growth.replaced;
  for (let index = growth.from; index < blocks.length; index += 1) fresh.push(index);

  const replaced = new Set(fresh);
  const waiting = ledger.waiting.filter((index) => {
    if (replaced.has(index)) return false;
    const block = blocks[index]!;
    return ledger.recorded.get(block.id) !== cacheKeyOf(block);
  });
  for (const index of fresh) {
    const block = blocks[index]!;
    const held = ledger.recorded.get(block.id);
    if (held === cacheKeyOf(block)) continue;
    if (held !== undefined) {
      ledger.recorded.delete(block.id);
      dropped.push(block.id);
    }
    waiting.push(index);
  }
  return waiting.sort((a, b) => a - b);
}

/// The places of `blocks` to measure, read from every card of the list.
function planWholeList(
  ledger: WordMetricsLedger,
  blocks: readonly LightBlock[],
  dropped: number[],
): number[] {
  const waiting: number[] = [];
  const current = new Map<number, string>();
  blocks.forEach((block, index) => {
    const cacheKey = cacheKeyOf(block);
    current.set(block.id, cacheKey);
    if (ledger.recorded.get(block.id) !== cacheKey) waiting.push(index);
  });
  for (const [id, cacheKey] of [...ledger.recorded]) {
    if (current.get(id) !== cacheKey) {
      ledger.recorded.delete(id);
      dropped.push(id);
    }
  }
  return waiting;
}

/// What to measure for `blocks`, and which held widths to drop. Moves the
/// ledger to `blocks`.
export function planWordMetrics(
  ledger: WordMetricsLedger,
  blocks: readonly LightBlock[],
): WordMetricsPlan {
  const fontHash = getFontHash();
  const dropped: number[] = [];
  const waiting = planGrownList(ledger, blocks, fontHash, dropped)
    ?? planWholeList(ledger, blocks, dropped);
  ledger.blocks = blocks;
  ledger.fontHash = fontHash;
  ledger.waiting = waiting;
  const needsCompute = waiting.map((index) => blocks[index]!);
  return {
    needsCompute,
    cacheKeys: new Map(needsCompute.map((block) => [block.id, cacheKeyOf(block)])),
    dropped,
  };
}

/// The widths of the cards `ids` of `plan` arrived: the ledger holds them for
/// the text they were asked for.
export function recordWordMetrics(
  ledger: WordMetricsLedger,
  plan: WordMetricsPlan,
  ids: Iterable<number>,
): void {
  for (const id of ids) {
    const cacheKey = plan.cacheKeys.get(id);
    if (cacheKey !== undefined) ledger.recorded.set(id, cacheKey);
  }
}
