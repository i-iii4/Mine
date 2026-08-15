// How the interface talks about content that lives in iCloud.
//
// The rule is that Mine never waits on a file. A card draws from its preview,
// which is local and permanent; only the original may be absent, and only until
// the system fetches it back. None of this is an error, so none of it uses
// error wording or error surfaces. See SPEC_CLOUD_STORAGE.md.

/// How long a card may sit without content before it says why.
///
/// Below this, the badge would flash on and off during ordinary loading and
/// read as noise rather than explanation. Above it, silence starts to look
/// like something is broken.
export const CLOUD_BADGE_DELAY_MS = 1500;

/// The user-facing name for content that is not on this Mac.
export const CLOUD_STATE_LABEL = "In iCloud";

/// Shown while the system fetches an original the user asked for.
export const CLOUD_DOWNLOADING_LABEL = "Downloading from iCloud";

/// Shown when the original cannot be fetched at all.
export const CLOUD_OFFLINE_LABEL = "Original is in iCloud, not available offline";

/// Whether the badge should be visible yet for a card that has been waiting.
export function shouldShowCloudBadge(
  contentInCloud: boolean,
  waitingMs: number,
): boolean {
  return contentInCloud && waitingMs >= CLOUD_BADGE_DELAY_MS;
}
