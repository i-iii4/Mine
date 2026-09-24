import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { setShortcutCaptureActive } from "@/lib/commands";
import { bindingId, bindingsEqual, type CommandBinding } from "@/lib/commandBinding";
import {
  COMMAND_CONTEXT_TITLES,
  DEFAULT_COMMANDS,
  allCommands,
  getCommandOverrides,
  subscribeToCommands,
  type CommandContext,
  type ResolvedCommand,
} from "@/lib/commandRegistry";
import { persistCommandOverrides } from "@/lib/shortcutOverrides";
import { rejectionMessage, validateShortcut } from "@/lib/shortcutValidation";

const CONTEXT_ORDER: readonly CommandContext[] = ["global", "feed", "element", "selection"];

function bindingFromEvent(event: KeyboardEvent): CommandBinding | null {
  if (["Meta", "Shift", "Alt", "Control"].includes(event.key)) return null;
  const key = /^Key[A-Z]$/.test(event.code)
    ? event.code.slice(3).toLowerCase()
    : /^Digit[0-9]$/.test(event.code)
      ? event.code.slice(5)
      : /^[a-zA-Z]$/.test(event.key)
        ? event.key.toLowerCase()
        : event.key;
  return {
    key,
    meta: event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
    ctrl: event.ctrlKey,
  };
}

function matchesSearch(command: ResolvedCommand, query: string): boolean {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return true;
  const id = command.binding ? bindingId(command.binding) : "";
  return [
    command.name,
    COMMAND_CONTEXT_TITLES[command.context],
    command.combo,
    id,
    id.replaceAll("meta", "cmd"),
    id.replaceAll("alt", "option"),
    id.replaceAll("ctrl", "control"),
  ].some((value) => value.toLocaleLowerCase().includes(term));
}

export function ShortcutsSection() {
  const [commands, setCommands] = useState(allCommands);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [arming, setArming] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const captureRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef(false);
  const nativeCaptureRef = useRef(false);
  const armGenerationRef = useRef(0);

  useEffect(() => subscribeToCommands(() => setCommands(allCommands())), []);
  useEffect(() => { if (editing) captureRef.current?.focus(); }, [editing]);

  const releaseNativeCapture = useCallback(() => {
    if (!nativeCaptureRef.current) return;
    nativeCaptureRef.current = false;
    void setShortcutCaptureActive(false);
  }, []);

  const cancel = useCallback(() => {
    armGenerationRef.current += 1;
    releaseNativeCapture();
    setEditing(null);
    setArming(null);
    setError(null);
  }, [releaseNativeCapture]);

  useEffect(() => {
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      armGenerationRef.current += 1;
      releaseNativeCapture();
    };
  }, [cancel, releaseNativeCapture]);

  const startEditing = async (commandId: string) => {
    setError(null);
    if (!isTauri() || nativeCaptureRef.current) {
      setEditing(commandId);
      return;
    }
    const generation = ++armGenerationRef.current;
    setArming(commandId);
    try {
      await setShortcutCaptureActive(true);
      if (generation !== armGenerationRef.current) {
        void setShortcutCaptureActive(false);
        return;
      }
      nativeCaptureRef.current = true;
      setEditing(commandId);
    } catch {
      if (generation === armGenerationRef.current) {
        setError({ id: commandId, message: "Could not start keyboard capture." });
      }
    } finally {
      if (generation === armGenerationRef.current) setArming(null);
    }
  };

  const save = async (commandId: string, binding: CommandBinding) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(commandId);
    try {
      const next = { ...getCommandOverrides() };
      const original = DEFAULT_COMMANDS.find((command) => command.id === commandId)?.binding;
      if (original && bindingsEqual(original, binding)) delete next[commandId];
      else next[commandId] = binding;
      await persistCommandOverrides(next);
      cancel();
    } catch {
      setError({ id: commandId, message: "Could not save. Try again." });
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  const reset = async (commandId: string) => {
    if (pendingRef.current) return;
    const next = { ...getCommandOverrides() };
    delete next[commandId];
    pendingRef.current = true;
    setPending(commandId);
    try {
      await persistCommandOverrides(next);
      setError(null);
    } catch {
      setError({ id: commandId, message: "Could not restore default. Try again." });
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  const resetAll = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending("all");
    try {
      await persistCommandOverrides({});
      cancel();
    } catch {
      setError({ id: "all", message: "Could not restore defaults. Try again." });
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  const anyRebound = commands.some((command) => command.rebound);
  const visibleCommands = commands.filter((command) => !command.fixed && matchesSearch(command, query));

  return (
    <section className="flex w-full max-w-[720px] flex-col gap-s3" data-shortcuts-section="">
      <div className="flex items-center justify-between gap-s3">
        <h1 className="text-lg font-semibold">Shortcuts</h1>
        {anyRebound && (
          <Button type="button" variant="ghost" size="sm" disabled={pending !== null} onClick={() => void resetAll()}>
            Reset all
          </Button>
        )}
      </div>
      {error?.id === "all" && <p className="text-sm text-destructive" role="alert">{error.message}</p>}

      <input
        type="search"
        aria-label="Search shortcuts"
        placeholder="Search commands or keys"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="h-9 w-full rounded-1 border border-border bg-background px-3 text-base text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />

      {CONTEXT_ORDER.map((context) => {
        const group = visibleCommands.filter((command) => command.context === context);
        if (group.length === 0) return null;
        return (
          <div key={context} className="flex flex-col" data-shortcuts-group={context}>
            <h2 className="border-b border-border pb-2 text-sm text-muted-foreground">
              {COMMAND_CONTEXT_TITLES[context]}
            </h2>
            {group.map((command) => {
              const isEditing = editing === command.id;
              const rowError = error?.id === command.id ? error.message : null;
              return (
                <div
                  key={command.id}
                  data-shortcut-row={command.id}
                  className="grid min-h-14 grid-cols-[minmax(0,1fr)_7rem_3.5rem] items-center gap-2 border-b border-border px-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-base text-foreground">{command.name}</div>
                    {rowError && (
                      <p id={`shortcut-error-${command.id}`} className="truncate text-xs text-destructive" role="alert" title={rowError} data-shortcut-error="">
                        {rowError}
                      </p>
                    )}
                  </div>
                  <button
                    data-shortcut-trigger=""
                    ref={isEditing ? captureRef : undefined}
                    type="button"
                    aria-label={`${isEditing ? "Press new shortcut for" : "Change shortcut for"} ${command.name}. Current: ${command.combo}`}
                    aria-pressed={isEditing}
                    aria-busy={pending === command.id || arming === command.id}
                    aria-describedby={rowError ? `shortcut-error-${command.id}` : undefined}
                    className={`flex h-8 w-28 items-center justify-center rounded-1 border px-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${isEditing ? "border-foreground bg-active text-foreground" : "border-border bg-accent text-foreground hover:bg-active"}`}
                    onClick={() => {
                      if (pendingRef.current || arming) return;
                      if (isEditing) cancel();
                      else if (editing) {
                        setEditing(command.id);
                        setError(null);
                      } else void startEditing(command.id);
                    }}
                    onBlur={(event) => {
                      const next = event.relatedTarget as HTMLElement | null;
                      if (next?.closest("[data-shortcut-trigger]")) return;
                      if (isEditing && !pendingRef.current) cancel();
                    }}
                    onKeyDownCapture={(event) => {
                      if (!isEditing) return;
                      if (event.key === "Tab") return;
                      event.preventDefault();
                      event.stopPropagation();
                      if (event.key === "Escape") {
                        cancel();
                        return;
                      }
                      if (pendingRef.current) return;
                      const binding = bindingFromEvent(event.nativeEvent);
                      if (!binding) return;
                      if (command.binding && bindingsEqual(command.binding, binding)) {
                        cancel();
                        return;
                      }
                      const rejection = validateShortcut(command.id, binding, allCommands());
                      if (rejection) {
                        setError({ id: command.id, message: rejectionMessage(rejection) });
                        return;
                      }
                      setError(null);
                      void save(command.id, binding);
                    }}
                  >
                    {arming === command.id ? "Preparing…" : pending === command.id ? "Saving…" : isEditing ? "Press keys" : command.combo}
                  </button>
                  <div className="flex justify-end">
                    {command.rebound && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={pending !== null}
                        aria-label={`Reset shortcut for ${command.name}`}
                        onClick={() => void reset(command.id)}
                      >
                        Reset
                      </Button>
                    )}
                  </div>
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
