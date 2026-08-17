// Setting up the browser clipper without a terminal.
//
// Two things have to happen: the extension goes in from the Chrome Web Store,
// and the app registers a small helper the browser is allowed to launch. The
// second used to be a bash script that compiled the helper with cargo and asked
// for an extension id by hand. Here it is a button, and the status below says
// plainly what is connected and what is not — "it silently does not work" was
// the worst part of the old flow. See SPEC_ONBOARDING.md О5–О7.

import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getClipperSetupStatus, installClipperHost } from "@/lib/commands";
import { ClipperStatus } from "./ClipperStatus";
import { SettingRow } from "./SettingRow";
import type { ClipperSetupStatus } from "@/types";

/// Where the extension lives once published.
const STORE_URL = "https://chrome.google.com/webstore/";

export function ClipperSection() {
  const [status, setStatus] = useState<ClipperSetupStatus | null>(null);
  const [extensionId, setExtensionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
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
      setStatus(await installClipperHost(extensionId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [extensionId]);

  return (
    <section className="grid gap-s3" data-settings-section="clipper">
      <p className="text-sm text-muted-foreground">
        The extension saves pages, images and videos from your browser straight
        into the current space — as files, the same as everything else.
      </p>

      <SettingRow
        label="1. Install the extension"
        caption="From the Chrome Web Store; works in Chrome, Dia, Arc, Edge and Brave"
      >
        <Button onClick={() => void openUrl(STORE_URL)}>
          <Download className="size-4" />
          Open store
        </Button>
      </SettingRow>

      <SettingRow
        label="2. Connect it to Mine"
        caption="Paste the extension id from its page in the browser, then connect"
      >
        <div className="flex items-center gap-2">
          <Input
            value={extensionId}
            placeholder="extension id"
            aria-label="Extension id"
            className="w-56 font-mono"
            disabled={busy}
            onChange={(event) => setExtensionId(event.target.value)}
          />
          <Button disabled={busy || extensionId.trim().length === 0} onClick={() => void install()}>
            Connect
          </Button>
        </div>
      </SettingRow>

      {status && <ClipperStatus status={status} />}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
