//! SPEC_CLOUD_STORAGE.md, Х12: the helper's requests never wait for a
//! service file of the space iCloud took away (SPEC_DEEP_AUDIT.md, Е4.17).
//! The first openings of the clipper after an update waited from 9 to 15 s
//! for the collections while the helper read `.mine/layout.json` of a space
//! whose contents macOS had evicted. Each test failed on the code before its
//! fix.

use super::*;
use mine_lib::domain::vault::VaultWriteLayout;
use mine_lib::storage::cloud_files::test_seam;
use tempfile::TempDir;

const SPACE_ID: &str = "abcdef0123456789abcdef0123456789";

/// A space of the standard layout with the collection page `Art`.
fn standard_space(tmp: &TempDir) -> PathBuf {
    let root = tmp.path().join("Space");
    for folder in [".mine", "Cards", "Collections", "Media"] {
        std::fs::create_dir_all(root.join(folder)).unwrap();
    }
    std::fs::write(root.join(".mine/vault-id"), SPACE_ID).unwrap();
    std::fs::write(
        root.join(".mine/layout.json"),
        r#"{"cards":"Cards","media":"Media","collections":"Collections"}"#,
    )
    .unwrap();
    std::fs::write(root.join("Collections/Art.md"), "---\ntype: channel\n---\n").unwrap();
    std::fs::canonicalize(root).unwrap()
}

/// The space a request about `root` finds.
fn request_space(root: &Path) -> RequestSpace {
    resolve_request_space_in(
        &serde_json::Map::new(),
        None,
        Some(root.to_string_lossy().into_owned()),
        Some(SPACE_ID),
    )
}

/// The space a request opens, or why it cannot.
fn opened(root: &Path, writes: bool, app_state: &Path) -> Result<VaultLayout, String> {
    open_request_vault(&request_space(root), writes, app_state.to_path_buf()).map_err(|refusal| match refusal {
        SpaceRefusal::Space(space) => format!("space {}", space.state),
        SpaceRefusal::Failed(error) => error,
    })
}

/// The responses `run` sent, in order.
fn responses(run: impl FnOnce()) -> Vec<serde_json::Value> {
    SC0_RESPONSE_CAPTURE.with(|capture| {
        assert!(capture.borrow().is_none(), "captures must not nest");
        *capture.borrow_mut() = Some(Vec::new());
    });
    run();
    let sent = SC0_RESPONSE_CAPTURE.with(|capture| capture.borrow_mut().take().unwrap());
    sent.iter().map(|text| serde_json::from_str(text).unwrap()).collect()
}

/// The list of collections takes the layout from this Mac's copy, made when
/// the helper last read it on this Mac.
#[test]
fn the_list_of_collections_reads_no_evicted_layout() {
    let tmp = TempDir::new().unwrap();
    let root = standard_space(&tmp);
    let state = tmp.path().join("state");
    let first = opened(&root, false, &state).unwrap();
    assert_eq!(first.write_layout(), &VaultWriteLayout::standard());
    let layout = root.join(".mine/layout.json");
    test_seam::mark_offloaded(&layout);

    let vault = opened(&root, false, &state).unwrap();
    let listed = list_channels_response(&vault);

    assert_eq!(vault.write_layout(), &VaultWriteLayout::standard());
    assert_eq!(listed["ok"], true, "{listed}");
    assert_eq!(listed["channels"][0]["tag"], "Art", "{listed}");
    assert_eq!(test_seam::reads_of(&layout), 0, "the list brought the layout down");
    test_seam::mark_downloaded(&layout);
}

/// The Save takes the layout from this Mac's copy as well, and anchors its
/// plan to it without reading the evicted file.
#[test]
fn a_save_into_a_space_whose_layout_is_evicted_takes_this_macs_copy() {
    let tmp = TempDir::new().unwrap();
    let root = standard_space(&tmp);
    let state = tmp.path().join("state");
    opened(&root, false, &state).unwrap();
    let layout = root.join(".mine/layout.json");
    test_seam::mark_offloaded(&layout);

    let vault = opened(&root, true, &state).unwrap();
    let sent = responses(|| {
        handle_save_block(
            &vault,
            serde_json::json!({
                "operation_id": "cloud-layout-save", "block_type": "link", "title": "Local link",
                "url": "https://example.com", "body": "", "tags": [],
            }),
        );
    });

    assert_eq!(sent.last().unwrap()["outcome"], "committed", "{sent:?}");
    assert!(root.join("Cards/Local link.md").is_file());
    assert_eq!(test_seam::reads_of(&layout), 0, "the Save brought the layout down");
    test_seam::mark_downloaded(&layout);
}

/// With no copy on this Mac yet, the list goes on with the default layout,
/// which it needs for nothing it answers, and a Save is refused with the
/// reason instead of waiting or writing to the root
/// (SPEC_VAULT_LIFECYCLE.md, П2).
#[test]
fn without_a_copy_of_an_evicted_layout_the_list_goes_on_and_a_save_says_why() {
    let tmp = TempDir::new().unwrap();
    let root = standard_space(&tmp);
    let state = tmp.path().join("state");
    let layout = root.join(".mine/layout.json");
    test_seam::mark_offloaded(&layout);

    let vault = opened(&root, false, &state).unwrap();
    assert_eq!(list_channels_response(&vault)["ok"], true);
    let refused = opened(&root, true, &state).expect_err("a Save needs the layout");

    assert!(refused.contains("iCloud"), "{refused}");
    assert_eq!(test_seam::reads_of(&layout), 0, "the helper brought the layout down");
    test_seam::mark_downloaded(&layout);
}
