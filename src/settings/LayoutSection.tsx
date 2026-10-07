// Where new files go inside a space open in a tab, chosen in the section
// itself (SPEC_TABS.md, В71).
//
// Reading a vault is always recursive and independent of this: a card's
// identity is its path, wherever it sits. These three settings govern writes
// only — the folders new cards, media and collection documents are created in.
// Pointing all three at the root keeps a vault flat, which is exactly how every
// vault behaved before this contract. See SPEC_VAULT_LIFECYCLE.md П1–П4.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import {
  getVaultWriteLayout,
  setVaultWriteLayout,
} from "@/lib/commands";
import { OpenSpaceSelect } from "./OpenSpaceSelect";
import { SettingRow } from "./SettingRow";
import { useOpenSpaces } from "./useOpenSpaces";
import type { VaultWriteLayoutDto } from "@/types";

const ROOT_LABEL = "Space root";

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
  const { spaces, current, choose, error } = useOpenSpaces();

  if (spaces === null || current === null) {
    return (
      <section className="grid gap-s3" data-settings-section="layout">
        {spaces !== null && (
          <p className="text-base text-muted-foreground">
            {error ?? "Open a space to configure its folders."}
          </p>
        )}
      </section>
    );
  }

  // Keyed by the space: a draft typed for one space never shows for another.
  return (
    <SpaceLayout
      key={current.vaultId}
      vaultId={current.vaultId}
      selector={<OpenSpaceSelect spaces={spaces} current={current} onChoose={choose} />}
    />
  );
}

function SpaceLayout({ vaultId, selector }: { vaultId: string; selector: ReactNode }) {
  const [layout, setLayout] = useState<VaultWriteLayoutDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reloads the saved layout without touching `error`: after a rejected save
  // the field must snap back to what is stored *and* keep telling the user why.
  const refresh = useCallback(async () => {
    try {
      setLayout(await getVaultWriteLayout(vaultId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [vaultId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const commit = useCallback(
    async (next: VaultWriteLayoutDto) => {
      setBusy(true);
      try {
        setLayout(await setVaultWriteLayout(next, vaultId));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        void refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh, vaultId],
  );

  return (
    <section className="grid gap-s3" data-settings-section="layout">
      <h1 className="text-base font-semibold">Where to save new files</h1>

      {selector}

      {layout && (
        <>
          <FolderField
            label="Cards"
            caption={`New card documents, currently ${displayValue(layout.cards)}`}
            value={layout.cards}
            disabled={busy}
            onCommit={(cards) => void commit({ ...layout, cards })}
          />
          <FolderField
            label="Media"
            caption={`New images and video, currently ${displayValue(layout.media)}`}
            value={layout.media}
            disabled={busy}
            onCommit={(media) => void commit({ ...layout, media })}
          />
          <FolderField
            label="Collections"
            caption={`New collection documents, currently ${displayValue(layout.collections)}`}
            value={layout.collections}
            disabled={busy}
            onCommit={(collections) => void commit({ ...layout, collections })}
          />
        </>
      )}

      {error && <p className="text-base text-destructive">{error}</p>}
    </section>
  );
}
