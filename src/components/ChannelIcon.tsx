import type { PreviewCard } from "@/types";

interface ChannelIconProps {
  cards: PreviewCard[];
  hovered?: boolean;
}

const CARD = 24;
const SPREAD = 4; // px horizontal spread between cards
const MAX_CARDS = 3;
const FIXED_W = CARD + SPREAD * (MAX_CARDS - 1); // always 32px

export function ChannelIcon({ cards, hovered = false }: ChannelIconProps) {
  // No cards — reserve space but render nothing
  if (cards.length === 0) {
    return <div className="shrink-0" style={{ width: FIXED_W, height: CARD }} />;
  }

  const items = cards.slice(0, 3);
  // Animate only when multiple cards can spread
  const canAnimate = items.length > 1;

  return (
    <div
      className="relative shrink-0"
      style={{ width: FIXED_W, height: CARD }}
    >
      {items.map((card, i) => (
        <div
          key={i}
          className="absolute top-0 overflow-hidden rounded-2 border border-background"
          style={{
            left: (items.length - 1 - i) * SPREAD,
            width: CARD,
            height: CARD,
            zIndex: i,
            transition: canAnimate ? "transform 350ms cubic-bezier(0.4, 0, 0.2, 1)" : "none",
            ...(i === items.length - 1
              ? {
                  transformOrigin: "center right",
                  transform: canAnimate && hovered ? "translateX(-1px) rotate(-1deg)" : "none",
                }
              : {
                  transformOrigin: "bottom left",
                  transform: canAnimate && hovered
                    ? `translateX(${(items.length - 1 - i) + (items.length - 1 - i >= 2 ? 1 : 0)}px) rotate(${(items.length - 1 - i) * 2 + (items.length - 1 - i) * 1}deg)`
                    : `rotate(${(items.length - 1 - i) * 2}deg)`,
                }),
          }}
        >
          <MiniCard card={card} />
        </div>
      ))}
    </div>
  );
}

function MiniCard({ card }: { card: PreviewCard }) {
  return (
    <div
      className="h-full w-full bg-accent bg-cover bg-center"
      style={{ backgroundImage: `url(${card.url})` }}
    />
  );
}
