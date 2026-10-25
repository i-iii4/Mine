// The open card's association groups (SPEC_CARD_ASSOCIATIONS.md, «Загрузка и
// обновление»): read once the card's Related notes are known, again on every
// `vault-refreshed`, and never replaced by an answer older than the one shown.

import { useEffect, useRef, useState } from "react";

import { listCardAssociations } from "@/lib/commands";
import { useDetailMotionGate } from "@/components/detailMotionGate";
import type { CardAssociationGroup } from "@/types";

const NO_GROUPS: readonly CardAssociationGroup[] = [];

/**
 * The association groups of the card `slug`, every row of each. `excludeSlugs`
 * are its Related notes, shown already; `null` while they are not known, and
 * then nothing is asked: rows must not appear and vanish again once the
 * exclusions arrive.
 */
export function useCardAssociations(
  slug: string,
  excludeSlugs: readonly string[] | null,
): readonly CardAssociationGroup[] {
  const [answer, setAnswer] = useState<{ slug: string; groups: readonly CardAssociationGroup[] } | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const requestSequenceRef = useRef(0);
  // The newest projection revision shown for a card; an answer below it is
  // older than what is on screen.
  const acceptedRef = useRef<{ slug: string; generation: number } | null>(null);

  const excludeKey = excludeSlugs === null ? null : excludeSlugs.join("\u0000");
  // In the card's window the groups land once the window rests.
  const motionGate = useDetailMotionGate();

  useEffect(() => {
    const refresh = () => setRefreshTick((tick) => tick + 1);
    window.addEventListener("vault-refreshed", refresh);
    return () => window.removeEventListener("vault-refreshed", refresh);
  }, []);

  useEffect(() => {
    if (excludeKey === null) return;
    const sequence = ++requestSequenceRef.current;
    const exclude = excludeKey === "" ? [] : excludeKey.split("\u0000");
    void listCardAssociations(slug, exclude)
      .then((associations) => {
        if (sequence !== requestSequenceRef.current || associations.slug !== slug) return;
        const accepted = acceptedRef.current;
        if (accepted && accepted.slug === slug && associations.generation < accepted.generation) return;
        acceptedRef.current = { slug, generation: associations.generation };
        motionGate.defer(() => setAnswer({ slug, groups: associations.groups }));
      })
      .catch((error: unknown) => {
        if (sequence !== requestSequenceRef.current) return;
        // The blocks stay away; the next vault-refreshed asks again.
        console.error(`Could not read the associations of ${slug}:`, error);
        setAnswer({ slug, groups: NO_GROUPS });
      });
  }, [excludeKey, motionGate, refreshTick, slug]);

  return answer && answer.slug === slug ? answer.groups : NO_GROUPS;
}
