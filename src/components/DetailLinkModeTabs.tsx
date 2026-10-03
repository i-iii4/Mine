import { Fragment } from "react";
import { Link, List, type LucideIcon } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { DetailLinkMode } from "@/types";

// Which collections the sidebar lists while a card is open: all of them, or
// those the card is in. Chrome tabs (DESIGN_SYSTEM.md, «Вкладки хрома»);
// when the filter row runs short of room, each segment keeps only its icon
// (useSidebarRowFit.ts).

const DETAIL_LINK_MODES: readonly {
  value: DetailLinkMode;
  label: string;
  name: string;
  Icon: LucideIcon;
}[] = [
  { value: "all", label: "All", name: "All collections", Icon: List },
  { value: "linked", label: "Connected", name: "Connected collections", Icon: Link },
];

export function DetailLinkModeTabs({
  value,
  onChange,
  iconsOnly = false,
  plate = "hover",
  entered,
  className,
}: {
  value: DetailLinkMode;
  onChange: (value: DetailLinkMode) => void;
  /** The row shows the icons alone: each segment names itself on hover. */
  iconsOnly?: boolean;
  /** The plate behind the segments: on hover only, or always. */
  plate?: "hover" | "always";
  entered?: boolean;
  className?: string;
}) {
  const choose = (next: string) => {
    const mode = DETAIL_LINK_MODES.find((candidate) => candidate.value === next);
    if (mode) onChange(mode.value);
  };
  return (
    <TooltipProvider>
      <Tabs value={value} onValueChange={choose} className="h-full gap-0">
        <TabsList
          variant="chrome"
          plate={plate}
          aria-label="Collection filter"
          data-entered={entered === undefined ? undefined : entered ? "true" : "false"}
          data-detail-link-mode-tabs=""
          className={className}
        >
          {DETAIL_LINK_MODES.map(({ value: mode, label, name, Icon }) => {
            const trigger = (
              <TabsTrigger value={mode} aria-label={name} data-row-fit-segment="">
                <span data-row-fit-label="">{label}</span>
                <Icon aria-hidden="true" data-row-fit-icon="" />
              </TabsTrigger>
            );
            return iconsOnly ? (
              <Tooltip key={mode}>
                <TooltipTrigger asChild>{trigger}</TooltipTrigger>
                <TooltipContent side="bottom">{name}</TooltipContent>
              </Tooltip>
            ) : (
              <Fragment key={mode}>{trigger}</Fragment>
            );
          })}
        </TabsList>
      </Tabs>
    </TooltipProvider>
  );
}
