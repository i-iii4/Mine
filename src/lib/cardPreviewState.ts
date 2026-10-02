import { createContext } from "react";
import type { LightBlock } from "@/types";

/// Why a card's media slot has no picture to paint. Only consulted when the
/// card has no preview it can show: no derived preview in the row, or one
/// whose file did not load.
///
/// - `pending`: the preview is on the way. The slot is a quiet fill with no
///   words, so the card reads as loading rather than broken.
/// - `missing`: no preview, and none is on the way. The image card names
///   itself and the file to look for on disk (SPEC_VAULT_LIFECYCLE.md, П23).
/// - `unreadable`: the preview file is on disk but gives up no pixels
///   (SPEC_CARD_MEDIA_GEOMETRY.md).
///
/// Contract: SPEC_CARD_MEDIA_GEOMETRY.md, «Карточка без превью».
export type CardPreviewState = "pending" | "missing" | "unreadable";

/// Whether the background pass that builds previews for the open space is
/// still running. The app shell provides it.
///
/// The row itself cannot tell a preview that is not built yet from a source
/// that is gone: both arrive with no manifest and no flag, because the index
/// collapses `preview_error_kind` to `content_in_cloud` and
/// `preview_unreadable` only, and `missing_source` never reaches the card.
/// While the pass runs, a card without a preview is therefore taken as
/// waiting for it. The default `false` means no pass is known to be running:
/// a card without a preview then keeps naming its file, so a file that is
/// really gone is never disguised as loading.
export const PreviewsPendingContext = createContext(false);

/// The state of a card that has no preview to paint.
///
/// A broken preview file is a fact recorded by the index and wins. Content
/// held by iCloud is a file that exists and is waiting, so it is pending
/// whatever the pass is doing (SPEC_CLOUD_STORAGE.md, Х6). Everything else
/// is pending exactly while the preview pass runs.
export function cardPreviewState(
  block: Pick<LightBlock, "content_in_cloud" | "preview_unreadable">,
  previewsPending: boolean,
): CardPreviewState {
  if (block.preview_unreadable) return "unreadable";
  if (block.content_in_cloud || previewsPending) return "pending";
  return "missing";
}
