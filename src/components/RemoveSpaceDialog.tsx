// The question before a space leaves the list of spaces: one window for the
// space switcher and the Spaces section of Settings (SPEC_DEEP_AUDIT.md, Е6.9;
// DESIGN_SYSTEM.md, «Окна», «Тексты окон»).

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

/** The space's folder name from its path. */
function spaceName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** The question before a space leaves the list: open while `path` names
 *  the space. */
export function RemoveSpaceDialog({
  path,
  onCancel,
  onConfirm,
}: {
  path: string | null;
  onCancel: () => void;
  onConfirm: (path: string) => void;
}) {
  return (
    <AlertDialog
      open={path !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Remove {path ? spaceName(path) : "space"} from the list?
          </AlertDialogTitle>
          <AlertDialogDescription>
            The folder and its files stay where they are. Open tabs of this
            space switch to choosing a space. You can add it back with Add
            space.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {/* Deliberately not destructive: red would say "data is about to be
              lost", which is the exact misreading this dialog exists to
              prevent. It breaks a link and keeps the folder, so it takes the
              detach colour, as the menu item that opened it (DESIGN_SYSTEM.md,
              «Два уровня опасных действий»). */}
          <AlertDialogAction
            variant="default"
            className="text-detach"
            onClick={() => {
              if (path) onConfirm(path);
            }}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
