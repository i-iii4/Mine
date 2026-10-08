// The open card's association groups (SPEC_CARD_ASSOCIATIONS.md, «Загрузка и
// обновление»): read once the card's Related notes are known, again on every
// `vault-refreshed`, and never replaced by an answer older than the one shown.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { listCardAssociations } from "@/lib/commands";
import type { CardAssociationGroup, CardAssociationKind } from "@/types";

export interface CardAssociationsState {
  groups: readonly CardAssociationGroup[];
  /** Kinds read past their first rows. */
  expanded: ReadonlySet<CardAssociationKind>;
  /** Read every row of `kind` (up to the backend's bound). */
  expand: (kind: CardAssociationKind) => void;
}

const NO_GROUPS: readonly CardAssociationGroup[] = [];
const ASSOCIATION_KINDS: readonly CardAssociationKind[] = ["address", "author", "site"];

/**
 * The associations of the card `slug`. `excludeSlugs` are its Related notes,
 * shown already; `null` while they are not known, and then nothing is asked:
 * rows must not appear and vanish again once the exclusions arrive.
 */
export function useCardAssociations(
  slug: string,
  excludeSlugs: readonly string[] | null,
): CardAssociationsState {
  const [answer, setAnswer] = useState<{ slug: string; groups: readonly CardAssociationGroup[] } | null>(null);
  const [expandedState, setExpandedState] = useState<{
    slug: string;
    kinds: ReadonlySet<CardAssociationKind>;
  }>(() => ({ slug, kinds: new Set() }));
  const [refreshTick, setRefreshTick] = useState(0);
  const requestSequenceRef = useRef(0);
  // The newest projection revision shown for a card; an answer below it is
  // older than what is on screen.
  const acceptedRef = useRef<{ slug: string; generation: number } | null>(null);

  // Another card starts from its first rows.
  const expanded = useMemo<ReadonlySet<CardAssociationKind>>(
    () => (expandedState.slug === slug ? expandedState.kinds : new Set()),
    [expandedState, slug],
  );
  const expandedKey = [...expanded].sort().join(",");
  const excludeKey = excludeSlugs === null ? null : excludeSlugs.join("\u0000");

  useEffect(() => {
    const refresh = () => setRefreshTick((tick) => tick + 1);
    window.addEventListener("vault-refreshed", refresh);
    return () => window.removeEventListener("vault-refreshed", refresh);
  }, []);

  useEffect(() => {
    if (excludeKey === null) return;
    const sequence = ++requestSequenceRef.current;
    const exclude = excludeKey === "" ? [] : excludeKey.split("\u0000");
    const expandedNames = expandedKey.split(",");
    const kinds = ASSOCIATION_KINDS.filter((kind) => expandedNames.includes(kind));
    void listCardAssociations(slug, exclude, kinds)
      .then((associations) => {
        if (sequence !== requestSequenceRef.current || associations.slug !== slug) return;
        const accepted = acceptedRef.current;
        if (accepted && accepted.slug === slug && associations.generation < accepted.generation) return;
        acceptedRef.current = { slug, generation: associations.generation };
        setAnswer({ slug, groups: associations.groups });
      })
      .catch((error: unknown) => {
        if (sequence !== requestSequenceRef.current) return;
        // The blocks stay away; the next vault-refreshed asks again.
        console.error(`Could not read the associations of ${slug}:`, error);
        setAnswer({ slug, groups: NO_GROUPS });
      });
  }, [excludeKey, expandedKey, refreshTick, slug]);

  const expand = useCallback((kind: CardAssociationKind) => {
    setExpandedState((current) => {
      const kinds = new Set(current.slug === slug ? current.kinds : []);
      kinds.add(kind);
      return { slug, kinds };
    });
  }, [slug]);

  return {
    groups: answer && answer.slug === slug ? answer.groups : NO_GROUPS,
    expanded,
    expand,
  };
}
