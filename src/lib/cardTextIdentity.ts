import type { LightBlock } from "@/types";
import type { FontMetricsCacheIdentity } from "@/types/fontMetrics";
import { createFontMetricsCacheIdentity, getFontHash } from "@/lib/fontMetrics";

// The text a card's words are measured for, read once for the card's row
// (SPEC_GRID.md, «Кэш при карточке и продолжение раскладки»). Two readers
// need it of every new row: the layout signature, whose text part it is, and
// the plan of word widths. A row is a value, a card that changes is a new
// object, so the identity read from an object stays true of it while the font
// is the same.

const identities = new WeakMap<LightBlock, FontMetricsCacheIdentity>();

/** The font-metrics identity of the row (`createFontMetricsCacheIdentity`),
 *  kept by the row object under the font it was read for. */
export function cardTextIdentity(block: LightBlock): FontMetricsCacheIdentity {
  const held = identities.get(block);
  if (held !== undefined && held.fontHash === getFontHash()) return held;
  const identity = createFontMetricsCacheIdentity(block);
  identities.set(block, identity);
  return identity;
}
