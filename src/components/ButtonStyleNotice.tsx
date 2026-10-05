// Dev button styles (src/lib/buttonStyle.ts): after a switch the tab the user
// is looking at says which button style is on, for a moment, in the app's
// notification card. Only the window that changed shows it: a step here
// (⌃⌥B) shows here, a menu switch reaches the visible tab of that window's
// bar only.

import { useEffect, useState } from "react";
import { NotificationAnchor, NotificationCard } from "@/components/NotificationCard";
import { BUTTON_STYLE_NOTICE_EVENT } from "@/lib/buttonStyle";

/** How long the notice stays. */
export const BUTTON_STYLE_NOTICE_MS = 1200;

export function ButtonStyleNotice() {
  const [notice, setNotice] = useState<{ title: string; id: number } | null>(null);

  useEffect(() => {
    let next = 0;
    const show = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
      next += 1;
      setNotice({ title: event.detail, id: next });
    };
    window.addEventListener(BUTTON_STYLE_NOTICE_EVENT, show);
    return () => window.removeEventListener(BUTTON_STYLE_NOTICE_EVENT, show);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), BUTTON_STYLE_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (!notice) return null;
  return (
    <NotificationAnchor>
      <NotificationCard title={notice.title} onClose={() => setNotice(null)} closeLabel="Hide">
        {null}
      </NotificationCard>
    </NotificationAnchor>
  );
}
