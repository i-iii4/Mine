// Where a new card goes: a search field over a row for no collection and
// every collection of the space, with a row to create one. An open card's
// content offers it: a media file's Create Element and the selected text's
// (SPEC_MEDIA_ASSET_ACTIONS.md; SPEC_TEXT_SELECTION_EXTRACTION.md). The menu
// described as data holds it as a widget (`new_card_picker`,
// src/components/MenuSpecView.tsx; SPEC_MENU_WINDOW.md, МО27): the query,
// the row a card is being made for and the words of a failure live here.

import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { collectionRefLabel } from "@/lib/collections";
import { DropdownMenuItem as Item } from "@/components/ui/dropdown-menu";
import { QuantizedMenuScrollArea } from "./QuantizedMenuScrollArea";
import { SearchMenuInput } from "./SearchMenuInput";

/** The row for no collection: the card goes to the space alone. */
const NO_COLLECTION = { collection: null, title: "Everything" } as const;

export function NewCardCollectionPicker({
  collections,
  current,
  onChoose,
}: {
  /** Every collection of the space, in the order the space keeps them. */
  collections: readonly string[];
  /** The collection the feed stands on: the list starts with it. */
  current?: string | null;
  /** Create the card in `collection`, or in none; `create` says the
   *  collection is made first. Why it failed, or null. */
  onChoose: (collection: string | null, create: boolean) => Promise<string | null>;
}) {
  const [search, setSearch] = useState("");
  // The row a card is being made for: `undefined` when none is.
  const [pending, setPending] = useState<string | null | undefined>(undefined);
  const [failure, setFailure] = useState<string | null>(null);
  // The space's own order; only the current collection is hoisted to the top
  // (a stable sort keeps the rest untouched).
  const rows = useMemo(() => {
    const sorted = [...collections].sort((a, b) => {
      if (!current) return 0;
      return a === current ? (b === current ? 0 : -1) : b === current ? 1 : 0;
    });
    return [NO_COLLECTION, ...sorted.map((collection) => ({ collection, title: collectionRefLabel(collection) }))];
  }, [collections, current]);
  const query = search.toLowerCase();
  const filtered = query ? rows.filter((row) => row.title.toLowerCase().includes(query)) : rows;
  const trimmed = search.trim();
  const canCreate = trimmed.length > 0 && filtered.length === 0;
  const listRowCount = Math.max(filtered.length + (canCreate ? 1 : 0), 1);
  const busy = pending !== undefined;

  const choose = async (collection: string | null, create: boolean) => {
    setPending(collection);
    setFailure(null);
    let message: string | null;
    try {
      message = await onChoose(collection, create);
    } finally {
      setPending(undefined);
    }
    if (message === null) setSearch("");
    else setFailure(message);
  };

  return (
    <>
      <SearchMenuInput
        autoFocus
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search collections..."
        onKeyDown={(event) => event.stopPropagation()}
      />
      <QuantizedMenuScrollArea
        rowCount={listRowCount}
        rowSize="default"
        paddingY="compact"
        className="min-h-0 flex-1"
        innerClassName="px-surface py-0.5"
      >
        {filtered.map((row) => (
          <Item
            key={row.collection ?? "__everything__"}
            className="h-[var(--menu-row-height)] py-0"
            disabled={busy}
            staysOpen
            onSelect={(event) => {
              event.preventDefault();
              void choose(row.collection, false);
            }}
          >
            <span className="truncate">{busy && pending === row.collection ? "Creating..." : row.title}</span>
          </Item>
        ))}

        {canCreate && (
          <Item
            className="h-[var(--menu-row-height)] py-0"
            disabled={busy}
            staysOpen
            onSelect={(event) => {
              event.preventDefault();
              void choose(trimmed, true);
            }}
          >
            <Plus className="size-[13px] shrink-0" />
            <span>Create &ldquo;{trimmed}&rdquo;</span>
          </Item>
        )}

        {filtered.length === 0 && !canCreate && (
          <p className="flex h-[var(--menu-row-height)] items-center justify-center px-2 text-center text-sm text-muted-foreground">
            No collections
          </p>
        )}
      </QuantizedMenuScrollArea>
      {failure && <p role="alert" className="p-2 text-sm text-destructive">{failure}</p>}
    </>
  );
}
