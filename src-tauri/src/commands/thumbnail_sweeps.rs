use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::domain::vault::VaultLayout;

#[derive(Default)]
struct ThumbnailSweepState {
    running_vault: Option<PathBuf>,
    pending_vault: Option<VaultLayout>,
}

#[derive(Default)]
pub struct ThumbnailSweepCoordinator {
    state: Arc<Mutex<ThumbnailSweepState>>,
}

pub struct SweepGuard {
    state: Arc<Mutex<ThumbnailSweepState>>,
    vault_root: PathBuf,
}

impl Drop for SweepGuard {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.running_vault.as_deref() == Some(self.vault_root.as_path()) {
            state.running_vault = None;
        }
    }
}

impl ThumbnailSweepCoordinator {
    /// Claim one sweep. Same-vault requests coalesce and the latest different
    /// vault is retained as a single pending pass.
    pub fn try_start(&self, vault: &VaultLayout) -> Option<SweepGuard> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(running) = state.running_vault.as_deref() {
            if running != vault.root() {
                state.pending_vault = Some(vault.clone());
            }
            return None;
        }
        state.pending_vault = None;
        state.running_vault = Some(vault.root().to_path_buf());
        Some(SweepGuard {
            state: Arc::clone(&self.state),
            vault_root: vault.root().to_path_buf(),
        })
    }

    pub fn take_pending(&self) -> Option<VaultLayout> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.running_vault.is_some() {
            return None;
        }
        state.pending_vault.take()
    }
}

#[cfg(test)]
mod tests {
    use super::ThumbnailSweepCoordinator;
    use crate::domain::vault::VaultLayout;

    #[test]
    fn coalesces_same_vault_and_queues_latest_switch() {
        let coordinator = ThumbnailSweepCoordinator::default();
        let first_source = tempfile::tempdir().unwrap();
        let second_source = tempfile::tempdir().unwrap();
        let first = VaultLayout::with_derived_root(
            first_source.path().to_path_buf(),
            first_source.path().join("derived"),
        );
        let second = VaultLayout::with_derived_root(
            second_source.path().to_path_buf(),
            second_source.path().join("derived"),
        );

        let first_guard = coordinator.try_start(&first).unwrap();
        assert!(coordinator.try_start(&first).is_none());
        assert!(coordinator.take_pending().is_none());
        assert!(coordinator.try_start(&second).is_none());
        drop(first_guard);

        let pending = coordinator.take_pending().unwrap();
        assert_eq!(pending.root(), second.root());
        assert!(coordinator.try_start(&second).is_some());
    }
}
