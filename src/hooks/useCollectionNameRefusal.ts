// Why the name of a new collection would be refused, asked as it is typed:
// the one check of every place a collection is named (`check_collection_name`,
// SPEC_DEEP_AUDIT.md, Е6.2), so a picker, a window and the sidebar refuse the
// same names for the same reasons, before anything is written.

import { createContext, useContext, useEffect, useState } from "react";

/** The check of a typed name: the reason it is refused, or null. */
export type CollectionNameCheck = (name: string) => Promise<string | null>;

/// The check the app gives every collection picker inside it, so a picker
/// deep in a card's menu asks it without each layer passing it on. The
/// clipper's picker has none: its helper checks when it writes.
export const CollectionNameCheckContext = createContext<CollectionNameCheck | undefined>(undefined);

/// The check of this surface: the one given, else the app's.
export function useCollectionNameCheck(given: CollectionNameCheck | undefined): CollectionNameCheck | undefined {
  const fromApp = useContext(CollectionNameCheckContext);
  return given ?? fromApp;
}

/// The reason `name` is refused, or null while it is not known to be: the
/// answer for an earlier name never speaks for the current one. Without a
/// check, or for an empty name, nothing is refused here; the creation itself
/// still refuses what the rules refuse.
export function useCollectionNameRefusal(name: string, check: CollectionNameCheck | undefined): string | null {
  const [answer, setAnswer] = useState<{ name: string; refusal: string | null } | null>(null);

  useEffect(() => {
    if (!check || !name) return;
    let current = true;
    check(name).then(
      (refusal) => {
        if (current) setAnswer({ name, refusal });
      },
      // A check that could not answer refuses nothing: the creation answers
      // for itself and reports its failure.
      () => {
        if (current) setAnswer({ name, refusal: null });
      },
    );
    return () => {
      current = false;
    };
  }, [check, name]);

  return answer !== null && answer.name === name && check && name ? answer.refusal : null;
}
