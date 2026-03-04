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
  const items: PreviewCard[] =
    cards.length === 0 ? [{ type: "empty" }] : cards.slice(0, 3);

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
            transition: "transform 350ms cubic-bezier(0.4, 0, 0.2, 1)",
            ...(i === items.length - 1
              ? {
                  transformOrigin: "center right",
                  transform: hovered ? "translateX(-1px) rotate(-1deg)" : "none",
                }
              : {
                  transformOrigin: "bottom left",
                  transform: hovered
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
  switch (card.type) {
    case "image":
      return (
        <div
          className="h-full w-full bg-muted bg-cover bg-center"
          style={{ backgroundImage: `url(${card.url})` }}
        />
      );
    case "text":
      return (
        <div className="flex h-full w-full flex-col items-start justify-center gap-[2px] bg-muted px-[3px]">
          <div className="h-[1px] w-[80%] rounded-2 bg-muted-foreground/20" />
          <div className="h-[1px] w-[60%] rounded-2 bg-muted-foreground/20" />
          <div className="h-[1px] w-[70%] rounded-2 bg-muted-foreground/20" />
        </div>
      );
    case "empty":
      return <div className="h-full w-full rounded-2 border border-border bg-background" />;
  }
}
