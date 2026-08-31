// Setting up the browser clipper without a terminal.
//
// The bundled development ID is fixed. First launch registers the helper;
// this screen repairs registration without claiming a browser handshake.
// A production store identity has not been assigned. See SPEC_ONBOARDING О5–О7.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { getClipperSetupStatus, installClipperHost } from "@/lib/commands";
import { ClipperStatus } from "./ClipperStatus";
import { SettingRow } from "./SettingRow";
import type { ClipperSetupStatus } from "@/types";

export function ClipperSection() {
  const [status, setStatus] = useState<ClipperSetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setStatus(await getClipperSetupStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await installClipperHost(""));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <section className="grid gap-s3" data-settings-section="clipper">
      <p className="text-sm text-muted-foreground">
        The extension saves pages, images and videos from your browser straight
        into the current space — as files, the same as everything else.
      </p>

      <SettingRow
        label="Development extension"
        caption="Use the bundled extension folder with Load unpacked in Chrome, Dia, Arc, Edge or Brave. The store release is not published yet."
      >
        <span className="text-sm text-muted-foreground">Stable development ID</span>
      </SettingRow>

      <SettingRow
        label="Browser helper"
        caption="Registered automatically when Mine starts. Repair registration after installing a browser or updating Mine, then retry the connection in the extension."
      >
        <div className="flex items-center gap-2">
          <Button disabled={busy} onClick={() => void install()}>
            Repair registration
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void refresh()}>Check registration</Button>
        </div>
      </SettingRow>

      {status && <ClipperStatus status={status} />}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
