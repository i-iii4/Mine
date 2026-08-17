// The standing explanation of why cards sometimes arrive slowly.
//
// People who hit this go to a forum and find the same advice every time: mark
// the folder Keep Downloaded. The app brings that advice itself, and says
// plainly that the setting belongs to the system — there is no programmatic way
// to pin a folder, and pretending otherwise would be a lie the user discovers
// on their own. See SPEC_CLOUD_STORAGE.md Х20, Х22.

import { Button } from "@/components/ui/button";

interface CloudDisclaimerProps {
  /// Files of this space whose contents iCloud is holding right now.
  /// `null` while the number is still being counted.
  offloadedCount: number | null;
  /// Opens the space in Finder, where the setting actually lives.
  onRevealSpace?: () => void;
}

export function CloudDisclaimer({ offloadedCount, onRevealSpace }: CloudDisclaimerProps) {
  return (
    <div className="grid gap-2 rounded-1 border border-border p-3" data-cloud-disclaimer="">
      <p className="text-base text-foreground">Files in iCloud</p>

      <p className="text-sm text-muted-foreground">
        {offloadedCount === null
          ? "Counting the files iCloud is currently holding…"
          : offloadedCount === 0
            ? "Every file of this space is on this Mac right now."
            : `The contents of ${offloadedCount} ${
                offloadedCount === 1 ? "file" : "files"
              } are in iCloud right now, not on this Mac.`}
      </p>

      <p className="text-sm text-muted-foreground">
        macOS keeps this space’s files in iCloud and downloads each one when
        it’s needed. To keep the folder on this Mac, right-click it in Finder
        and choose <span className="text-foreground">Keep Downloaded</span>.
        This is a macOS setting — Mine cannot turn it on for you.
      </p>

      <p className="text-sm text-muted-foreground">
        Another way: turn off
        <span className="text-foreground"> Optimize Mac Storage</span> in
        System Settings. That affects all of iCloud Drive, not just this
        folder.
      </p>

      {onRevealSpace && (
        <div>
          <Button size="sm" onClick={onRevealSpace}>
            Show space in Finder
          </Button>
        </div>
      )}
    </div>
  );
}
