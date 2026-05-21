export interface ChannelSearchCandidate<T> {
  item: T;
  texts: readonly string[];
}

interface RankedChannelSearchCandidate<T> {
  item: T;
  score: number;
  index: number;
}

const FUZZY_MIN_QUERY_LENGTH = 3;
const SHORT_QUERY_MAX_DISTANCE = 1;
const LONG_QUERY_MAX_DISTANCE = 2;

export function normalizeChannelSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function words(value: string): string[] {
  return value.split(/[\s\-_./]+/).filter(Boolean);
}

function damerauLevenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previousPrevious = new Array<number>(b.length + 1).fill(0);
  let previous = new Array<number>(b.length + 1).fill(0);
  let current = new Array<number>(b.length + 1).fill(0);

  for (let j = 0; j <= b.length; j += 1) {
    previous[j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );

      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        current[j] = Math.min(current[j]!, previousPrevious[j - 2]! + cost);
      }
    }

    [previousPrevious, previous, current] = [previous, current, previousPrevious];
  }

  return previous[b.length]!;
}

function maxFuzzyDistance(query: string): number {
  return query.length >= 6 ? LONG_QUERY_MAX_DISTANCE : SHORT_QUERY_MAX_DISTANCE;
}

function fuzzyScore(query: string, text: string): number | null {
  if (query.length < FUZZY_MIN_QUERY_LENGTH) return null;
  const maxDistance = maxFuzzyDistance(query);
  const candidates = [text, ...words(text)].filter((candidate) => (
    Math.abs(candidate.length - query.length) <= maxDistance
  ));

  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = damerauLevenshteinDistance(query, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
    }
  }

  if (bestDistance > maxDistance) return null;
  return 100 + bestDistance * 10;
}

function scoreText(query: string, text: string): number | null {
  if (!query) return 0;
  if (!text) return null;
  if (text === query) return 0;
  if (text.startsWith(query)) return 10 + (text.length - query.length) / 100;

  const wordPrefixIndex = words(text).findIndex((word) => word.startsWith(query));
  if (wordPrefixIndex >= 0) return 20 + wordPrefixIndex;

  const substringIndex = text.indexOf(query);
  if (substringIndex >= 0) return 30 + substringIndex / 100;

  return fuzzyScore(query, text);
}

export function rankChannelSearchTexts(
  query: string,
  texts: readonly string[],
): number | null {
  const normalizedQuery = normalizeChannelSearchText(query);
  if (!normalizedQuery) return 0;

  let bestScore: number | null = null;
  for (const text of texts) {
    const score = scoreText(normalizedQuery, normalizeChannelSearchText(text));
    if (score === null) continue;
    if (bestScore === null || score < bestScore) {
      bestScore = score;
    }
  }

  return bestScore;
}

export function filterAndRankChannelSearch<T>(
  candidates: readonly ChannelSearchCandidate<T>[],
  query: string,
): T[] {
  const normalizedQuery = normalizeChannelSearchText(query);
  if (!normalizedQuery) {
    return candidates.map((candidate) => candidate.item);
  }

  const ranked: RankedChannelSearchCandidate<T>[] = [];
  candidates.forEach((candidate, index) => {
    const score = rankChannelSearchTexts(normalizedQuery, candidate.texts);
    if (score === null) return;
    ranked.push({ item: candidate.item, score, index });
  });

  ranked.sort((a, b) => a.score - b.score || a.index - b.index);
  return ranked.map((candidate) => candidate.item);
}
