import { createContext, useContext, type ComponentType, type ReactNode, type SVGProps } from "react";
import {
  Bug,
  Check,
  CircleCheck,
  CircleHelp,
  ClipboardList,
  Flame,
  Info,
  List,
  Pencil,
  Quote,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import { CALLOUT_TYPES, type CalloutFold, type CalloutIconName, type CalloutType } from "@/lib/reading/callouts";
import { cn } from "@/lib/utils";
import { DisclosureRoot, DisclosureSummary } from "./Disclosure";

const CALLOUT_ICONS: Record<CalloutIconName, ComponentType<SVGProps<SVGSVGElement>>> = {
  Pencil,
  ClipboardList,
  Info,
  CircleCheck,
  Flame,
  Check,
  CircleHelp,
  TriangleAlert,
  X,
  Zap,
  Bug,
  List,
  Quote,
};

interface CalloutState {
  type: CalloutType;
  fold: CalloutFold;
}

const CalloutContext = createContext<CalloutState | null>(null);

/** The box (Ч8, «Вид»): zone level 1, a 1 px line, the card corner, the
 *  media paragraph's margins; inside, a surface's 4 px. */
const CALLOUT_BOX_CLASSES = "my-5 rounded-card border border-border bg-card p-surface text-foreground";
/** The title row: 32 high, text on the plate's 8 px, so 12 from the frame. */
const CALLOUT_TITLE_CLASSES = "min-h-row px-plate py-1.5 leading-5 font-semibold";

/**
 * A callout of the article (SPEC_READING_MODE.md, Ч8): the box, the title row
 * with the type's icon, and the body. With `-` or `+` after its type it folds
 * by its title like a `<details>`, starting folded or unfolded as written.
 * Without colours of its own: those of the types wait for the user's
 * decision (В3 (а)).
 */
export function Callout({ type, fold, children }: { type: CalloutType; fold: CalloutFold; children?: ReactNode }) {
  const state = { type, fold };
  const props = { "data-callout": type, className: CALLOUT_BOX_CLASSES } as const;
  return (
    <CalloutContext.Provider value={state}>
      {fold === null ? (
        <div {...props}>{children}</div>
      ) : (
        <DisclosureRoot {...props} defaultOpen={fold === "unfolded"} data-callout-fold={fold}>
          {children}
        </DisclosureRoot>
      )}
    </CalloutContext.Provider>
  );
}

/** A callout's title row; in a callout that folds, its summary. */
export function CalloutTitle({ children }: { children?: ReactNode }) {
  const state = useContext(CalloutContext);
  const Icon = CALLOUT_ICONS[CALLOUT_TYPES[state?.type ?? "note"].icon];
  const content = (
    <>
      <Icon aria-hidden="true" className="size-[13px] shrink-0" data-callout-icon={state?.type} />
      <span className="min-w-0">{children}</span>
    </>
  );
  if (state?.fold) {
    return (
      <DisclosureSummary className={cn(CALLOUT_TITLE_CLASSES, "gap-plate")} data-callout-title="">
        {content}
      </DisclosureSummary>
    );
  }
  return (
    <div className={cn(CALLOUT_TITLE_CLASSES, "flex items-center gap-plate")} data-callout-title="">
      {content}
    </div>
  );
}

/** A callout's body: the article's own content under the title, 12 px from
 *  the frame at the sides and below. Empty, the callout is its title. */
export function CalloutBody({ children, empty }: { children?: ReactNode; empty: boolean }) {
  if (empty) return null;
  return (
    <div
      className="px-plate pb-plate [&>:first-child]:mt-0 [&>:last-child]:mb-0"
      data-callout-body=""
    >
      {children}
    </div>
  );
}
