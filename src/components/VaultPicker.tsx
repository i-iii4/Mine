import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { selectVault } from "@/lib/commands";
import { Button } from "@/components/ui/button";
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
    <div className="flex h-screen w-screen items-center justify-center bg-background">
      <div className="flex max-w-sm flex-col items-center gap-6 text-center">
        <h1 className="text-lg font-semibold text-foreground">
          Local Arena
        </h1>
        <p className="text-base text-muted-foreground">
          Choose a folder for your vault. All blocks will be stored as files in
          this directory.
        </p>

        {result ? (
          <div className="rounded-1 bg-muted px-6 py-4">
            <p className="text-base text-muted-foreground">
              Indexed{" "}
              <span className="font-semibold text-foreground">
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
          <Button onClick={handleSelect} disabled={loading} size="lg">
            {loading ? "Scanning..." : "Select Vault"}
          </Button>
        )}

        {error && (
          <p className="text-base text-destructive">{error}</p>
        )}
      </div>
    </div>
  );
}
