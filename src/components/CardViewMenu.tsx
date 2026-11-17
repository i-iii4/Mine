// «Element view» in the Display panel, Full page or Peek (SPEC_CARD_PEEK.md,
// О1; user's requests of 23.10.2026; src/lib/cardView.ts): the group as
// data, for the panel's one description (src/lib/displayMenu.ts).

import { useCallback, useMemo } from "react";
import {
  CARD_VIEWS,
  CARD_VIEW_LABELS,
  CARD_VIEW_STORAGE_KEY,
  PEEK_WIDTHS,
  PEEK_WIDTH_LABELS,
  PEEK_WIDTH_STORAGE_KEY,
  setCardView,
  setPeekWidth,
  useCardView,
  usePeekWidth,
} from "@/lib/cardView";
import { chosenValue, displayChoice, labelledChoices, type DisplayGroups } from "@/lib/displayMenu";
import { broadcastSettingsChange } from "@/lib/settingsChanged";
import type { MenuAction } from "@/types";

export const CARD_VIEW_ID = "card-view";
export const PEEK_WIDTH_ID = "peek-width";

const VIEW_CHOICES = labelledChoices(CARD_VIEWS, CARD_VIEW_LABELS);
const WIDTH_CHOICES = labelledChoices(PEEK_WIDTHS, PEEK_WIDTH_LABELS);

/**
 * The group of the open card's view, named by its caption, and under it the
 * Peek window's width, only while Peek is chosen (О3). The panel may grow
 * by the width's rows while it is open: its largest holds them.
 */
export function useCardViewGroups(): DisplayGroups {
  const cardView = useCardView();
  const peekWidth = usePeekWidth();

  const groups = useMemo(() => {
    const view = displayChoice(CARD_VIEW_ID, "Element view", cardView, VIEW_CHOICES);
    const width = displayChoice(PEEK_WIDTH_ID, "Peek width", peekWidth, WIDTH_CHOICES);
    return { now: [cardView === "peek" ? [...view, ...width] : view], largest: [[...view, ...width]] };
  }, [cardView, peekWidth]);

  const apply = useCallback((action: MenuAction): boolean => {
    const view = chosenValue(action, CARD_VIEW_ID, VIEW_CHOICES);
    if (view !== null) {
      setCardView(view);
      broadcastSettingsChange(CARD_VIEW_STORAGE_KEY);
      return true;
    }
    const width = chosenValue(action, PEEK_WIDTH_ID, WIDTH_CHOICES);
    if (width !== null) {
      setPeekWidth(width);
      broadcastSettingsChange(PEEK_WIDTH_STORAGE_KEY);
      return true;
    }
    return false;
  }, []);

  return useMemo(() => ({ groups: groups.now, largest: groups.largest, apply }), [groups, apply]);
}
