// The words of the open card's association blocks (SPEC_CARD_ASSOCIATIONS.md,
// «Открытая карточка»). Every visible label lives here; the order of the
// blocks and their row bound are the backend's (`CARD_ASSOCIATION_ORDER`,
// `CARD_ASSOCIATION_MAX_ROWS` in storage/card_associations.rs).

import type { CardAssociationGroup } from "@/types";

/** Heading of the block of cards saved from the same address. */
export const SAME_ADDRESS_HEADING = "Same URL";

/** The hint of an author heading, which opens the author's feed. */
export function authorFeedHint(author: string): string {
  return `All cards by ${author}`;
}

/** What a block is called: `Same URL`, the author as written on the open
 *  card, or the site's host. */
export function associationHeading(group: Pick<CardAssociationGroup, "kind" | "label">): string {
  return group.kind === "address" ? SAME_ADDRESS_HEADING : group.label;
}
