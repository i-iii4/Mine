export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

/** Whether the keyboard stands in text: the note's editor, a table cell's editor,
 *  a field or anything else editable. By the focus, not by a key's target: the
 *  answer is about where the caret is (SPEC_KEYBOARD.md, М9). */
export function isKeyboardInText(): boolean {
  return isEditableKeyboardTarget(document.activeElement);
}

/** Whether a key types a character: one character, and no ⌘, ⌥ or ⌃. ⇧ only says
 *  which one. A dead key is not one: it names itself "Dead". */
export function isPrintableKeyboardKey(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "altKey" | "ctrlKey">,
): boolean {
  return event.key.length === 1 && !event.metaKey && !event.altKey && !event.ctrlKey;
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
