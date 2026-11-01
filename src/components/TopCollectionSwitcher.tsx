import { collectionNameRefusal } from "@/hooks/useCollectionNameRefusal";
import { collectionRefLabel } from "@/lib/collections";
import { cn } from "@/lib/utils";
import { ChromeNameField } from "./ChromeNameField";

// The place the feed shows, named first in the top row's path (DESIGN_SYSTEM.md,
// «Верхние ряды»). Since 31.10.2026 (user's decision) it opens no menu and has
// no chevron: the sidebar switches the place. A collection's name
// is renamed right there with a click, as the open card's file name is
// (`ChromeNameField`), by the sidebar's command and its checks. Everything
// and an author's feed are named in plain text that answers nothing.

interface TopCollectionSwitcherProps {
  /// False while an open card's name stands in its place (topRowPath.ts):
  /// the name fades out where it stands and back in, and nothing of it
  /// answers meanwhile (global.css, «The top rows' motion»).
  shown?: boolean;
  /// Out of the row's flow, at its start: the card's name has the place's
  /// room while the name fades.
  overlay?: boolean;
  currentTag?: string;
  /// The author whose cards the feed shows, as written on the card the
  /// person came from: the path names it (SPEC_CARD_ASSOCIATIONS.md,
  /// «Лента автора»).
  currentAuthor?: string;
  /// Renames the collection `oldTag` to the typed name; a refusal rejects,
  /// and the name's field shows why (the sidebar's rename).
  onRename: (oldTag: string, newName: string) => Promise<void>;
  /// Why a name typed for the collection `oldTag` would be refused, or null;
  /// writes nothing (`check_collection_name`, SPEC_DEEP_AUDIT.md, Е6.2).
  onCheckName?: (oldTag: string, name: string) => Promise<string | null>;
  /// The path goes on after it with no padding of its own: an open card's
  /// name stands past a line the half over the feed draws, the feed's own
  /// controls at the far right. Outer padding stands only toward a boundary,
  /// a line or the end of the row; the line before it is always there.
  joinsNext?: boolean;
}

function currentPlaceLabel(currentTag?: string, currentAuthor?: string): string {
  if (currentAuthor !== undefined) return currentAuthor;
  return currentTag ? collectionRefLabel(currentTag) : "Everything";
}

export function TopCollectionSwitcher({
  currentTag,
  currentAuthor,
  onRename,
  onCheckName,
  joinsNext = false,
  shown = true,
  overlay = false,
}: TopCollectionSwitcherProps) {
  const label = currentPlaceLabel(currentTag, currentAuthor);
  // An author's feed and Everything are no collection: nothing to rename.
  const collection = currentAuthor === undefined ? currentTag : undefined;
  return (
    <div
      className={cn(
        "flex h-full min-w-0 max-w-[50%] shrink-0",
        overlay && "absolute inset-y-0 left-0",
      )}
      data-top-collection-switcher-slot=""
      data-top-row-fade=""
      data-entered={shown ? "true" : "false"}
      inert={!shown}
      aria-hidden={shown ? undefined : true}
    >
      <div
        className={cn(
          "flex h-full min-w-0 max-w-full items-center",
          // Label text = this padding + 8px inner padding of the name: 16 px
          // from the line before it, the sidebar open or collapsed
          // (11.10.2026), like the space switcher's from the window edge.
          "pl-[var(--top-collection-pad-x)]",
          joinsNext ? "pr-0" : "pr-[var(--top-collection-pad-x)]",
        )}
        data-top-collection-switcher=""
      >
        {collection !== undefined ? (
          <ChromeNameField
            name={label}
            title={label}
            fieldLabel="Rename collection"
            check={onCheckName ? (typed) => onCheckName(collection, typed) : undefined}
            save={(typed) => onRename(collection, typed)}
            reasonOf={collectionNameRefusal}
            resetKey={collection}
            marker="top-collection-name"
          />
        ) : (
          <div
            className="h-6 min-w-0 select-none truncate px-2 font-mono text-sm leading-6 text-muted-foreground"
            title={label}
            data-top-collection-name=""
            data-top-place-plain=""
          >
            {label}
          </div>
        )}
      </div>
    </div>
  );
}
