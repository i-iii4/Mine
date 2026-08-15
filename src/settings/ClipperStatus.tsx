// What the clipper connection actually is right now.
//
// Split out from the settings section so the same block can be drawn in the
// design-system showcase in every variant — "installed but a version behind"
// is a state nobody can produce on demand, and it is exactly the state that
// used to break saving silently. See SPEC_ONBOARDING.md О7.

import { Check, CircleAlert } from "lucide-react";
import type { ClipperSetupStatus } from "@/types";

export function ClipperStatus({ status }: { status: ClipperSetupStatus }) {
  const connected = status.browsers.filter((browser) => browser.connected);
  const available = status.browsers.filter((browser) => browser.detected);

  return (
    <div className="grid gap-1 rounded-1 bg-accent p-3" data-clipper-status="">
      <p className="text-base text-foreground">
        {status.host_installed ? (
          status.host_current ? (
            <span className="flex items-center gap-1.5">
              <Check className="size-4" aria-hidden="true" />
              Connected — version {status.app_version}
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <CircleAlert className="size-4" aria-hidden="true" />
              Connected, but an older version — reconnect to update
            </span>
          )
        ) : (
          "Not connected yet"
        )}
      </p>
      <p className="text-sm text-muted-foreground">
        {connected.length > 0
          ? `Registered in ${connected.map((browser) => browser.label).join(", ")}.`
          : "No browser is registered yet."}
        {available.length > 0 &&
          ` Found on this Mac: ${available.map((browser) => browser.label).join(", ")}.`}
      </p>
    </div>
  );
}
