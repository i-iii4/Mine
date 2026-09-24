import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { bindingLabel, type CommandBinding } from "@/lib/commandBinding";
import {
  COMMAND_CONTEXT_TITLES,
  allCommands,
  getCommandOverrides,
  subscribeToCommands,
  type CommandContext,
} from "@/lib/commandRegistry";
import { persistCommandOverrides } from "@/lib/shortcutOverrides";
import { rejectionMessage, validateShortcut } from "@/lib/shortcutValidation";

const CONTEXT_ORDER: readonly CommandContext[] = ["global", "feed", "element", "selection"];

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
  const [commands, setCommands] = useState(allCommands);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<CommandBinding | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const captureRef = useRef<HTMLButtonElement>(null);

  useEffect(() => subscribeToCommands(() => setCommands(allCommands())), []);
  useEffect(() => { if (editing) captureRef.current?.focus(); }, [editing]);

  const save = async () => {
    if (!editing || !draft) return;
    const rejection = validateShortcut(editing, draft, allCommands());
    if (rejection) {
      setError({ id: editing, message: rejectionMessage(rejection) });
      return;
    }
    setError(null);
    try {
      await persistCommandOverrides({ ...getCommandOverrides(), [editing]: draft });
      setCommands(allCommands());
      setEditing(null);
      setDraft(null);
    } catch {
      setError({ id: editing, message: "Could not save this shortcut." });
    }
  };

  const startEditing = (commandId: string) => {
    setEditing(commandId);
    setDraft(null);
    setError(null);
  };

  const reset = async (commandId: string) => {
    const next = { ...getCommandOverrides() };
    delete next[commandId];
    try {
      await persistCommandOverrides(next);
      setCommands(allCommands());
      setError(null);
    } catch {
      setError({ id: commandId, message: "Could not reset this shortcut." });
    }
  };

  const resetAll = async () => {
    try {
      await persistCommandOverrides({});
      setCommands(allCommands());
      setError(null);
    } catch {
      setError({ id: "all", message: "Could not reset shortcuts." });
    }
  };

  const anyRebound = commands.some((command) => command.rebound);
  const visibleCommands = commands.filter((command) =>
    !command.fixed && command.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );

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
      {error?.id === "all" && <p className="text-sm text-destructive" role="alert">{error.message}</p>}

      <input
        type="search"
        aria-label="Search shortcuts"
        placeholder="Search shortcuts"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="h-9 w-full rounded-1 border border-border bg-background px-3 text-base text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />

      {CONTEXT_ORDER.map((context) => {
        const group = visibleCommands.filter((command) => command.context === context);
        if (group.length === 0) return null;
        return (
        <div key={context} className="flex flex-col" data-shortcuts-group={context}>
          <h2 className="border-b border-border py-2 text-sm text-muted-foreground">
            {COMMAND_CONTEXT_TITLES[context]}
          </h2>
          {group.map((command) => {
            const isEditing = editing === command.id;
            const rowError = error?.id === command.id ? error.message : null;
            return (
              <div
                key={command.id}
                data-shortcut-row={command.id}
                className="border-b border-border py-2"
              >
                <div className="flex min-h-8 items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-base">{command.name}</span>
                  <kbd className="shrink-0 rounded-1 border border-border bg-accent px-2 py-1 font-mono text-sm text-foreground">
                    {command.combo}
                  </kbd>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label={`Change shortcut for ${command.name}`}
                    aria-expanded={isEditing}
                    onClick={() => isEditing ? setEditing(null) : startEditing(command.id)}
                  >
                    Change
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
                </div>
                {isEditing && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-1 border border-border bg-accent p-3" data-shortcut-editor="">
                    <button
                      ref={captureRef}
                      type="button"
                      aria-label={`Enter new shortcut for ${command.name}`}
                      className="min-w-0 flex-1 rounded-1 border border-border bg-background px-3 py-2 text-left text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onKeyDownCapture={(event) => {
                        if (event.key === "Tab") return;
                        event.preventDefault();
                        event.stopPropagation();
                        if (event.key === "Escape") {
                          setEditing(null);
                          setDraft(null);
                          setError(null);
                          return;
                        }
                        const binding = bindingFromEvent(event.nativeEvent);
                        if (binding) {
                          setDraft(binding);
                          setError(null);
                        }
                      }}
                    >
                      {draft ? bindingLabel(draft) : "Press a new key combination"}
                    </button>
                    <Button type="button" size="sm" disabled={!draft} onClick={() => void save()}>
                      Save
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                    {rowError && <p className="w-full text-sm text-destructive" role="alert" data-shortcut-error="">{rowError}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        );
      })}
      {visibleCommands.length === 0 && <p className="text-sm text-muted-foreground">No shortcuts found.</p>}
    </section>
  );
}
