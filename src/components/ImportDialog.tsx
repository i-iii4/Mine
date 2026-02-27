import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        if (step !== "importing") onClose();
      } else if (e.key === "Enter" && step === "username") {
        handleFetchChannels();
      }
    },
    [step, onClose, handleFetchChannels],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onKeyDown={handleKeyDown}
    >
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl dark:bg-neutral-900">
        {/* Header */}
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            Import from Are.na
          </h2>
          {step !== "importing" && (
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            >
              <CloseIcon />
            </button>
          )}
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Step: Enter username */}
        {step === "username" && (
          <UsernameStep
            username={username}
            onUsernameChange={setUsername}
            onSubmit={handleFetchChannels}
            loading={loading}
          />
        )}

        {/* Step: Select channels */}
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

        {/* Step: Importing */}
        {step === "importing" && (
          <ImportingStep progress={progress} />
        )}

        {/* Step: Done */}
        {step === "done" && (
          <DoneStep results={results} onClose={onClose} />
        )}
      </div>
    </div>
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
      <p className="mb-3 text-sm text-neutral-500 dark:text-neutral-400">
        Enter your Are.na username to see your public channels.
      </p>
      <div className="flex gap-3">
        <input
          autoFocus
          type="text"
          value={username}
          onChange={(e) => onUsernameChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSubmit()}
          placeholder="username"
          className="flex-1 rounded-lg border border-neutral-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-800 dark:focus:border-neutral-500"
        />
        <button
          onClick={onSubmit}
          disabled={loading || !username.trim()}
          className="rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {loading ? "Loading..." : "Fetch"}
        </button>
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
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {channels.length} channels found
        </p>
        <button
          onClick={onSelectAll}
          className="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
        >
          {selected.size === channels.length ? "Deselect all" : "Select all"}
        </button>
      </div>

      <div className="mb-4 max-h-72 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-700">
        {channels.map((ch) => (
          <label
            key={ch.slug}
            className="flex cursor-pointer items-center gap-3 border-b border-neutral-100 px-4 py-3 last:border-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/50"
          >
            <input
              type="checkbox"
              checked={selected.has(ch.slug)}
              onChange={() => onToggle(ch.slug)}
              className="h-4 w-4 rounded border-neutral-300 accent-neutral-900 dark:accent-neutral-100"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                {ch.title}
              </p>
              <p className="text-xs text-neutral-400">
                {ch.length} blocks
              </p>
            </div>
          </label>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="text-sm text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
        >
          Back
        </button>
        <div className="flex items-center gap-3">
          <span className="text-xs text-neutral-400">
            {selected.size} channels, ~{totalBlocks} blocks
          </span>
          <button
            onClick={onImport}
            disabled={selected.size === 0}
            className="rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
          >
            Import
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportingStep({ progress }: { progress: ImportProgress | null }) {
  if (!progress) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-neutral-500">Connecting to Are.na...</p>
      </div>
    );
  }

  const pct = Math.round((progress.current / progress.total) * 100);

  return (
    <div className="py-4">
      <div className="mb-3">
        <div className="mb-1.5 flex justify-between text-xs text-neutral-500">
          <span>{progress.channel_slug}</span>
          <span>
            {progress.current} / {progress.total}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
          <div
            className="h-full rounded-full bg-neutral-900 transition-all duration-300 dark:bg-neutral-100"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      {progress.block_title && (
        <p className="truncate text-xs text-neutral-400">
          {progress.block_title}
        </p>
      )}
      <p className="mt-3 text-xs text-neutral-400">
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

      <div className="mb-4 max-h-48 overflow-y-auto">
        {results.map((r) => (
          <div
            key={r.channel_slug}
            className="flex items-center justify-between border-b border-neutral-100 py-2 last:border-0 dark:border-neutral-800"
          >
            <span className="text-sm text-neutral-700 dark:text-neutral-300">
              {r.channel_title}
            </span>
            <span className="text-xs text-neutral-400">
              {r.imported} imported
              {r.skipped > 0 && `, ${r.skipped} errors`}
            </span>
          </div>
        ))}
      </div>

      <div className="flex justify-end">
        <button
          onClick={onClose}
          className="rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
