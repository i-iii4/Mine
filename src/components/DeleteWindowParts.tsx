import { MissingAwareImage } from "./MissingAwareImage";
import { NotificationCard } from "@/components/NotificationCard";
import { fallbackThumbsRoot, mediaUrl, thumbnailUrl } from "@/lib/assets";
import { selectedElementCountLabel } from "@/lib/groupSelection";
import type { DeleteBlockMedia } from "@/types";

/// The parts `Delete element?` and `Delete selected elements?` share
/// (SPEC_GROUP_SELECTION.md, «Batch Delete», «Окно»): the description, the
/// grid of media previews and the notice of media the deletion kept. One
/// module, so the two windows never drift apart.

/** Who goes: the one element of `Delete element?`, or a counted selection. */
export type DeleteSubject =
  | { kind: "element" }
  | { kind: "selection"; count: number };

/// The description of a delete window (DESIGN_SYSTEM.md, «Окна», «Тексты
/// окон», decision of 11.10.2026): what goes to the Trash first, then the
/// media only the deleted elements use, then the media that stay because
/// other elements use them. The buttons are not retold.
export function deleteWindowDescription(
  subject: DeleteSubject,
  unusedCount: number,
  sharedCount: number,
): string {
  const one = subject.kind === "element" || subject.count === 1;
  const who = subject.kind === "element" ? "The element" : selectedElementCountLabel(subject.count);
  const shared = sharedCount > 0
    ? ` ${mediaCountLabel(sharedCount)} ${mediaCountVerb(sharedCount)} used by other elements and will stay in the space.`
    : "";
  if (unusedCount > 0) {
    const pronoun = one ? "it" : "them";
    const owners = one ? "this element" : "these elements";
    return `${who} and the media files you delete with ${pronoun} go to the Trash. ${mediaCountLabel(unusedCount)} ${mediaCountVerb(unusedCount)} only used by ${owners}.${shared}`;
  }
  return `${who} ${one ? "goes" : "go"} to the Trash.${shared}`;
}

/// The description when the window could not read its plan; `Delete` is
/// unavailable then.
export function deletePlanErrorDescription(error: string): string {
  return `Could not prepare delete plan: ${error}`;
}

/// The files the window offered for deletion that the deletion kept.
///
/// The window's plan comes from the index; the deletion checks the notes on
/// disk, and a file another note uses stays (decision of 11.10.2026).
/// `kept` names every file of the deleted elements that stayed, the ones the
/// window already said would stay included: only the offered ones are news.
export function keptOfferedMedia(
  offered: DeleteBlockMedia[],
  kept: DeleteBlockMedia[],
): DeleteBlockMedia[] {
  const offeredPaths = new Set(offered.map((media) => media.path));
  return kept.filter((media) => offeredPaths.has(media.path));
}

/// The deletion's word on files it kept against the window's offer: one
/// notice in the corner, as every notice of the feed.
export function DeleteKeptMediaNotice({
  media,
  onClose,
}: {
  media: DeleteBlockMedia[];
  onClose: () => void;
}) {
  const [only, ...rest] = media;
  const text = only && rest.length === 0
    ? `${only.file_name} is used by another element and stayed in the space.`
    : `${mediaCountLabel(media.length)} are used by other elements and stayed in the space.`;
  return (
    <NotificationCard title="Media kept" onClose={onClose}>
      <p className="text-sm text-muted-foreground" data-delete-kept-media="">
        {text}
      </p>
    </NotificationCard>
  );
}

/// The media a delete window offers, as a grid of previews. A video shows the
/// poster of the element `posterSlug` names for it: the one element of
/// `Delete element?`, the first selected element that uses the file in a
/// group (`referenced_by`).
export function DeleteMediaPreviewGrid({
  media,
  vaultPath,
  thumbsRootPath,
  posterSlug,
}: {
  media: DeleteBlockMedia[];
  vaultPath: string;
  thumbsRootPath?: string;
  posterSlug: (item: DeleteBlockMedia) => string | null;
}) {
  const resolvedThumbsRoot = thumbsRootPath ?? fallbackThumbsRoot(vaultPath);

  return (
    <div
      className="grid max-h-56 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-5"
      data-delete-media-previews=""
    >
      {media.map((item) => {
        const poster = item.kind === "video" ? posterSlug(item) : null;
        return (
          <div
            key={item.path}
            className="bg-component-fill relative aspect-square overflow-hidden rounded-1 border border-border"
            title={item.path}
          >
            {item.kind === "image" ? (
              // A file that will not load keeps the tile's fill (Е6.8).
              <MissingAwareImage
                src={mediaUrl(vaultPath, item.path)}
                className="size-full object-cover"
                draggable={false}
              />
            ) : item.kind === "video" ? (
              <video
                src={mediaUrl(vaultPath, item.path)}
                poster={poster === null ? undefined : thumbnailUrl(resolvedThumbsRoot, poster)}
                className="size-full object-cover"
                muted
                draggable={false}
                playsInline
                preload="metadata"
              />
            ) : (
              <div className="flex size-full items-center justify-center px-2 text-center text-sm text-muted-foreground">
                {item.kind.toUpperCase()}
              </div>
            )}
            <div className="absolute inset-x-0 bottom-0 truncate bg-background/80 px-1 py-0.5 text-sm text-muted-foreground">
              {item.file_name}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function mediaCountLabel(count: number) {
  return count === 1 ? "1 media file" : `${count} media files`;
}

function mediaCountVerb(count: number) {
  return count === 1 ? "is" : "are";
}
