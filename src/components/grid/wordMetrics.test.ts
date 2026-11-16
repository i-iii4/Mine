import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LightBlock } from "@/types";

const { font } = vi.hoisted(() => ({ font: { hash: "font-a" } }));

// The ledger reads two things of the font metrics: the font's hash and the
// text a card is measured for. Both are stated here, so a test names the
// font and the text itself.
vi.mock("@/lib/fontMetrics", () => ({
  getFontHash: () => font.hash,
  createFontMetricsCacheIdentity: (block: LightBlock) => ({
    blockId: block.id,
    fontHash: font.hash,
    textHash: `${block.title}|${block.preview_text}`,
    cacheKey: `${font.hash}:${block.id}:${block.title}|${block.preview_text}`,
    title: block.title ?? "",
    preview: block.preview_text ?? "",
  }),
}));

import { lightBlock } from "@/test/blocks";
import {
  createWordMetricsLedger,
  planWordMetrics,
  recordWordMetrics,
  type WordMetricsLedger,
} from "./wordMetrics";

function card(id: number, overrides: Partial<LightBlock> = {}): LightBlock {
  return lightBlock({ id, slug: `card-${id}`, title: `Title ${id}`, preview_text: `Text ${id}`, ...overrides });
}

const ids = (blocks: readonly LightBlock[]) => blocks.map((block) => block.id);

/** Plans `blocks` and records the widths of every card asked for. */
function measure(ledger: WordMetricsLedger, blocks: LightBlock[]) {
  const plan = planWordMetrics(ledger, blocks);
  recordWordMetrics(ledger, plan, ids(plan.needsCompute));
  return plan;
}

beforeEach(() => {
  font.hash = "font-a";
});

describe("the feed's plan of word widths (SPEC_GRID.md, «Кэш при карточке и продолжение раскладки»)", () => {
  it("asks for every card of a first list, in the feed's order", () => {
    const blocks = [card(3), card(1), card(2)];
    const plan = planWordMetrics(createWordMetricsLedger(), blocks);
    expect(ids(plan.needsCompute)).toEqual([3, 1, 2]);
    expect(plan.dropped).toEqual([]);
    expect([...plan.cacheKeys.keys()]).toEqual([3, 1, 2]);
  });

  it("asks only for the cards of a page added to the end", () => {
    const ledger = createWordMetricsLedger();
    const held = [card(1), card(2), card(3)];
    measure(ledger, held);
    const plan = planWordMetrics(ledger, [...held, card(4), card(5)]);
    expect(ids(plan.needsCompute)).toEqual([4, 5]);
    expect(plan.dropped).toEqual([]);
  });

  it("asks for nothing when a row arrives changed with the text it had", () => {
    const ledger = createWordMetricsLedger();
    const held = [card(1), card(2), card(3)];
    measure(ledger, held);
    const plan = planWordMetrics(ledger, [held[0]!, card(2, { thumbnail: "preview.jpg" }), held[2]!]);
    expect(plan.needsCompute).toEqual([]);
    expect(plan.dropped).toEqual([]);
  });

  it("asks for a card whose text changed and drops the widths held for it", () => {
    const ledger = createWordMetricsLedger();
    const held = [card(1), card(2), card(3)];
    measure(ledger, held);
    const edited = card(2, { title: "Another title" });
    const plan = planWordMetrics(ledger, [held[0]!, edited, held[2]!]);
    expect(plan.needsCompute).toEqual([edited]);
    expect(plan.dropped).toEqual([2]);
    // Until its widths arrive it is asked for again with every plan.
    const again = planWordMetrics(ledger, [held[0]!, edited, held[2]!, card(4)]);
    expect(ids(again.needsCompute)).toEqual([2, 4]);
    expect(again.dropped).toEqual([]);
  });

  it("keeps asking for the cards not answered yet, in the feed's order", () => {
    const ledger = createWordMetricsLedger();
    const held = [card(1), card(2), card(3), card(4)];
    const first = planWordMetrics(ledger, held);
    // Only the first two were answered before the list changed.
    recordWordMetrics(ledger, first, [1, 2]);
    const grown = [...held, card(5)];
    const second = planWordMetrics(ledger, grown);
    expect(ids(second.needsCompute)).toEqual([3, 4, 5]);
    // The same list planned again (an effect run twice) asks for the same.
    expect(ids(planWordMetrics(ledger, grown).needsCompute)).toEqual([3, 4, 5]);
    recordWordMetrics(ledger, second, [3, 4, 5]);
    expect(planWordMetrics(ledger, [...grown]).needsCompute).toEqual([]);
  });

  it("drops the widths of a card that left and asks for nothing", () => {
    const ledger = createWordMetricsLedger();
    const held = [card(1), card(2), card(3)];
    measure(ledger, held);
    const plan = planWordMetrics(ledger, [held[0]!, held[2]!]);
    expect(plan.needsCompute).toEqual([]);
    expect(plan.dropped).toEqual([2]);
    // Back again, it is a card to measure.
    expect(ids(planWordMetrics(ledger, held).needsCompute)).toEqual([2]);
  });

  it("asks for nothing when cards change places", () => {
    const ledger = createWordMetricsLedger();
    const held = [card(1), card(2), card(3)];
    measure(ledger, held);
    const plan = planWordMetrics(ledger, [held[2]!, held[0]!, held[1]!]);
    expect(plan.needsCompute).toEqual([]);
    expect(plan.dropped).toEqual([]);
  });

  it("takes a row of another card at the same place as a card that left and one that came", () => {
    const ledger = createWordMetricsLedger();
    const held = [card(1), card(2), card(3)];
    measure(ledger, held);
    const plan = planWordMetrics(ledger, [held[0]!, card(9), held[2]!]);
    expect(ids(plan.needsCompute)).toEqual([9]);
    expect(plan.dropped).toEqual([2]);
  });

  it("asks for every card again under another font", () => {
    const ledger = createWordMetricsLedger();
    const held = [card(1), card(2)];
    measure(ledger, held);
    font.hash = "font-b";
    const plan = planWordMetrics(ledger, [...held, card(3)]);
    expect(ids(plan.needsCompute)).toEqual([1, 2, 3]);
    expect(plan.dropped.sort()).toEqual([1, 2]);
  });

  it("records only the cards of the plan it is given", () => {
    const ledger = createWordMetricsLedger();
    const plan = planWordMetrics(ledger, [card(1)]);
    recordWordMetrics(ledger, plan, [1, 2]);
    expect([...ledger.recorded.keys()]).toEqual([1]);
  });
});
