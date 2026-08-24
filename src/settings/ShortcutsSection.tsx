import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { bindingLabel, type CommandBinding } from "@/lib/commandBinding";
import {
  COMMAND_CONTEXT_TITLES,
  allCommands,
  getCommandOverrides,
  subscribeToCommands,
  type CommandContext,
  type ResolvedCommand,
} from "@/lib/commandRegistry";
import { persistCommandOverrides } from "@/lib/shortcutOverrides";
import { rejectionMessage, validateShortcut } from "@/lib/shortcutValidation";

const CONTEXT_ORDER: readonly CommandContext[] = ["global", "feed", "element", "selection"];

const FIXED_REASONS: Record<NonNullable<ResolvedCommand["fixed"]>, string> = {
  structural: "Part of how the interface works",
  system: "macOS expects this one",
};

/// A chord is recorded from a real key press: typing a combination as text
/// invents combinations that no keyboard can produce.
function bindingFromEvent(event: KeyboardEvent): CommandBinding | null {
  if (["Meta", "Shift", "Alt", "Control"].includes(event.key)) return null;
  const key = /^[a-zA-Z]$/.test(event.key)
    ? event.key.toLowerCase()
    : event.code.startsWith("Key")
      ? event.code.slice(3).toLowerCase()
      : event.key;
  return {
    key,
    meta: event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
    ctrl: event.ctrlKey,
  };
}

export function ShortcutsSection() {
  const [commands, setCommands] = useState<ResolvedCommand[]>(allCommands);
  const [recording, setRecording] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const recordingRef = useRef<string | null>(null);
  recordingRef.current = recording;

  useEffect(() => subscribeToCommands(() => setCommands(allCommands())), []);

  const assign = useCallback(async (commandId: string, binding: CommandBinding) => {
    const rejection = validateShortcut(commandId, binding, allCommands());
    if (rejection) {
      setError({ id: commandId, message: rejectionMessage(rejection) });
      return;
    }
    setError(null);
    await persistCommandOverrides({ ...getCommandOverrides(), [commandId]: binding });
    setCommands(allCommands());
  }, []);

  // While recording, the whole keyboard belongs to this row: without capture
  // the chord being recorded would also run the command it currently triggers.
  useEffect(() => {
    if (!recording) return;
    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(null);
        return;
      }
      const binding = bindingFromEvent(event);
      if (!binding) return;
      const commandId = recordingRef.current;
      setRecording(null);
      if (commandId) void assign(commandId, binding);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [assign, recording]);

  const reset = async (commandId: string) => {
    const next = { ...getCommandOverrides() };
    delete next[commandId];
    await persistCommandOverrides(next);
    setCommands(allCommands());
    setError(null);
  };

  const resetAll = async () => {
    await persistCommandOverrides({});
    setCommands(allCommands());
    setError(null);
  };

  const anyRebound = commands.some((command) => command.rebound);

  return (
    <section className="flex flex-col gap-s3" data-shortcuts-section="">
      <div className="flex items-center justify-between gap-s3">
        <h1 className="text-lg font-semibold">Shortcuts</h1>
        {anyRebound && (
          <Button type="button" variant="secondary" size="sm" onClick={() => void resetAll()}>
            Reset all
          </Button>
        )}
      </div>

      {CONTEXT_ORDER.map((context) => (
        <div key={context} className="flex flex-col gap-1" data-shortcuts-group={context}>
          <h2 className="font-mono text-sm text-tertiary-foreground">
            {COMMAND_CONTEXT_TITLES[context]}
          </h2>
          {commands.filter((command) => command.context === context).map((command) => {
            const isRecording = recording === command.id;
            const rowError = error?.id === command.id ? error.message : null;
            return (
              <div
                key={command.id}
                data-shortcut-row={command.id}
                className="flex min-h-8 items-center gap-3 py-1"
              >
                <span className="min-w-0 flex-1 truncate text-base">
                  {command.name}
                  {command.rebound && (
                    <span className="ml-2 font-mono text-sm text-tertiary-foreground">
                      changed
                    </span>
                  )}
                </span>
                {rowError && (
                  <span className="shrink-0 text-sm text-destructive" data-shortcut-error="">
                    {rowError}
                  </span>
                )}
                {command.fixed ? (
                  <span
                    className="shrink-0 font-mono text-sm text-tertiary-foreground"
                    title={FIXED_REASONS[command.fixed]}
                    data-shortcut-fixed={command.fixed}
                  >
                    {command.combo}
                  </span>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant={isRecording ? "default" : "secondary"}
                      size="sm"
                      className="min-w-[8ch] shrink-0 font-mono"
                      aria-label={`Change shortcut for ${command.name}`}
                      onClick={() => {
                        setError(null);
                        setRecording(isRecording ? null : command.id);
                      }}
                    >
                      {isRecording ? "Press keys…" : command.combo}
                    </Button>
                    {command.rebound && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Reset shortcut for ${command.name}`}
                        onClick={() => void reset(command.id)}
                      >
                        Reset
                      </Button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      ))}

      <p className="text-sm text-muted-foreground">
        Escape cancels recording. Structural keys — arrows, Enter, Escape, Tab —
        are how the interface is driven and stay as they are.
        {" "}
        {bindingLabel({ key: "/", meta: true })} opens this list from anywhere.
      </p>
    </section>
  );
}
