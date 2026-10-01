// The first screen: choosing where a space lives.
//
// One line and one button (SPEC_ONBOARDING.md, О9 to О12, as revised
// 01.10.2026). The folder chosen in the system dialog is the decision: it opens
// at once, and what it holds shows as the first index counts out loud, with a
// way to choose another folder right there (О13). The column has the width
// and place of that count, so the screen does not jump between the two.

import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { selectVault } from "@/lib/commands";
import { Button } from "@/components/ui/button";

interface VaultPickerProps {
  onVaultSelected: (path: string) => void;
  /** The way back when the picker was opened from another screen, such as
   *  "Create new space" on an unavailable space: cancelling the folder dialog
   *  must not leave the person here with no way out. */
  onBack?: () => void;
}

export function VaultPicker({ onVaultSelected, onBack }: VaultPickerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async () => {
    setError(null);
    const selected = await open({ directory: true, multiple: false });
    if (!selected || typeof selected !== "string") return;

    setLoading(true);
    try {
      await selectVault(selected);
      onVaultSelected(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid h-screen w-screen place-items-center bg-background" data-vault-picker="">
      <div className="grid w-80 gap-4">
        <p className="text-sm text-foreground">Mine keeps your cards as files in a folder.</p>
        <div className="flex items-center gap-2">
          <Button onClick={() => void choose()} disabled={loading}>
            {loading ? "Opening…" : "Choose folder"}
          </Button>
          {onBack && (
            <Button variant="secondary" onClick={onBack} disabled={loading}>
              Back
            </Button>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}
