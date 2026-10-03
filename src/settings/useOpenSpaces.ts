// The spaces some tab shows, for the settings sections that act on one of
// them: Orphans and New files (SPEC_TABS.md, В71). Only an open space has an
// open index, so only open spaces can be chosen.

import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { listSpaces, spacesInTabs } from "@/lib/commands";
import type { SpaceEntry, SpaceMovedPayload } from "@/types";

export interface OpenSpace {
  vaultId: string;
  name: string;
  path: string;
}

export interface OpenSpaces {
  /// The open spaces in the order the backend lists them; `null` until the
  /// first answer, so no "nothing open" state flashes before it.
  spaces: readonly OpenSpace[] | null;
  /// The space chosen in the section, else the first open one.
  current: OpenSpace | null;
  choose: (vaultId: string) => void;
  error: string | null;
}

/// The folder name of `path`, as the space list shows it.
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

export function useOpenSpaces(): OpenSpaces {
  const [openIds, setOpenIds] = useState<readonly string[] | null>(null);
  const [known, setKnown] = useState<readonly SpaceEntry[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([spacesInTabs(), listSpaces()])
      .then(([ids, entries]) => {
        if (cancelled) return;
        setKnown(entries);
        // A spaces-open-changed that arrived meanwhile is newer than this answer.
        setOpenIds((previous) => previous ?? ids);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(String(e));
        setOpenIds((previous) => previous ?? []);
      });

    const stopOpen = listen<string[]>("spaces-open-changed", (event) => {
      if (cancelled) return;
      setOpenIds(event.payload);
      // A space created or added from a tab is new to the list.
      void listSpaces()
        .then((entries) => {
          if (!cancelled) setKnown(entries);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(String(e));
        });
    });
    // The space's folder moved (В73): previews read files by absolute path.
    const stopMoved = listen<SpaceMovedPayload>("space-moved", (event) => {
      if (cancelled) return;
      const { vault_id: vaultId, path } = event.payload;
      setKnown((previous) =>
        previous.map((entry) =>
          entry.vault_id === vaultId ? { ...entry, path, name: basename(path) } : entry,
        ),
      );
    });

    return () => {
      cancelled = true;
      void stopOpen.then((stop) => stop());
      void stopMoved.then((stop) => stop());
    };
  }, []);

  const spaces = useMemo(() => {
    if (openIds === null) return null;
    return openIds.flatMap((vaultId): OpenSpace[] => {
      const entry = known.find((candidate) => candidate.vault_id === vaultId);
      return entry ? [{ vaultId, name: entry.name, path: entry.path }] : [];
    });
  }, [openIds, known]);

  // A chosen space that closed falls back to the first open one.
  const current = spaces?.find((space) => space.vaultId === chosen) ?? spaces?.[0] ?? null;

  return { spaces, current, choose: setChosen, error };
}
