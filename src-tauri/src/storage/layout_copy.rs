//! This Mac's copy of the space's write layout (SPEC_CLOUD_STORAGE.md, Х12;
//! SPEC_VAULT_LIFECYCLE.md, П2).
//!
//! `.mine/layout.json` travels with the space, and iCloud takes its contents
//! off this Mac like any other file's. On 13.10.2026 macOS evicted it in the
//! space «Тест», and each action that read it waited about 9 s for the
//! download: `mine card delete`, the clipper's list of collections (Е4.17).
//! Every read of the file while its contents are here leaves its layout and
//! its stamp (size, modification time) in the derived store of this Mac
//! (`vaults/<vault-id>/space-layout.json`); while the contents are in iCloud,
//! the layout comes from that copy. Another stamp means another Mac changed
//! the file: the copy serves until the new contents arrive, and iCloud is
//! asked for them (`files::load_vault_write_layout`).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::domain::vault::{VaultLayout, VaultWriteLayout};

const COPY_NAME: &str = "space-layout.json";

/// What the file was when its layout was read: its size and modification
/// time, which iCloud keeps on this Mac with the contents gone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayoutStamp {
    pub size: u64,
    pub mtime_ns: u128,
}

impl LayoutStamp {
    #[must_use]
    pub fn of(metadata: &std::fs::Metadata) -> Self {
        let mtime_ns = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |elapsed| elapsed.as_nanos());
        Self {
            size: metadata.len(),
            mtime_ns,
        }
    }
}

/// The layout this Mac last read from the space, and the file it read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayoutCopy {
    pub stamp: LayoutStamp,
    pub layout: VaultWriteLayout,
}

/// Where this Mac keeps the copy. A derived store inside the space (`.mine`,
/// tests and tools) travels with it and keeps none.
fn copy_path(vault: &VaultLayout) -> Option<PathBuf> {
    let derived = vault.derived_root();
    (derived != vault.mine_dir()).then(|| derived.join(COPY_NAME))
}

/// This Mac's copy, if there is a valid one. One that cannot be read counts
/// as none and is logged.
#[must_use]
pub fn read(vault: &VaultLayout) -> Option<LayoutCopy> {
    let path = copy_path(vault)?;
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            log::warn!("this Mac's copy of the layout {} cannot be read: {error}", path.display());
            return None;
        }
    };
    match serde_json::from_slice::<LayoutCopy>(&bytes) {
        Ok(copy) if copy.layout.validate().is_ok() => Some(copy),
        Ok(_) => {
            log::warn!("this Mac's copy of the layout {} is not a valid layout", path.display());
            None
        }
        Err(error) => {
            log::warn!("this Mac's copy of the layout {} is damaged: {error}", path.display());
            None
        }
    }
}

/// Keep `layout`, read from the file `stamp` describes, as this Mac's copy.
/// Best effort: a copy not written leaves the next action without one, and
/// such an action is told why (`files::LayoutInCloud`), never kept waiting.
pub fn record(vault: &VaultLayout, stamp: &LayoutStamp, layout: &VaultWriteLayout) {
    let Some(path) = copy_path(vault) else {
        return;
    };
    let copy = LayoutCopy {
        stamp: stamp.clone(),
        layout: layout.clone(),
    };
    if read(vault).as_ref() == Some(&copy) {
        return;
    }
    let written = serde_json::to_vec_pretty(&copy)
        .map_err(anyhow::Error::from)
        .and_then(|bytes| {
            std::fs::create_dir_all(vault.derived_root())?;
            crate::storage::files::write_atomically(&path, &bytes)
        });
    if let Err(error) = written {
        log::warn!("cannot keep this Mac's copy of the layout at {}: {error:#}", path.display());
    }
}

/// The space has no saved layout, or an invalid one: no copy stands for it.
pub fn forget(vault: &VaultLayout) {
    let Some(path) = copy_path(vault) else {
        return;
    };
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!("cannot remove this Mac's copy of the layout {}: {error}", path.display()),
    }
}
