// Where new files go inside the current space.
//
// Reading a vault is always recursive and independent of this: a card's
// identity is its path, wherever it sits. These three settings govern writes
// only — the folders new cards, media and collection documents are created in.
// Pointing all three at the root keeps a vault flat, which is exactly how every
// vault behaved before this contract. See SPEC_VAULT_LIFECYCLE.md П1–П4.

import { useCallback, useEffect, useState } from "react";
import { FolderTree } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getVaultWriteLayout,
  organizeVaultLayout,
  setVaultWriteLayout,
} from "@/lib/commands";
import { SettingRow } from "./SettingRow";
import type { VaultWriteLayoutDto } from "@/types";

const ROOT_LABEL = "Vault root";

function displayValue(folder: string): string {
  return folder.length > 0 ? folder : ROOT_LABEL;
}

interface FolderFieldProps {
  label: string;
  caption: string;
  value: string;
  disabled: boolean;
  onCommit: (next: string) => void;
}

function FolderField({ label, caption, value, disabled, onCommit }: FolderFieldProps) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <SettingRow label={label} caption={caption}>
      <Input
        value={draft}
        disabled={disabled}
        placeholder={ROOT_LABEL}
        className="w-56"
        aria-label={label}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
      />
    </SettingRow>
  );
}

export function LayoutSection() {
  const [layout, setLayout] = useState<VaultWriteLayoutDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reloads the saved layout without touching `error`: after a rejected save
  // the field must snap back to what is stored *and* keep telling the user why.
  const refresh = useCallback(async () => {
    try {
      setLayout(await getVaultWriteLayout());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const commit = useCallback(
    async (next: VaultWriteLayoutDto) => {
      setBusy(true);
      try {
        setLayout(await setVaultWriteLayout(next));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        void refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const organize = useCallback(async () => {
    setBusy(true);
    try {
      setLayout(await organizeVaultLayout());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  if (!layout) {
    return (
      <section className="grid gap-s3" data-settings-section="layout">
        <p className="text-sm text-muted-foreground">
          {error ?? "Open a space to configure its folders."}
        </p>
      </section>
    );
  }

  const isFlat =
    layout.cards.length === 0 &&
    layout.media.length === 0 &&
    layout.collections.length === 0;

  return (
    <section className="grid gap-s3" data-settings-section="layout">
      <p className="text-sm text-muted-foreground">
        New files are written into these folders. Existing files stay where they
        are, and Mine keeps reading the whole space regardless of how it is
        arranged. Leave a field empty to write into the space root.
      </p>

      <FolderField
        label="Cards"
        caption={`Markdown files — currently ${displayValue(layout.cards)}`}
        value={layout.cards}
        disabled={busy}
        onCommit={(cards) => void commit({ ...layout, cards })}
      />
      <FolderField
        label="Media"
        caption={`Images and video — currently ${displayValue(layout.media)}`}
        value={layout.media}
        disabled={busy}
        onCommit={(media) => void commit({ ...layout, media })}
      />
      <FolderField
        label="Collections"
        caption={`Collection documents — currently ${displayValue(layout.collections)}`}
        value={layout.collections}
        disabled={busy}
        onCommit={(collections) => void commit({ ...layout, collections })}
      />

      {isFlat && (
        <SettingRow
          label="Organize into folders"
          caption="Create Cards, Media and Collections and write into them from now on"
        >
          <Button disabled={busy} onClick={() => void organize()}>
            <FolderTree className="size-4" />
            Organize
          </Button>
        </SettingRow>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
