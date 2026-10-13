//! The root guard (SPEC_VAULT_LIFECYCLE.md, П29).
//!
//! Derived data (the index, previews, audio) is only ever removed in bulk once
//! the space's own folder is proven to be there and to be the space that data
//! belongs to. A renamed, moved or unmounted folder makes every card look
//! deleted; without this guard a preview sweep on window focus erased the
//! whole index and every preview of a space its user had merely renamed.
//!
//! When in doubt the guard says "not present": keeping a stale row costs one
//! reconcile later, deleting a live one costs the user their space.

use std::path::PathBuf;

use crate::domain::vault::VaultLayout;

/// What stands at a space's recorded path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootState {
    /// The folder is there and carries this space's identity.
    Present,
    /// No folder at the path, or its identity cannot be read.
    Missing,
    /// A folder is there, but it is another space.
    Foreign,
}

#[derive(Debug, thiserror::Error)]
#[error("space folder {root} is {state:?}; derived data is left untouched")]
pub struct RootUnavailable {
    pub root: PathBuf,
    pub state: RootState,
}

/// Whether the space's folder is present and is the space `vault`'s derived
/// data belongs to.
///
/// A derived store outside the space is named by the space's identifier
/// (`vaults/<vault-id>`); the folder's `.mine/vault-id` (or the legacy
/// `.arena/vault-id`) must then name the same space. A derived store inside
/// the space (`.mine`) belongs to whatever folder holds it.
///
/// Every pass before an action asks here, so the identity file is never
/// waited for (SPEC_CLOUD_STORAGE.md, Х12): while its contents are in
/// iCloud, the folder the store last served (`owner-path.json`, П22) holds
/// the space, as the registry takes it (`space_registry::is_available`), and
/// any other folder cannot be told and counts as missing.
pub fn root_state(vault: &VaultLayout) -> RootState {
    use crate::space_registry::SpaceIdentity;
    let root = vault.root();
    if !root.is_dir() {
        return RootState::Missing;
    }
    let Some(expected) = expected_space_id(vault) else {
        return RootState::Present;
    };
    match crate::space_registry::space_identity(root) {
        SpaceIdentity::Known(id) if id == expected => RootState::Present,
        SpaceIdentity::Known(_) => RootState::Foreign,
        SpaceIdentity::InCloud if crate::space_registry::store_served(vault.derived_root(), root) => {
            RootState::Present
        }
        SpaceIdentity::InCloud | SpaceIdentity::Absent => RootState::Missing,
    }
}

/// `Ok` only when bulk removal of derived data is safe.
pub fn ensure_root_present(vault: &VaultLayout) -> Result<(), RootUnavailable> {
    match root_state(vault) {
        RootState::Present => Ok(()),
        state => Err(RootUnavailable {
            root: vault.root().to_path_buf(),
            state,
        }),
    }
}

/// Whether the open space's folder is gone: missing, or another space. The
/// watch that asks every few seconds never waits for iCloud: an identity
/// file whose contents are only in the cloud cannot prove the folder gone,
/// and reading it would stall on a download or fail offline.
pub fn root_gone(vault: &VaultLayout) -> bool {
    let root = vault.root();
    if !root.is_dir() {
        return true;
    }
    if expected_space_id(vault).is_some()
        && [vault.vault_id_path(), vault.legacy_vault_id_path()]
            .iter()
            .any(|path| crate::storage::cloud_files::is_content_offloaded(path))
    {
        return false;
    }
    root_state(vault) != RootState::Present
}

/// The cheap re-check between single removals of a long pass: the folder
/// can be renamed while the pass runs.
pub fn root_still_there(vault: &VaultLayout) -> bool {
    vault.root().is_dir()
}

/// The identifier a derived store outside the space is named by.
fn expected_space_id(vault: &VaultLayout) -> Option<&str> {
    let derived = vault.derived_root();
    if derived == vault.root().join(".mine") {
        return None;
    }
    derived
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| is_space_id(name))
}

/// Space identifiers are 32 lowercase hex digits.
fn is_space_id(name: &str) -> bool {
    name.len() == 32 && name.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_space_whose_identity_is_only_in_icloud_is_not_gone() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("NSFV");
        std::fs::create_dir_all(root.join(".mine")).unwrap();
        let identity = root.join(".mine/vault-id");
        std::fs::File::create(&identity).unwrap().set_len(32).unwrap();
        // Its contents are in iCloud (`SF_DATALESS`, set only by the kernel).
        crate::storage::cloud_files::test_seam::mark_offloaded(&identity);
        let vault = VaultLayout::with_derived_root(
            root.clone(),
            tmp.path().join("vaults").join("e7fc8f8bf1294aaa89f375ac9cfaf1b4"),
        );
        assert!(!root_gone(&vault));
        std::fs::rename(&root, tmp.path().join("NSFV!")).unwrap();
        assert!(root_gone(&vault));
    }

    use super::*;

    const ID: &str = "cea575682e5a4018991c0097fbedff66";

    fn space(id: Option<&str>) -> (tempfile::TempDir, tempfile::TempDir, VaultLayout) {
        let source = tempfile::tempdir().unwrap();
        let derived_parent = tempfile::tempdir().unwrap();
        let derived = derived_parent.path().join(ID);
        std::fs::create_dir_all(&derived).unwrap();
        if let Some(id) = id {
            std::fs::create_dir_all(source.path().join(".mine")).unwrap();
            std::fs::write(source.path().join(".mine/vault-id"), id).unwrap();
        }
        let vault = VaultLayout::with_derived_root(source.path().to_path_buf(), derived);
        (source, derived_parent, vault)
    }

    #[test]
    fn a_folder_carrying_the_space_identity_is_present() {
        let (_source, _derived, vault) = space(Some(&format!("{ID}\n")));
        assert_eq!(root_state(&vault), RootState::Present);
        assert!(ensure_root_present(&vault).is_ok());
    }

    #[test]
    fn a_renamed_folder_is_missing() {
        let (source, _derived, vault) = space(Some(ID));
        let renamed = source.path().with_file_name(format!(
            "{}!",
            source.path().file_name().unwrap().to_str().unwrap()
        ));
        std::fs::rename(source.path(), &renamed).unwrap();
        assert_eq!(root_state(&vault), RootState::Missing);
        assert!(!root_still_there(&vault));
        std::fs::rename(&renamed, source.path()).unwrap();
    }

    #[test]
    fn another_space_at_the_path_is_foreign() {
        let (_source, _derived, vault) = space(Some("0123456789abcdef0123456789abcdef"));
        assert_eq!(root_state(&vault), RootState::Foreign);
    }

    /// SPEC_CLOUD_STORAGE.md, Х12: every action's pass asks the guard, so
    /// the guard never waits for an identity iCloud took away. The folder the
    /// store last served, holding the evicted identity file, is the space;
    /// any other folder with an evicted identity cannot be told and counts as
    /// missing. Neither is read.
    #[test]
    fn an_evicted_identity_is_never_read() {
        let (source, _derived, vault) = space(Some(ID));
        let identity = source.path().join(".mine/vault-id");
        crate::space_registry::record_owner_path(vault.derived_root(), source.path());
        crate::storage::cloud_files::test_seam::mark_offloaded(&identity);
        assert_eq!(root_state(&vault), RootState::Present);
        assert!(ensure_root_present(&vault).is_ok());

        crate::space_registry::record_owner_path(vault.derived_root(), &source.path().join("elsewhere"));
        assert_eq!(root_state(&vault), RootState::Missing);
        assert_eq!(crate::storage::cloud_files::test_seam::reads_of(&identity), 0);
    }

    #[test]
    fn a_folder_whose_identity_cannot_be_read_counts_as_missing() {
        let (_source, _derived, vault) = space(None);
        assert_eq!(root_state(&vault), RootState::Missing);
    }

    #[test]
    fn a_derived_store_inside_the_space_only_needs_the_folder() {
        let source = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(source.path().to_path_buf());
        assert_eq!(root_state(&vault), RootState::Present);
    }

    #[test]
    fn the_legacy_identity_file_is_read_too() {
        let (source, _derived, vault) = space(None);
        std::fs::create_dir_all(source.path().join(".arena")).unwrap();
        std::fs::write(source.path().join(".arena/vault-id"), ID).unwrap();
        assert_eq!(root_state(&vault), RootState::Present);
    }
}
