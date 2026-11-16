// «Card view» in the Display panel, Full page or Peek (SPEC_CARD_PEEK.md,
// О1; user's requests of 23.10.2026; src/lib/cardView.ts).

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
import { broadcastSettingsChange } from "@/lib/settingsChanged";
import { TrialRadios } from "./CompactStackMenu";

/** The group of the open card's view, named by its caption. */
export function CardViewMenu() {
  const cardView = useCardView();
  const peekWidth = usePeekWidth();
  return (
    <div data-card-view-menu="">
      <TrialRadios
        value={cardView}
        choices={CARD_VIEWS}
        labels={CARD_VIEW_LABELS}
        caption="Card view"
        onChoose={(choice) => {
          setCardView(choice);
          broadcastSettingsChange(CARD_VIEW_STORAGE_KEY);
        }}
      />
      {/* The Peek window's width, only while Peek is chosen (О3). */}
      {cardView === "peek" && (
        <TrialRadios
          value={peekWidth}
          choices={PEEK_WIDTHS}
          labels={PEEK_WIDTH_LABELS}
          caption="Peek width"
          onChoose={(choice) => {
            setPeekWidth(choice);
            broadcastSettingsChange(PEEK_WIDTH_STORAGE_KEY);
          }}
        />
      )}
    </div>
  );
}
