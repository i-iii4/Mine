// The one layout of a screen that stands in for the feed or the window: the
// first launch (VaultPicker), an empty space (EmptySpaceOnboarding), a folder
// that is gone (SpaceUnavailable). See DESIGN_SYSTEM.md, «Полноэкранные
// состояния».
//
// The anatomy is the dialog's, laid on the page: a column as wide as a
// dialog (`max-w-lg`), the title `text-lg font-semibold` over the text
// `text-base text-muted-foreground` 8px apart (DialogHeader), the parts 16px
// apart (DialogContent), the actions in one row, the primary first. Without
// a title the text is the screen's first line and takes the title's colour,
// the foreground; under a title it is muted, as a dialog's description. Each
// screen used to set its own: a 12px sentence in a 320px column, a 384px
// column with 4px under the title and 24px over the button, a 512px one with
// 24px between its parts (user's request of 09.10.2026).

import type { ReactNode } from "react";

interface ScreenStateProps {
  /** What happened, in a few words. A screen that says one thing has none. */
  title?: string;
  /** What it means for the user, in a sentence or two. */
  description: ReactNode;
  /** A line under the description that names a thing: the folder's path. */
  detail?: ReactNode;
  /** The buttons, in one row, the primary first. */
  actions: ReactNode;
  /** What follows the actions: a step, a note, an error, other spaces. */
  children?: ReactNode;
}

export function ScreenState({ title, description, detail, actions, children }: ScreenStateProps) {
  return (
    <div className="grid w-full max-w-lg gap-4 text-left" data-screen-state="">
      <div className="grid gap-2">
        {title !== undefined && <h1 className="text-lg font-semibold text-foreground">{title}</h1>}
        <p className={title === undefined ? "text-base text-foreground" : "text-base text-muted-foreground"}>
          {description}
        </p>
        {detail}
      </div>
      <div className="flex items-center gap-2">{actions}</div>
      {children}
    </div>
  );
}
