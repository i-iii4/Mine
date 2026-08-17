//! The per-space record of waiting on iCloud for file contents.
//!
//! People who hit slow cards go to a forum and find the same advice every
//! time: mark the folder Keep Downloaded. The app brings that advice itself —
//! but only to people who actually live with the problem, which takes memory:
//! opening an old archive once is normal, waiting session after session is
//! the pattern worth interrupting. This module owns that memory.
//! See SPEC_CLOUD_STORAGE.md Х16–Х17, Х21.
//!
//! A JSON sidecar in the derived store, not a database table: the count is
//! advice-grade data that must survive an index rebuild (the sidecar lives
//! outside `index.db`), must disappear with the space when it is forgotten
//! (the whole derived store does), and does not warrant a schema version bump
//! that would strand an older native host.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::storage::files;

/// Sessions kept for the decision; older history says nothing about "now".
const KEPT_SESSIONS: usize = 6;
/// Slugs remembered for the current session's dedup; beyond this the count is
/// saturated anyway.
const KEPT_SLUGS: usize = 500;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CloudWaitSession {
    pub started_at: String,
    pub waits: u32,
    /// Blocks already counted this session — one block is one wait, however
    /// many times its preview is reconciled.
    #[serde(default)]
    pub slugs: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CloudWaitLog {
    /// Newest session last.
    #[serde(default)]
    pub sessions: Vec<CloudWaitSession>,
    /// The person closed the recommendation in this space (Х19: without the
    /// checkbox, dismissal binds to the space).
    #[serde(default)]
    pub dismissed: bool,
}

fn log_path(derived_root: &Path) -> PathBuf {
    derived_root.join("cloud-waits.json")
}

pub fn load(derived_root: &Path) -> CloudWaitLog {
    let Ok(raw) = std::fs::read_to_string(log_path(derived_root)) else {
        return CloudWaitLog::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn store(derived_root: &Path, log: &CloudWaitLog) -> Result<()> {
    std::fs::create_dir_all(derived_root)
        .with_context(|| format!("failed to create derived root {}", derived_root.display()))?;
    let raw = serde_json::to_vec_pretty(log).context("failed to serialize cloud wait log")?;
    files::write_atomically(&log_path(derived_root), &raw)
        .with_context(|| format!("failed to write {}", log_path(derived_root).display()))
}

/// Open a new session on space open. Sessions are the unit Х17 reasons in:
/// "repeats across sessions", not "repeats within one".
pub fn begin_session(derived_root: &Path, started_at: &str) -> Result<()> {
    let mut log = load(derived_root);
    // A session that saw no waits and was followed by another restart carries
    // its zero forward — that zero is the signal Х21 needs to let go.
    log.sessions.push(CloudWaitSession {
        started_at: started_at.to_string(),
        waits: 0,
        slugs: Vec::new(),
    });
    let excess = log.sessions.len().saturating_sub(KEPT_SESSIONS);
    if excess > 0 {
        log.sessions.drain(..excess);
    }
    store(derived_root, &log)
}

/// Count one block whose contents the interface waited on. Deduplicated per
/// session: a block reconciled ten times is still one wait.
pub fn record_wait(derived_root: &Path, slug: &str) -> Result<()> {
    let mut log = load(derived_root);
    let Some(current) = log.sessions.last_mut() else {
        // No session was opened (an old sidecar, or a write raced the open):
        // counting into nothing would misattribute the wait.
        return Ok(());
    };
    if current.slugs.iter().any(|s| s == slug) {
        return Ok(());
    }
    if current.slugs.len() < KEPT_SLUGS {
        current.slugs.push(slug.to_string());
    }
    current.waits = current.waits.saturating_add(1);
    store(derived_root, &log)
}

/// Х17 and Х21 in one rule: the current session waited, and at least one of
/// the two sessions before it waited too. Clean recent sessions make the
/// condition false again on their own — nothing to reset.
pub fn recommendation_due(log: &CloudWaitLog) -> bool {
    if log.dismissed {
        return false;
    }
    let mut recent = log.sessions.iter().rev();
    let Some(current) = recent.next() else {
        return false;
    };
    if current.waits == 0 {
        return false;
    }
    recent.take(2).any(|session| session.waits > 0)
}

/// The person closed the card in this space; it does not come back here.
pub fn dismiss(derived_root: &Path) -> Result<()> {
    let mut log = load(derived_root);
    log.dismissed = true;
    store(derived_root, &log)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn waits_count_once_per_block_per_session() {
        let dir = root();
        begin_session(dir.path(), "2026-08-16T10:00:00Z").unwrap();
        record_wait(dir.path(), "a").unwrap();
        record_wait(dir.path(), "a").unwrap();
        record_wait(dir.path(), "b").unwrap();

        let log = load(dir.path());
        assert_eq!(log.sessions.last().unwrap().waits, 2);
    }

    #[test]
    fn one_noisy_session_is_not_enough() {
        let dir = root();
        begin_session(dir.path(), "2026-08-16T10:00:00Z").unwrap();
        record_wait(dir.path(), "a").unwrap();
        // Opening an old archive once is normal (Х17).
        assert!(!recommendation_due(&load(dir.path())));
    }

    #[test]
    fn repetition_across_sessions_raises_the_recommendation() {
        let dir = root();
        begin_session(dir.path(), "s1").unwrap();
        record_wait(dir.path(), "a").unwrap();
        begin_session(dir.path(), "s2").unwrap();
        record_wait(dir.path(), "b").unwrap();
        assert!(recommendation_due(&load(dir.path())));
    }

    #[test]
    fn clean_sessions_let_the_recommendation_go() {
        let dir = root();
        begin_session(dir.path(), "s1").unwrap();
        record_wait(dir.path(), "a").unwrap();
        begin_session(dir.path(), "s2").unwrap();
        record_wait(dir.path(), "b").unwrap();
        // Two quiet restarts: the person fixed it or stopped hitting it (Х21).
        begin_session(dir.path(), "s3").unwrap();
        begin_session(dir.path(), "s4").unwrap();
        assert!(!recommendation_due(&load(dir.path())));
    }

    #[test]
    fn dismissal_binds_to_the_space(){
        let dir = root();
        begin_session(dir.path(), "s1").unwrap();
        record_wait(dir.path(), "a").unwrap();
        begin_session(dir.path(), "s2").unwrap();
        record_wait(dir.path(), "b").unwrap();
        assert!(recommendation_due(&load(dir.path())));

        dismiss(dir.path()).unwrap();
        assert!(!recommendation_due(&load(dir.path())));
    }

    #[test]
    fn history_is_bounded() {
        let dir = root();
        for i in 0..20 {
            begin_session(dir.path(), &format!("s{i}")).unwrap();
        }
        assert_eq!(load(dir.path()).sessions.len(), KEPT_SESSIONS);
    }

    #[test]
    fn waits_without_a_session_do_not_count_into_nothing() {
        let dir = root();
        record_wait(dir.path(), "a").unwrap();
        assert!(load(dir.path()).sessions.is_empty());
    }
}
