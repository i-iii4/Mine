// The collections a card's menu shows it in (SPEC_DEEP_AUDIT.md, Е6.12).
//
// From the first frame: the collections the feed knows for the card. While
// the menu is open, the card's file is read again, and what it says replaces
// them; a read that fails leaves them. Before 13.10.2026 the menu showed the
// card in no collection until the read answered, and a failed read was an
// unhandled rejection.

import { useEffect, useState } from "react";
import { getBlock } from "@/lib/commands";
import type { IndexedBlock, LightBlock } from "@/types";

export function useCardMembership(block: LightBlock | IndexedBlock, active: boolean): string[] {
  const known = "tags" in block ? block.tags : block.collections;
  const [read, setRead] = useState<{ slug: string; tags: string[] } | null>(null);

  useEffect(() => {
    if (!active) return;
    let current = true;
    getBlock(block.slug).then(
      (full) => {
        if (current && full) setRead({ slug: block.slug, tags: full.tags });
      },
      // The menu keeps what the feed knows; a change made from it reads the
      // file itself and reports its own failure.
      () => {
        if (current) setRead(null);
      },
    );
    return () => {
      current = false;
    };
  }, [active, block.slug]);

  return read !== null && read.slug === block.slug ? read.tags : known;
}
