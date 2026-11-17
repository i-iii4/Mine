//! One line in `Mine.log` for every read of the feed a page makes
//! (`AUDIT_PERFORMANCE.md`, раздел 7; SPEC_INTEGRATION.md, «Замер чтений
//! ленты»). A measurement only: which command read, why the page asked, how
//! many rows and bytes went back and how long the backend took. Numbers and
//! names, never a path, a title or a text.

use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::state::CommandError;

/// Why a page reads its feed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum FeedReadReason {
    /// The place, the order or the space was opened or changed.
    #[default]
    Route,
    /// The next page of the feed on screen.
    Page,
    /// A command of this page changed the space.
    OwnCommand,
    /// News of the space: another tab's command, the watcher, a sync pass.
    News,
    /// A card's preview became ready.
    Preview,
    /// The menu of a card the feed held in place closed.
    CardMenu,
    /// A failed read asked again.
    Retry,
    /// The search overlay's recent cards, shown before a query is typed.
    Search,
}

impl FeedReadReason {
    fn name(self) -> &'static str {
        match self {
            Self::Route => "route",
            Self::Page => "page",
            Self::OwnCommand => "own_command",
            Self::News => "news",
            Self::Preview => "preview",
            Self::CardMenu => "card_menu",
            Self::Retry => "retry",
            Self::Search => "search",
        }
    }
}

/// The line of one read.
pub(crate) fn line(
    command: &str,
    reason: FeedReadReason,
    rows: usize,
    bytes: usize,
    backend_ms: u128,
) -> String {
    format!(
        "feed read: command={command} reason={} rows={rows} bytes={bytes} backend_ms={backend_ms}",
        reason.name()
    )
}

/// Answer a feed read with `value` and write its line. The answer is
/// serialized here, once, so its size is known without a second pass over
/// megabytes of rows: the page gets the same JSON a typed answer would give.
pub(crate) fn answer<T: Serialize>(
    command: &str,
    reason: FeedReadReason,
    rows: usize,
    started: Instant,
    value: &T,
) -> Result<tauri::ipc::Response, CommandError> {
    let body = serde_json::to_string(value)
        .map_err(|error| CommandError::Internal(format!("{command} answer: {error}")))?;
    log::info!(
        "{}",
        line(command, reason, rows, body.len(), started.elapsed().as_millis())
    );
    Ok(tauri::ipc::Response::new(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The line holds numbers and names only: the command, the reason, counts.
    #[test]
    fn the_line_holds_numbers_and_names_only() {
        assert_eq!(
            line("read_feed_changes", FeedReadReason::OwnCommand, 3, 4096, 2),
            "feed read: command=read_feed_changes reason=own_command rows=3 bytes=4096 backend_ms=2"
        );
        assert_eq!(
            line("list_grid_blocks", FeedReadReason::default(), 200, 262_144, 14),
            "feed read: command=list_grid_blocks reason=route rows=200 bytes=262144 backend_ms=14"
        );
    }

    /// The reason a page sends is the name the line shows.
    #[test]
    fn a_reason_is_sent_and_shown_by_one_name() {
        for reason in [
            FeedReadReason::Route,
            FeedReadReason::Page,
            FeedReadReason::OwnCommand,
            FeedReadReason::News,
            FeedReadReason::Preview,
            FeedReadReason::CardMenu,
            FeedReadReason::Retry,
            FeedReadReason::Search,
        ] {
            assert_eq!(
                serde_json::to_string(&reason).unwrap(),
                format!("\"{}\"", reason.name())
            );
        }
    }
}
