// Which collections a hovered card is in, and which cards a hovered collection
// holds (SPEC_CARD_STATES.md, С3 and С4).
//
// The pointer moves across cards and rows far faster than React should
// re-render the app, so the state lives in a tiny external store. A card or a
// sidebar row subscribes with a selector that returns one boolean, and only the
// ones whose answer changes render again.

import { useSyncExternalStore } from "react";
import type { BlockCollection } from "@/types";

/** Row key of the Everything row: every card is in it. */
export const EVERYTHING_ROW_KEY = "all";

const TAG_ROW_PREFIX = "tag:";

let tagsByBlock = new Map<number, ReadonlySet<string>>();
let blocksByTag = new Map<string, ReadonlySet<number>>();
let hoveredBlockId: number | null = null;
let hoveredRowKey: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Replace the membership pairs; they arrive with every taxonomy snapshot. */
export function setCollectionMemberships(pairs: readonly BlockCollection[]): void {
  const byBlock = new Map<number, Set<string>>();
  const byTag = new Map<string, Set<number>>();
  for (const { block_id: blockId, tag } of pairs) {
    let tags = byBlock.get(blockId);
    if (!tags) byBlock.set(blockId, (tags = new Set()));
    tags.add(tag);
    let blocks = byTag.get(tag);
    if (!blocks) byTag.set(tag, (blocks = new Set()));
    blocks.add(blockId);
  }
  tagsByBlock = byBlock;
  blocksByTag = byTag;
  emit();
}

/**
 * How long a hover outlives the pointer leaving its card or row.
 *
 * Between two cards lies the feed gap, between two rows their edge: the
 * pointer leaves one before it enters the next. Clearing at once made every
 * answer the two share (Everything above all, which holds every card) go off
 * and on again, a flicker on each crossing. Within this window the next enter
 * replaces the hover directly, so a shared answer never changes; leaving for
 * good costs only this delay.
 */
export const HOVER_LEAVE_GRACE_MS = 150;

let cardReleaseTimer: ReturnType<typeof setTimeout> | null = null;
let rowReleaseTimer: ReturnType<typeof setTimeout> | null = null;

function cancelCardRelease() {
  if (cardReleaseTimer !== null) clearTimeout(cardReleaseTimer);
  cardReleaseTimer = null;
}

function cancelRowRelease() {
  if (rowReleaseTimer !== null) clearTimeout(rowReleaseTimer);
  rowReleaseTimer = null;
}

/** The card under the pointer in the feed, or `null` to clear at once. */
export function setHoveredCard(blockId: number | null): void {
  cancelCardRelease();
  if (hoveredBlockId === blockId) return;
  hoveredBlockId = blockId;
  emit();
}

/** The pointer left this card: clear after the grace window unless another card took over. */
export function releaseHoveredCard(blockId: number): void {
  if (hoveredBlockId !== blockId) return;
  cancelCardRelease();
  cardReleaseTimer = setTimeout(() => {
    cardReleaseTimer = null;
    if (hoveredBlockId === blockId) setHoveredCard(null);
  }, HOVER_LEAVE_GRACE_MS);
}

/** The sidebar row under the pointer (`all` or `tag:<collection>`), or `null` to clear at once. */
export function setHoveredCollectionRow(rowKey: string | null): void {
  cancelRowRelease();
  const key = rowKey === EVERYTHING_ROW_KEY || rowKey?.startsWith(TAG_ROW_PREFIX) ? rowKey : null;
  if (hoveredRowKey === key) return;
  hoveredRowKey = key;
  emit();
}

/** The pointer left this row: clear after the grace window unless another row took over. */
export function releaseHoveredCollectionRow(rowKey: string): void {
  if (hoveredRowKey !== rowKey) return;
  cancelRowRelease();
  rowReleaseTimer = setTimeout(() => {
    rowReleaseTimer = null;
    if (hoveredRowKey === rowKey) setHoveredCollectionRow(null);
  }, HOVER_LEAVE_GRACE_MS);
}

/** Whether a hovered collection row holds this card (С3). */
export function isCardLitByCollection(blockId: number): boolean {
  if (hoveredRowKey === null) return false;
  if (hoveredRowKey === EVERYTHING_ROW_KEY) return true;
  return blocksByTag.get(hoveredRowKey.slice(TAG_ROW_PREFIX.length))?.has(blockId) === true;
}

/** Whether the hovered card is in this row's collection (С4). */
export function isRowConnectedToHoveredCard(rowKey: string): boolean {
  if (hoveredBlockId === null) return false;
  if (rowKey === EVERYTHING_ROW_KEY) return true;
  if (!rowKey.startsWith(TAG_ROW_PREFIX)) return false;
  return tagsByBlock.get(hoveredBlockId)?.has(rowKey.slice(TAG_ROW_PREFIX.length)) === true;
}

export function useCardLitByCollection(blockId: number): boolean {
  return useSyncExternalStore(subscribe, () => isCardLitByCollection(blockId));
}

export function useRowConnectedToHoveredCard(rowKey: string): boolean {
  return useSyncExternalStore(subscribe, () => isRowConnectedToHoveredCard(rowKey));
}

/** Test support: forget everything. */
export function resetCollectionHover(): void {
  cancelCardRelease();
  cancelRowRelease();
  tagsByBlock = new Map();
  blocksByTag = new Map();
  hoveredBlockId = null;
  hoveredRowKey = null;
  emit();
}
