export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

/** Whether the key lands inside a dialog, which owns the keyboard while open. */
export function isDialogKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest("[role='dialog'], [role='alertdialog']") !== null;
}

export function isOverlayKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest("[role='dialog'], [data-radix-popper-content-wrapper]") !== null;
}

/** Whether the key lands in a layer above the page that owns it: a dialog,
 *  a menu, a listbox or the image preview. An open card and the sidebar over
 *  the feed (SPEC_NARROW_WINDOW.md, У4) are surfaces of the page, not such
 *  layers, though both are dialogs to assistive technology. */
export function isDetailShortcutBlockedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const dialog = target.closest("[role='dialog']");
  if (
    dialog
    && !dialog.hasAttribute("data-detail-root")
    && !dialog.hasAttribute("data-sidebar-overlay-panel")
  ) {
    return true;
  }
  return target.closest(
    "[data-image-preview-overlay], [data-radix-popper-content-wrapper], [role='menu'], [role='listbox']",
  ) !== null;
}
