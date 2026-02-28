import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { listArenaChannels, importArenaChannels } from "@/lib/commands";
import type {
  ArenaChannelInfo,
  ImportChannelResult,
  ImportProgress,
} from "@/types";

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImportComplete: () => void;
}

type Step = "username" | "select" | "importing" | "done";

export function ImportDialog({
  open,
  onClose,
  onImportComplete,
}: ImportDialogProps) {
  const [step, setStep] = useState<Step>("username");
  const [username, setUsername] = useState("");
  const [channels, setChannels] = useState<ArenaChannelInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [results, setResults] = useState<ImportChannelResult[]>([]);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setStep("username");
      setUsername("");
      setChannels([]);
      setSelected(new Set());
      setError(null);
      setProgress(null);
      setResults([]);
    }
  }, [open]);

  // Listen for import progress events
  useEffect(() => {
    if (!open) return;

    let cleanup: (() => void) | undefined;
    listen<ImportProgress>("import-progress", (event) => {
      setProgress(event.payload);
    }).then((fn) => {
      cleanup = fn;
    });

    return () => cleanup?.();
  }, [open]);

  const handleFetchChannels = useCallback(async () => {
    if (!username.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const chs = await listArenaChannels(username.trim());
      setChannels(chs);
      setSelected(new Set(chs.map((c) => c.slug)));
      setStep("select");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to fetch channels",
      );
    } finally {
      setLoading(false);
    }
  }, [username]);

  const handleToggleChannel = useCallback((slug: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    if (selected.size === channels.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(channels.map((c) => c.slug)));
    }
  }, [channels, selected.size]);

  const handleImport = useCallback(async () => {
    const toImport = channels
      .filter((c) => selected.has(c.slug))
      .map((c) => ({
        slug: c.slug,
        tag: c.title.toLowerCase().replace(/[,\s]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""),
      }));

    if (toImport.length === 0) return;

    setStep("importing");
    setError(null);

    try {
      const res = await importArenaChannels(toImport);
      setResults(res);
      setStep("done");
      onImportComplete();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Import failed",
      );
      setStep("select");
    }
  }, [channels, selected, onImportComplete]);

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && step !== "importing") onClose();
      }}
    >
      <DialogContent
        className="max-w-lg gap-0"
        showCloseButton={step !== "importing"}
        onInteractOutside={(e) => {
          if (step === "importing") e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (step === "importing") e.preventDefault();
        }}
      >
        <DialogHeader className="mb-5">
          <DialogTitle>Import from Are.na</DialogTitle>
          <DialogDescription className="sr-only">
            Import channels from Are.na into your vault
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="mb-4 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {step === "username" && (
          <UsernameStep
            username={username}
            onUsernameChange={setUsername}
            onSubmit={handleFetchChannels}
            loading={loading}
          />
        )}

        {step === "select" && (
          <SelectStep
            channels={channels}
            selected={selected}
            onToggle={handleToggleChannel}
            onSelectAll={handleSelectAll}
            onBack={() => setStep("username")}
            onImport={handleImport}
          />
        )}

        {step === "importing" && (
          <ImportingStep progress={progress} />
        )}

        {step === "done" && (
          <DoneStep results={results} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function UsernameStep({
  username,
  onUsernameChange,
  onSubmit,
  loading,
}: {
  username: string;
  onUsernameChange: (v: string) => void;
  onSubmit: () => void;
  loading: boolean;
}) {
  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">
        Enter your Are.na username to see your public channels.
      </p>
      <div className="flex gap-3">
        <Input
          autoFocus
          type="text"
          value={username}
          onChange={(e) => onUsernameChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSubmit()}
          placeholder="username"
          className="flex-1"
        />
        <Button
          onClick={onSubmit}
          disabled={loading || !username.trim()}
        >
          {loading ? "Loading..." : "Fetch"}
        </Button>
      </div>
    </div>
  );
}

function SelectStep({
  channels,
  selected,
  onToggle,
  onSelectAll,
  onBack,
  onImport,
}: {
  channels: ArenaChannelInfo[];
  selected: Set<string>;
  onToggle: (slug: string) => void;
  onSelectAll: () => void;
  onBack: () => void;
  onImport: () => void;
}) {
  const totalBlocks = channels
    .filter((c) => selected.has(c.slug))
    .reduce((sum, c) => sum + c.length, 0);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {channels.length} channels found
        </p>
        <Button
          variant="ghost"
          size="xs"
          onClick={onSelectAll}
          className="text-muted-foreground"
        >
          {selected.size === channels.length ? "Deselect all" : "Select all"}
        </Button>
      </div>

      <ScrollArea className="mb-4 max-h-72 rounded-lg border border-border">
        {channels.map((ch) => (
          <label
            key={ch.slug}
            className="flex cursor-pointer items-center gap-3 border-b border-border px-4 py-3 last:border-0 hover:bg-accent"
          >
            <Checkbox
              checked={selected.has(ch.slug)}
              onCheckedChange={() => onToggle(ch.slug)}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {ch.title}
              </p>
              <p className="text-xs text-muted-foreground">
                {ch.length} blocks
              </p>
            </div>
          </label>
        ))}
      </ScrollArea>

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={onBack} className="text-muted-foreground">
          Back
        </Button>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {selected.size} channels, ~{totalBlocks} blocks
          </span>
          <Button onClick={onImport} disabled={selected.size === 0}>
            Import
          </Button>
        </div>
      </div>
    </div>
  );
}

function ImportingStep({ progress }: { progress: ImportProgress | null }) {
  if (!progress) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-muted-foreground">Connecting to Are.na...</p>
      </div>
    );
  }

  const pct = Math.round((progress.current / progress.total) * 100);

  return (
    <div className="py-4">
      <div className="mb-3">
        <div className="mb-1.5 flex justify-between text-xs text-muted-foreground">
          <span>{progress.channel_slug}</span>
          <span>
            {progress.current} / {progress.total}
          </span>
        </div>
        <Progress value={pct} />
      </div>
      {progress.block_title && (
        <p className="truncate text-xs text-muted-foreground">
          {progress.block_title}
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Do not close this window during import.
      </p>
    </div>
  );
}

function DoneStep({
  results,
  onClose,
}: {
  results: ImportChannelResult[];
  onClose: () => void;
}) {
  const totalImported = results.reduce((s, r) => s + r.imported, 0);
  const totalErrors = results.reduce((s, r) => s + r.skipped, 0);

  return (
    <div>
      <div className="mb-4 rounded-lg bg-green-50 px-4 py-3 dark:bg-green-900/30">
        <p className="text-sm font-medium text-green-800 dark:text-green-300">
          Imported {totalImported} blocks
          {totalErrors > 0 && `, ${totalErrors} skipped`}
        </p>
      </div>

      <ScrollArea className="mb-4 max-h-48">
        {results.map((r) => (
          <div
            key={r.channel_slug}
            className="flex items-center justify-between border-b border-border py-2 last:border-0"
          >
            <span className="text-sm text-foreground">
              {r.channel_title}
            </span>
            <span className="text-xs text-muted-foreground">
              {r.imported} imported
              {r.skipped > 0 && `, ${r.skipped} errors`}
            </span>
          </div>
        ))}
      </ScrollArea>

      <div className="flex justify-end">
        <Button onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

