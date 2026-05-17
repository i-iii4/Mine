export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

export function isOverlayKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest("[role='dialog'], [data-radix-popper-content-wrapper]") !== null;
}

export function isDetailShortcutBlockedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const dialog = target.closest("[role='dialog']");
  if (dialog && !(dialog as HTMLElement).hasAttribute("data-detail-root")) return true;
  return target.closest(
    "[data-image-preview-overlay], [data-radix-popper-content-wrapper], [role='menu'], [role='listbox']",
  ) !== null;
}
