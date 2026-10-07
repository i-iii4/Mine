import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * The `alignOffset` that lines a menu's start edge up with its trigger's
 * visible plate rather than with the trigger's box (DESIGN_SYSTEM.md,
 * «Всплывающие элементы», «Выравнивание»). A chrome trigger is taller and
 * wider than its plate: the plate stands its chrome inset inside the box.
 * The offset is measured from the plate on every opening, never restated
 * as a number: the space switcher kept a copied 12 after its inset became
 * 8 and opened 4px adrift (user's report of 07.10.2026). Without a plate
 * the trigger's own left padding stands for it.
 */
export function useMenuAlignToPlate(
  triggerRef: RefObject<HTMLElement | null>,
  open: boolean,
): number {
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const plate = trigger.querySelector<HTMLElement>("[data-chrome-plate]");
    const next = plate
      ? plate.getBoundingClientRect().left - trigger.getBoundingClientRect().left
      : Number.parseFloat(getComputedStyle(trigger).paddingLeft);
    if (Number.isFinite(next)) setOffset(next);
  }, [open, triggerRef]);
  return offset;
}
