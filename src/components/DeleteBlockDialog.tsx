import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { NotificationCard } from "@/components/NotificationCard";
import { fallbackThumbsRoot, mediaUrl, thumbnailUrl } from "@/lib/assets";
import type { DeleteBlockMedia, DeleteBlockPlan } from "@/types";

interface DeleteBlockDialogProps {
  /** Asked for: the window shows once the plan or its error is here. */
  open: boolean;
  vaultPath: string;
  thumbsRootPath?: string;
  plan: DeleteBlockPlan | null;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onKeepMedia: () => void;
  onDeleteMedia: () => void;
}

export function DeleteBlockDialog({
  open,
  vaultPath,
  thumbsRootPath,
  plan,
  error,
  onOpenChange,
  onKeepMedia,
  onDeleteMedia,
}: DeleteBlockDialogProps) {
  const unusedCount = plan?.unused_media.length ?? 0;
  const sharedCount = plan?.shared_media.length ?? 0;
  const hasUnusedMedia = unusedCount > 0;
  const description = deleteDialogDescription(error, unusedCount, sharedCount);
  // The window waits for its plan, read from the index at once, and opens
  // already at its width: no "checking" state that widens when the media
  // arrive (user's decision of 11.10.2026).
  const ready = plan !== null || error !== null;

  return (
    <AlertDialog open={open && ready} onOpenChange={onOpenChange}>
      {/* A question, unless it shows the media that go with the element. */}
      <AlertDialogContent widthRole={hasUnusedMedia ? "content" : "question"}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete element?
          </AlertDialogTitle>
          {description ? (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          ) : (
            // Radix requires a description for the dialog to be announced; keep
            // it for screen readers when there is nothing worth showing.
            <AlertDialogDescription className="sr-only">
              Delete this element.
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {plan && hasUnusedMedia ? (
          <DeleteMediaPreviewGrid
            media={plan.unused_media}
            vaultPath={vaultPath}
            thumbsRootPath={thumbsRootPath}
            blockSlug={plan.slug}
          />
        ) : null}
        {/* One row at the bottom right, as in every window: Cancel, the
            alternative, and Delete, the one primary, last. */}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {hasUnusedMedia && (
            <AlertDialogAction variant="secondary" onClick={onKeepMedia}>
              Keep media
            </AlertDialogAction>
          )}
          <DeleteAction disabled={!plan || Boolean(error)} onClick={onDeleteMedia} />
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/// Describes what happens to media, and only that.
///
/// A card with no media has nothing to explain: the old copy said the delete
/// would remove "only the element", which answers a question nobody asked and
/// invites another one — what else could it have removed? Returns null there so
/// the dialog shows the title alone.
function deleteDialogDescription(
  error: string | null,
  unusedCount: number,
  sharedCount: number,
): string | null {
  if (error) return `Could not prepare delete plan: ${error}`;
  if (unusedCount > 0 && sharedCount > 0) {
    return `${mediaCountLabel(unusedCount)} ${mediaCountVerb(unusedCount)} only used by this element. ${mediaCountLabel(sharedCount)} ${mediaCountVerb(sharedCount)} used by other elements and will stay in the space.`;
  }
  if (unusedCount > 0) {
    return `${mediaCountLabel(unusedCount)} ${mediaCountVerb(unusedCount)} only used by this element. Delete ${mediaObjectPronoun(unusedCount)} too, or keep ${mediaObjectPronoun(unusedCount)} in the space.`;
  }
  if (sharedCount > 0) {
    return `${mediaCountLabel(sharedCount)} ${mediaCountVerb(sharedCount)} used by other elements and will stay in the space. Only this element will be deleted.`;
  }
  return null;
}

/// The files the window offered for deletion that the deletion kept.
///
/// The window's plan comes from the index; the deletion checks the notes on
/// disk, and a file another note uses stays (decision of 11.10.2026).
/// `kept` names every file of the card that stayed, the ones the window
/// already said would stay included: only the offered ones are news.
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

function mediaCountLabel(count: number) {
  return count === 1 ? "1 media file" : `${count} media files`;
}

function mediaCountVerb(count: number) {
  return count === 1 ? "is" : "are";
}

function mediaObjectPronoun(count: number) {
  return count === 1 ? "it" : "them";
}

function DeleteAction({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <AlertDialogAction
      variant="destructive"
      disabled={disabled}
      onClick={onClick}
    >
      Delete
    </AlertDialogAction>
  );
}

function DeleteMediaPreviewGrid({
  media,
  vaultPath,
  thumbsRootPath,
  blockSlug,
}: {
  media: DeleteBlockMedia[];
  vaultPath: string;
  thumbsRootPath?: string;
  blockSlug: string;
}) {
  const resolvedThumbsRoot = thumbsRootPath ?? fallbackThumbsRoot(vaultPath);

  return (
    <div className="grid max-h-56 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-5">
      {media.map((item) => (
        <div
          key={item.path}
          className="bg-component-fill relative aspect-square overflow-hidden rounded-1 border border-border"
          title={item.path}
        >
          {item.kind === "image" ? (
            <img
              src={mediaUrl(vaultPath, item.path)}
              alt=""
              className="size-full object-cover"
              draggable={false}
            />
          ) : item.kind === "video" ? (
            <video
              src={mediaUrl(vaultPath, item.path)}
              poster={thumbnailUrl(resolvedThumbsRoot, blockSlug)}
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
      ))}
    </div>
  );
}
