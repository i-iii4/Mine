import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  COMMAND_CONTEXT_TITLES,
  commandsForContext,
  type CommandContext,
} from "@/lib/commandRegistry";

interface CommandsOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const CONTEXT_ORDER: readonly CommandContext[] = [
  "global",
  "feed",
  "element",
  "selection",
];

/**
 * Every keyboard command in one place, straight from the registry.
 *
 * The bottom bar shows only what works right now — which also means a command
 * never seen in its state is never learned. This overlay is the other half of
 * that contract: the full table, grouped by the surface a command belongs to.
 */
export function CommandsOverlay({ open, onOpenChange }: CommandsOverlayProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-commands-overlay="">
        <DialogHeader className="place-items-start text-left">
          <DialogTitle>Commands</DialogTitle>
          <DialogDescription>
            Contextual commands work on the surface they belong to.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {CONTEXT_ORDER.map((context) => (
            <section key={context} data-commands-overlay-section={context}>
              <h3 className="mb-1.5 font-mono text-sm text-tertiary-foreground">
                {COMMAND_CONTEXT_TITLES[context]}
              </h3>
              <ul className="grid gap-1">
                {commandsForContext(context).map((command) => (
                  <li
                    key={command.id}
                    className="flex items-center gap-3 font-mono text-sm leading-none"
                  >
                    <span className="inline-flex h-5 min-w-[5ch] shrink-0 items-center justify-center rounded-[2px] bg-component-fill px-[1ch] text-foreground">
                      {command.combo}
                    </span>
                    <span className="text-muted-foreground">{command.name}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
