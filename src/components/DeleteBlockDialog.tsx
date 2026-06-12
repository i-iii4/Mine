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
import { legacyThumbsRoot, mediaUrl, thumbnailUrl } from "@/lib/assets";
import type { DeleteBlockMedia, DeleteBlockPlan } from "@/types";

interface DeleteBlockDialogProps {
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

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        size="default"
        className={hasUnusedMedia ? "sm:max-w-2xl" : "sm:max-w-md"}
      >
        <AlertDialogHeader className="place-items-start text-left">
          <AlertDialogTitle>
            Delete element?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {deleteDialogDescription(error, plan, unusedCount, sharedCount)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {plan && hasUnusedMedia ? (
          <DeleteMediaPreviewGrid
            media={plan.unused_media}
            vaultPath={vaultPath}
            thumbsRootPath={thumbsRootPath}
            blockSlug={plan.slug}
          />
        ) : null}
        <AlertDialogFooter className={hasUnusedMedia ? "sm:justify-between" : undefined}>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {hasUnusedMedia ? (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <AlertDialogAction onClick={onKeepMedia}>
                Keep media
              </AlertDialogAction>
              <DeleteAction disabled={!plan || Boolean(error)} onClick={onDeleteMedia} />
            </div>
          ) : (
            <DeleteAction disabled={!plan || Boolean(error)} onClick={onDeleteMedia} />
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function deleteDialogDescription(
  error: string | null,
  plan: DeleteBlockPlan | null,
  unusedCount: number,
  sharedCount: number,
) {
  if (error) return `Could not prepare delete plan: ${error}`;
  if (!plan) return "Checking media references before deleting.";
  if (unusedCount > 0 && sharedCount > 0) {
    return `${mediaCountLabel(unusedCount)} ${mediaCountVerb(unusedCount)} only used by this element. ${mediaCountLabel(sharedCount)} ${mediaCountVerb(sharedCount)} used by other cards and will stay in the vault.`;
  }
  if (unusedCount > 0) {
    return `${mediaCountLabel(unusedCount)} ${mediaCountVerb(unusedCount)} only used by this element. Delete ${mediaObjectPronoun(unusedCount)} too, or keep ${mediaObjectPronoun(unusedCount)} in the vault.`;
  }
  if (sharedCount > 0) {
    return `${mediaCountLabel(sharedCount)} ${mediaCountVerb(sharedCount)} used by other cards and will stay in the vault. Only this card will be deleted.`;
  }
  return "This will delete only the element.";
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
  const resolvedThumbsRoot = thumbsRootPath ?? legacyThumbsRoot(vaultPath);

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
          <div className="absolute inset-x-0 bottom-0 truncate bg-background/80 px-1 py-0.5 text-xs text-muted-foreground">
            {item.file_name}
          </div>
        </div>
      ))}
    </div>
  );
}
