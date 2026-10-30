// The first screen: choosing where a space lives.
//
// One line and one button (SPEC_ONBOARDING.md, О9 to О12, as revised
// 01.10.2026). The folder chosen in the system dialog is the decision: it opens
// at once, and what it holds shows as the first index counts out loud in the
// notification corner (О13). The screen has the layout of every screen that
// stands in for the window (ScreenState): the line is its text, with no title,
// since it says one thing.

import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { selectVault } from "@/lib/commands";
import { Button } from "@/components/ui/button";
import { ScreenState } from "@/components/ScreenState";
import { errorMessage } from "@/lib/errorMessage";

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
    const selected = await open({ directory: true, multiple: false, canCreateDirectories: true });
    if (!selected || typeof selected !== "string") return;

    setLoading(true);
    try {
      await selectVault(selected);
      onVaultSelected(selected);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid h-screen w-screen place-items-center bg-background px-[var(--edge-rhythm,32px)]" data-vault-picker="">
      <ScreenState
        description="Mine keeps your elements as files in a folder."
        actions={
          <>
            <Button onClick={() => void choose()} disabled={loading}>
              {loading ? "Opening…" : "Choose folder"}
            </Button>
            {onBack && (
              <Button variant="secondary" onClick={onBack} disabled={loading}>
                Back
              </Button>
            )}
          </>
        }
      >
        {error && <p className="text-sm text-destructive">{error}</p>}
      </ScreenState>
    </div>
  );
}
