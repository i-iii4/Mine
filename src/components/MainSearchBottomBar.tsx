import { forwardRef } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

interface MainSearchBottomBarProps {
  entered: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onClearQuery: () => void;
  onClose: () => void;
}

export const MainSearchBottomBar = forwardRef<HTMLInputElement, MainSearchBottomBarProps>(
  function MainSearchBottomBar(
    {
      entered,
      query,
      onQueryChange,
      onClearQuery,
      onClose,
    },
    ref,
  ) {
    return (
      <div
        className="surface-search-bottom-bar pointer-events-none absolute inset-x-0 bottom-0 z-30 h-8"
        data-entered={entered ? "true" : "false"}
        data-main-search-bottom-bar=""
      >
        <div
          aria-hidden="true"
          className="surface-search-bottom-bar-plane absolute inset-0 border-t border-border bg-accent"
          data-main-search-bottom-bar-plane=""
        />
        <div className="surface-search-bottom-bar-content pointer-events-auto relative flex h-full min-w-0 items-center gap-2 px-8">
          <Search
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
            strokeWidth={1.75}
          />
          <Input
            ref={ref}
            aria-label="Search cards"
            placeholder="Search cards..."
            variant="ghost"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              if (query) {
                onClearQuery();
                return;
              }
              onClose();
            }}
            className="h-full flex-1 px-0 py-0"
          />
        </div>
      </div>
    );
  },
);
