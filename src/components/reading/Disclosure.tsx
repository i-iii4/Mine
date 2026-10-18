import {
  createContext,
  useContext,
  useMemo,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface DisclosureState {
  open: boolean;
  toggle(): void;
}

const DisclosureContext = createContext<DisclosureState | null>(null);

/** Keyboard focus as on buttons (`--ring`). */
const SUMMARY_FOCUS_CLASSES = "outline-none focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring";

/**
 * A disclosure of the article: `<details>` from a note's HTML and a callout
 * that folds (SPEC_READING_MODE.md, Ч4, Ч8). It starts as the note says and
 * remembers nothing: the state is never written to the file. The page keeps
 * the state rather than the browser, so a click, Enter and Space on the
 * summary toggle it the same everywhere, without animation.
 */
export function DisclosureRoot({
  defaultOpen,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDetailsElement> & { defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const state = useMemo<DisclosureState>(() => ({ open, toggle: () => setOpen((value) => !value) }), [open]);
  return (
    <DisclosureContext.Provider value={state}>
      <details {...props} open={open} className={className} data-disclosure-open={open ? "true" : "false"}>
        {children}
      </details>
    </DisclosureContext.Provider>
  );
}

/** The summary of the nearest disclosure, the chevron after its content:
 *  pointing right while folded, down while open. A summary outside one is
 *  drawn as written. */
export function DisclosureSummary({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & { children?: ReactNode }) {
  const state = useContext(DisclosureContext);
  if (!state) {
    return (
      <summary {...props} className={className}>
        {children}
      </summary>
    );
  }
  const onClick = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    // A click the browser makes of Enter or Space comes with no pointer
    // (`detail` 0): the key has already toggled.
    if (event.detail !== 0) state.toggle();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    state.toggle();
  };
  const onKeyUp = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === " ") event.preventDefault();
  };
  return (
    <summary
      {...props}
      tabIndex={0}
      aria-expanded={state.open}
      className={cn("flex items-center gap-1", SUMMARY_FOCUS_CLASSES, className)}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      data-disclosure-summary=""
    >
      {children}
      <ChevronRight
        aria-hidden="true"
        className={cn("size-[13px] shrink-0 text-muted-foreground", state.open && "rotate-90")}
        data-disclosure-chevron=""
      />
    </summary>
  );
}
