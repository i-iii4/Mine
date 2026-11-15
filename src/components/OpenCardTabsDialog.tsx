// The question before cards dropped on the tab bar open many tabs at once
// (SPEC_TABS.md, В86, п. 6; DESIGN_SYSTEM.md, «Окна», «Тексты окон»).

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

/** For the screen reader only: the title and the buttons say the rest. */
export const OPEN_CARD_TABS_DESCRIPTION = "Each element opens in a tab of its own.";

/** The window's title for `count` tabs. */
export function openCardTabsTitle(count: number): string {
  return `Open ${count} tabs?`;
}

/** Open while `count` names the tabs the drop would open. */
export function OpenCardTabsDialog({
  count,
  onCancel,
  onConfirm,
}: {
  count: number | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog
      open={count !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{openCardTabsTitle(count ?? 0)}</AlertDialogTitle>
          <AlertDialogDescription className="sr-only">{OPEN_CARD_TABS_DESCRIPTION}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Open</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
