import type { BlockType, CardKind, LightBlock } from "@/types";
import type { LayoutGenerationKey } from "@/lib/layoutGeneration";

export const CARD_HEIGHT_DRIFT_SOFT_BUDGET_PX = 2;
export const CARD_HEIGHT_DRIFT_HARD_BUDGET_PX = 8;

export type CardHeightDriftStatus = "empty" | "ok" | "over-budget";

export interface CardHeightDriftObservation {
  block: LightBlock;
  measuredHeight: number;
  deterministicHeight: number;
  wordMetricsReady: boolean;
}

export interface CardHeightDriftSample {
  blockId: number;
  slug: string;
  cardKind: CardKind;
  blockType: BlockType;
  measuredHeight: number;
  deterministicHeight: number;
  deltaPx: number;
  absDeltaPx: number;
  wordMetricsReady: boolean;
}

export interface CardHeightDriftSummary {
  count: number;
  meanAbsDeltaPx: number;
  p95AbsDeltaPx: number;
  maxAbsDeltaPx: number;
  maxPositiveDeltaPx: number;
  maxNegativeDeltaPx: number;
  softBudgetExceededCount: number;
  hardBudgetExceededCount: number;
}

export interface CardHeightDriftReport extends CardHeightDriftSummary {
  checkedAtMs: number;
  layoutGenerationKey: LayoutGenerationKey;
  columnWidth: number;
  status: CardHeightDriftStatus;
  softBudgetPx: number;
  hardBudgetPx: number;
  exactSampleCount: number;
  fallbackSampleCount: number;
  byCardKind: Partial<Record<CardKind, CardHeightDriftSummary>>;
  byBlockType: Partial<Record<BlockType, CardHeightDriftSummary>>;
  samples: CardHeightDriftSample[];
}

const CARD_KINDS: readonly CardKind[] = ["article", "media", "channel"];
const BLOCK_TYPES: readonly BlockType[] = [
  "image",
  "article",
  "link",
  "video",
  "file",
  "channel",
];

function roundPixel(value: number): number {
  return Math.round(value * 100) / 100;
}

function emptySummary(): CardHeightDriftSummary {
  return {
    count: 0,
    meanAbsDeltaPx: 0,
    p95AbsDeltaPx: 0,
    maxAbsDeltaPx: 0,
    maxPositiveDeltaPx: 0,
    maxNegativeDeltaPx: 0,
    softBudgetExceededCount: 0,
    hardBudgetExceededCount: 0,
  };
}

function summarize(samples: readonly CardHeightDriftSample[]): CardHeightDriftSummary {
  if (samples.length === 0) return emptySummary();

  const absDeltas = samples.map((sample) => sample.absDeltaPx).sort((a, b) => a - b);
  const p95Index = Math.min(
    absDeltas.length - 1,
    Math.ceil(absDeltas.length * 0.95) - 1,
  );

  let absSum = 0;
  let maxAbsDeltaPx = 0;
  let maxPositiveDeltaPx = Number.NEGATIVE_INFINITY;
  let maxNegativeDeltaPx = Number.POSITIVE_INFINITY;
  let softBudgetExceededCount = 0;
  let hardBudgetExceededCount = 0;

  for (const sample of samples) {
    absSum += sample.absDeltaPx;
    maxAbsDeltaPx = Math.max(maxAbsDeltaPx, sample.absDeltaPx);
    maxPositiveDeltaPx = Math.max(maxPositiveDeltaPx, sample.deltaPx);
    maxNegativeDeltaPx = Math.min(maxNegativeDeltaPx, sample.deltaPx);
    if (sample.absDeltaPx > CARD_HEIGHT_DRIFT_SOFT_BUDGET_PX) {
      softBudgetExceededCount += 1;
    }
    if (sample.absDeltaPx > CARD_HEIGHT_DRIFT_HARD_BUDGET_PX) {
      hardBudgetExceededCount += 1;
    }
  }

  return {
    count: samples.length,
    meanAbsDeltaPx: roundPixel(absSum / samples.length),
    p95AbsDeltaPx: roundPixel(absDeltas[p95Index] ?? 0),
    maxAbsDeltaPx: roundPixel(maxAbsDeltaPx),
    maxPositiveDeltaPx: roundPixel(maxPositiveDeltaPx),
    maxNegativeDeltaPx: roundPixel(maxNegativeDeltaPx),
    softBudgetExceededCount,
    hardBudgetExceededCount,
  };
}

function groupByCardKind(
  samples: readonly CardHeightDriftSample[],
): Partial<Record<CardKind, CardHeightDriftSummary>> {
  const summaries: Partial<Record<CardKind, CardHeightDriftSummary>> = {};
  for (const kind of CARD_KINDS) {
    const group = samples.filter((sample) => sample.cardKind === kind);
    if (group.length > 0) {
      summaries[kind] = summarize(group);
    }
  }
  return summaries;
}

function groupByBlockType(
  samples: readonly CardHeightDriftSample[],
): Partial<Record<BlockType, CardHeightDriftSummary>> {
  const summaries: Partial<Record<BlockType, CardHeightDriftSummary>> = {};
  for (const blockType of BLOCK_TYPES) {
    const group = samples.filter((sample) => sample.blockType === blockType);
    if (group.length > 0) {
      summaries[blockType] = summarize(group);
    }
  }
  return summaries;
}

function statusForSummary(
  summary: CardHeightDriftSummary,
  fallbackSampleCount: number,
): CardHeightDriftStatus {
  if (summary.count === 0) return "empty";
  if (fallbackSampleCount > 0) return "over-budget";
  if (
    summary.hardBudgetExceededCount > 0 ||
    summary.p95AbsDeltaPx > CARD_HEIGHT_DRIFT_SOFT_BUDGET_PX
  ) {
    return "over-budget";
  }
  return "ok";
}

export function createCardHeightDriftReport({
  layoutGenerationKey,
  columnWidth,
  observations,
  nowMs = performance.now(),
}: {
  layoutGenerationKey: LayoutGenerationKey;
  columnWidth: number;
  observations: readonly CardHeightDriftObservation[];
  nowMs?: number;
}): CardHeightDriftReport {
  const samples = observations.map((observation) => {
    const deltaPx = roundPixel(
      observation.deterministicHeight - observation.measuredHeight,
    );
    return {
      blockId: observation.block.id,
      slug: observation.block.slug,
      cardKind: observation.block.card_kind,
      blockType: observation.block.block_type,
      measuredHeight: observation.measuredHeight,
      deterministicHeight: observation.deterministicHeight,
      deltaPx,
      absDeltaPx: Math.abs(deltaPx),
      wordMetricsReady: observation.wordMetricsReady,
    };
  });

  const summary = summarize(samples);
  const exactSampleCount = samples.filter((sample) => sample.wordMetricsReady).length;
  const fallbackSampleCount = samples.length - exactSampleCount;

  return {
    checkedAtMs: nowMs,
    layoutGenerationKey,
    columnWidth,
    status: statusForSummary(summary, fallbackSampleCount),
    softBudgetPx: CARD_HEIGHT_DRIFT_SOFT_BUDGET_PX,
    hardBudgetPx: CARD_HEIGHT_DRIFT_HARD_BUDGET_PX,
    exactSampleCount,
    fallbackSampleCount,
    byCardKind: groupByCardKind(samples),
    byBlockType: groupByBlockType(samples),
    samples,
    ...summary,
  };
}
