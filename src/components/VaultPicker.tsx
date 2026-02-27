import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { selectVault } from "@/lib/commands";
import type { ScanResult } from "@/types";

interface VaultPickerProps {
  onVaultSelected: (path: string) => void;
}

export function VaultPicker({ onVaultSelected }: VaultPickerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);

  const handleSelect = async () => {
    setError(null);
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;

    setLoading(true);
    try {
      const scanResult = await selectVault(selected);
      setResult(scanResult);
      // Brief delay to show scan results before transitioning
      setTimeout(() => onVaultSelected(selected), 600);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-neutral-50 dark:bg-neutral-950">
      <div className="flex max-w-sm flex-col items-center gap-6 text-center">
        <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
          Local Arena
        </h1>
        <p className="text-sm text-neutral-500">
          Choose a folder for your vault. All blocks will be stored as files in
          this directory.
        </p>

        {result ? (
          <div className="rounded-lg bg-neutral-100 px-6 py-4 dark:bg-neutral-900">
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Indexed{" "}
              <span className="font-semibold text-neutral-900 dark:text-neutral-100">
                {result.indexed}
              </span>{" "}
              blocks
              {result.errors > 0 && (
                <span className="text-amber-600">
                  {" "}
                  ({result.errors} errors)
                </span>
              )}
            </p>
          </div>
        ) : (
          <button
            onClick={handleSelect}
            disabled={loading}
            className="rounded-lg bg-neutral-900 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            {loading ? "Scanning..." : "Select Vault"}
          </button>
        )}

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </div>
    </div>
  );
}
