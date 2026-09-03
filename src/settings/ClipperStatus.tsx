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
  const lastCheck = status.last_connection_check;
  const checkedAt = lastCheck ? new Date(lastCheck.confirmed_at) : null;

  return (
    <div className="grid gap-1 rounded-1 bg-accent p-3" data-clipper-status="">
      <p className="text-base text-foreground">
        {status.extension_installed ? (
          status.extension_current ? (
            <span className="flex items-center gap-1.5">
              <Check className="size-4" aria-hidden="true" />
              Extension folder installed — matches this Mine build
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <CircleAlert className="size-4" aria-hidden="true" />
              Extension folder differs from this Mine build — repair registration
            </span>
          )
        ) : (
          "Extension folder is not installed yet"
        )}
      </p>
      <p className="text-base text-foreground">
        {status.host_installed ? (
          status.host_current ? (
            <span className="flex items-center gap-1.5">
              <Check className="size-4" aria-hidden="true" />
              Helper installed — matches Mine {status.app_version}
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <CircleAlert className="size-4" aria-hidden="true" />
              Helper differs from this Mine build — repair registration
            </span>
          )
        ) : (
          "Helper not registered yet"
        )}
      </p>
      <p className="text-sm text-muted-foreground">Browser connection and protocol compatibility are checked in the extension when it opens; registration alone does not confirm a connection.</p>
      <p className="text-sm text-muted-foreground">
        {connected.length > 0
          ? `Registered in ${connected.map((browser) => browser.label).join(", ")}.`
          : "No browser is registered yet."}
        {available.length > 0 &&
          ` Found on this Mac: ${available.map((browser) => browser.label).join(", ")}.`}
      </p>
      {lastCheck && checkedAt ? (
        <p className="text-sm text-muted-foreground" data-last-connection-check="">
          Last confirmed connection: <time dateTime={lastCheck.confirmed_at}>
            {checkedAt.toLocaleDateString("ru-RU")}, {checkedAt.toLocaleTimeString("en-GB")}
          </time> (local time). Host {lastCheck.host_version}, protocol {lastCheck.host_api_version}.
          {" "}Historical result — not a live connection check.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {status.connection_check_error || "No confirmed connection check recorded. Open the extension to check."}
        </p>
      )}
    </div>
  );
}
