// The words of the open card's association blocks (SPEC_CARD_ASSOCIATIONS.md,
// «Открытая карточка»). Every visible label lives here; the order of the
// blocks and their row limit are the backend's (`CARD_ASSOCIATION_ORDER`,
// `CARD_ASSOCIATION_PREVIEW_ROWS` in storage/card_associations.rs).

import type { CardAssociationGroup } from "@/types";

/** Heading of the block of cards saved from the same address. */
export const SAME_ADDRESS_HEADING = "Same URL";

/** The author block's last row: opens the author's feed. */
export const SHOW_ALL_LABEL = "Show all";

/** The address or site block's last row: shows the rows it holds back. */
export function showMoreLabel(hidden: number): string {
  return `Show ${hidden} more`;
}

/** The hint of an author heading, which opens the author's feed. */
export function authorFeedHint(author: string): string {
  return `All cards by ${author}`;
}

/** What a block is called: `Same URL`, the author as written on the open
 *  card, or the site's host. */
export function associationHeading(group: Pick<CardAssociationGroup, "kind" | "label">): string {
  return group.kind === "address" ? SAME_ADDRESS_HEADING : group.label;
}

/** Cards of the group the block holds back. */
export function hiddenAssociationRows(group: Pick<CardAssociationGroup, "total" | "blocks">): number {
  return Math.max(0, group.total - group.blocks.length);
}
