//! The helper's findings of the deep audit, Е4 (SPEC_DEEP_AUDIT.md): each
//! test failed on the code before its fix.

use super::*;
use mine_lib::domain::vault::VaultWriteLayout;
use mine_lib::storage::cloud_files::test_seam;
use tempfile::TempDir;

const SPACE_ID: &str = "0123456789abcdef0123456789abcdef";

/// A space with the standard layout and the collection page `Art`.
fn space() -> (TempDir, VaultLayout) {
    let tmp = TempDir::new().unwrap();
    let vault = VaultLayout::with_derived_root(tmp.path().join("space"), tmp.path().join("derived"))
        .with_write_layout(VaultWriteLayout::standard());
    for folder in ["Cards", "Collections", "Media"] {
        std::fs::create_dir_all(vault.root().join(folder)).unwrap();
    }
    std::fs::write(vault.root().join("Collections/Art.md"), "---\ntype: channel\n---\n").unwrap();
    (tmp, vault)
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

/// A link clip into `collections`.
fn link_request(id: &str, collections: &[&str]) -> serde_json::Value {
    serde_json::json!({
        "operation_id": id, "block_type": "link", "title": "Local link",
        "url": "https://example.com", "body": "", "tags": collections,
    })
}

/// Every file under `root` with its bytes.
fn files_under(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut found = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(folder) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else {
                found.push((path.clone(), std::fs::read(&path).unwrap_or_default()));
            }
        }
    }
    found.sort();
    found
}

/// A folder carrying the identity `SPACE_ID` in `.mine/vault-id`.
fn identified_folder(parent: &Path, name: &str) -> String {
    let folder = parent.join(name);
    std::fs::create_dir_all(folder.join(".mine")).unwrap();
    std::fs::write(folder.join(".mine/vault-id"), SPACE_ID).unwrap();
    std::fs::canonicalize(folder).unwrap().to_string_lossy().into_owned()
}

/// One framed native message: 4-byte little-endian length, then the bytes.
fn framed(body: &[u8]) -> Vec<u8> {
    let mut message = (body.len() as u32).to_le_bytes().to_vec();
    message.extend_from_slice(body);
    message
}

/// Е4.12: the extension may send up to 64 MiB to the helper (Chrome's limit
/// for messages to a native host). A 12 MiB request is read like any other;
/// before, every message over 10 MiB ended the helper.
#[test]
fn a_message_over_ten_mib_is_read_and_the_next_one_too() {
    let body = format!(r#"{{"action":"save_block","body":"{}"}}"#, "a".repeat(12 * 1024 * 1024));
    let mut input = framed(body.as_bytes());
    input.extend(framed(br#"{"action":"get_status"}"#));
    let mut reader = std::io::Cursor::new(input);

    let first = read_message_from(&mut reader).unwrap().expect("the big request is read");
    assert_eq!(first.len(), body.len());
    let second = read_message_from(&mut reader).unwrap().expect("the helper reads on");
    assert_eq!(second, r#"{"action":"get_status"}"#);
    assert_eq!(read_message_from(&mut reader).unwrap(), None);
}

/// Е4.13: a data URL without `;base64` carries its bytes percent-encoded
/// (RFC 2397), as pages write inline SVG.
#[test]
fn a_data_url_without_base64_is_decoded() {
    let (bytes, extension) =
        decode_data_url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http://www.w3.org/2000/svg%22%2F%3E")
            .expect("a percent-encoded data URL decodes");
    assert_eq!(bytes, br#"<svg xmlns="http://www.w3.org/2000/svg"/>"#);
    assert_eq!(extension, "svg");

    let (bytes, _) = decode_data_url("data:,Hello%2C%20World").unwrap();
    assert_eq!(bytes, b"Hello, World");

    let (bytes, extension) = decode_data_url("data:image/png;base64,iVBORw0KGgo=").unwrap();
    assert_eq!(bytes, b"\x89PNG\r\n\x1a\n");
    assert_eq!(extension, "png");
}

/// Е4.5: only Cancel is a cancel. Any other failure of the chooser says
/// why, as osascript put it.
#[test]
fn a_failed_folder_chooser_is_not_a_cancel() {
    fn ran(code: i32, stdout: &str, stderr: &str) -> std::process::Output {
        use std::os::unix::process::ExitStatusExt;
        std::process::Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }
    assert_eq!(
        folder_choice(&ran(0, "/Users/x/Space/\n", "")),
        FolderChoice::Chosen("/Users/x/Space".into())
    );
    assert_eq!(
        folder_choice(&ran(1, "", "0:94: execution error: User canceled. (-128)\n")),
        FolderChoice::Cancelled
    );
    assert_eq!(
        folder_choice(&ran(
            1,
            "",
            "0:47: execution error: Not authorized to send Apple events to System Events. (-1743)\n"
        )),
        FolderChoice::Failed("Not authorized to send Apple events to System Events. (-1743)".into())
    );
    assert_eq!(
        folder_choice(&ran(1, "", "")),
        FolderChoice::Failed("osascript exited with status 1".into())
    );
}

/// Е4.6, Н7: the list and the Save take a collection page by one rule. A
/// page whose contents iCloud keeps off this Mac counts as the page without
/// being read: the list never waits for it, and now neither does the Save
/// or a new collection of the same name.
#[test]
fn list_and_save_take_an_evicted_collection_page_by_one_rule() {
    let (_tmp, vault) = space();
    let page = vault.root().join("Collections/Art.md");
    test_seam::mark_offloaded(&page);

    let listed = list_channels_response(&vault);
    assert_eq!(listed["channels"][0]["tag"], "Art", "{listed}");

    let saved = responses(|| handle_save_block(&vault, link_request("e4-6-save", &["Art"])));
    assert_eq!(saved.last().unwrap()["outcome"], "committed", "{saved:?}");
    assert_eq!(test_seam::reads_of(&page), 0, "the Save brought down a page the list took unread");

    let created = responses(|| handle_create_channel(&vault, serde_json::json!({ "tag": "Art" })));
    assert_eq!(created[0]["ok"], false, "{created:?}");
    assert!(created[0]["error"].as_str().unwrap().contains("already exists"), "{created:?}");
    assert_eq!(test_seam::reads_of(&page), 0, "a new collection brought the page down");
    test_seam::mark_downloaded(&page);
}

/// Е4.8: a collection page is the collection; the index is derived. Without
/// a working index the page is written all the same, and the index failure
/// goes to the journal, as every refusal of `create_channel` does.
#[test]
fn a_collection_is_created_without_a_working_index_and_failures_are_journaled() {
    let (tmp, vault) = space();
    std::fs::create_dir_all(tmp.path().join("derived")).unwrap();
    std::fs::write(tmp.path().join("derived/indexes"), "not a folder").unwrap();
    take_journal_lines();

    let created = responses(|| handle_create_channel(&vault, serde_json::json!({ "tag": "Reading" })));
    assert_eq!(created[0]["ok"], true, "{created:?}");
    assert_eq!(created[0]["tag"], "Reading");
    let page = std::fs::read_to_string(vault.root().join("Collections/Reading.md")).unwrap();
    assert!(page.contains("type: channel"), "{page}");
    let journal = take_journal_lines();
    assert!(
        journal.iter().any(|line| line.contains("create_channel") && line.contains("index")),
        "{journal:?}"
    );

    let refused = responses(|| handle_create_channel(&vault, serde_json::json!({ "tag": "Art" })));
    assert_eq!(refused[0]["ok"], false, "{refused:?}");
    let journal = take_journal_lines();
    assert!(
        journal.iter().any(|line| line.contains("create_channel") && line.contains("already exists")),
        "{journal:?}"
    );
}

/// Е4.9: after an update the browser runs the old helper until the updated
/// app installs its own (SPEC_ONBOARDING.md, О5). The app indexes the space
/// under its newer generation; the old helper does not build its old one
/// beside it, which would read every card of the space. A space indexed only
/// under an older generation, or not at all, is still built by the helper.
#[test]
fn an_old_helper_leaves_the_index_to_the_newer_app() {
    let generation = |vault: &VaultLayout, name: &str| {
        let folder = vault.derived_root().join("indexes").join(name);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("index.db"), b"").unwrap();
    };
    let (_tmp, vault) = space();
    generation(&vault, "schema-999-semantics-1");
    BACKGROUND_BUILDS.with(|builds| builds.set(0));

    let listed = responses(|| handle_list_channels(&vault));
    assert_eq!(listed[0]["indexing"], true, "{listed:?}");
    assert_eq!(listed[0]["channels"][0]["tag"], "Art", "{listed:?}");
    assert_eq!(BACKGROUND_BUILDS.with(std::cell::Cell::get), 0, "the old helper built an index of its own");

    let (_older_tmp, older) = space();
    generation(&older, "schema-0-semantics-0");
    responses(|| handle_list_channels(&older));
    assert_eq!(BACKGROUND_BUILDS.with(std::cell::Cell::get), 1, "an older generation stopped the build");
}

/// Е4.15: `get_status` is read-only (SPEC_ONBOARDING.md, О7). A copy of a
/// space that has no identity of its own yet is reported, not given one.
#[test]
fn the_status_of_a_copy_writes_nothing() {
    let tmp = TempDir::new().unwrap();
    let spaces = tmp.path().join("Spaces");
    let original = identified_folder(&spaces, "Mine");
    let copy = identified_folder(&spaces, "Mine copy");
    let state = tmp.path().join("state");
    let vaults = mine_lib::space_registry::vaults_dir(&state);
    mine_lib::space_registry::record_owner_path(&vaults.join(SPACE_ID), Path::new(&original));
    let mut cfg = serde_json::Map::new();
    mine_lib::space_registry::record_open(&mut cfg, SPACE_ID, &original, 1);
    mine_lib::space_registry::add_space(&mut cfg, None, &copy);
    let copy_before = files_under(Path::new(&copy));
    let stores_before = files_under(&vaults);

    let status = status_space_in(&cfg, Some(&vaults), Some(copy.clone()), None);

    assert_eq!(files_under(Path::new(&copy)), copy_before, "the status check wrote into the copy");
    assert_eq!(files_under(&vaults), stores_before, "the status check wrote a derived store");
    assert_eq!(status.state, "copy_unsettled", "{status:?}");
    assert!(status.message().is_some());
}

/// Е4.15: choosing a copy with Add space is the person's act, and the copy
/// gets an identity of its own then (П22); the status then reports it ready.
#[test]
fn a_copy_chosen_with_add_space_gets_its_own_identity() {
    let tmp = TempDir::new().unwrap();
    let spaces = tmp.path().join("Spaces");
    let original = identified_folder(&spaces, "Mine");
    let copy = identified_folder(&spaces, "Mine copy");
    let app = tmp.path().join("app");
    let vaults = mine_lib::space_registry::vaults_dir(&app);
    mine_lib::space_registry::record_owner_path(&vaults.join(SPACE_ID), Path::new(&original));

    let (path, listed) = register_chosen_folder_in(&app, &copy).unwrap();

    assert_eq!(path, copy);
    assert!(listed.contains(&copy), "{listed:?}");
    let own = mine_lib::space_registry::read_space_id(Path::new(&copy)).unwrap();
    assert_ne!(own, SPACE_ID, "the copy kept the original's identity");
    assert_eq!(mine_lib::space_registry::read_space_id(Path::new(&original)).as_deref(), Some(SPACE_ID));
    let cfg = mine_lib::app_config::AppConfig::in_dir(&app).read().unwrap();
    let status = status_space_in(&cfg, Some(&vaults), Some(copy.clone()), None);
    assert_eq!(status.state, "ready", "{status:?}");
    assert_eq!(status.identity.as_deref(), Some(own.as_str()));
}

/// Е4.15: an upload is staged in the derived store; the space folder is
/// written only by the Save that publishes it. A space whose identity is
/// still in the legacy `.arena` folder keeps it there.
#[test]
fn an_upload_writes_nothing_into_the_space() {
    let tmp = TempDir::new().unwrap();
    let folder = tmp.path().join("Spaces/Old");
    std::fs::create_dir_all(folder.join(".arena")).unwrap();
    std::fs::write(folder.join(".arena/vault-id"), SPACE_ID).unwrap();
    let folder = std::fs::canonicalize(folder).unwrap().to_string_lossy().into_owned();
    let state = tmp.path().join("state");
    let mut cfg = serde_json::Map::new();
    mine_lib::space_registry::record_open(&mut cfg, SPACE_ID, &folder, 1);
    let before = files_under(Path::new(&folder));

    let layout = upload_space_in(&cfg, &state, folder.clone()).expect("the space takes the upload");

    assert_eq!(files_under(Path::new(&folder)), before, "the upload wrote into the space");
    assert_eq!(
        layout.derived_root(),
        mine_lib::space_registry::vaults_dir(&state).join(SPACE_ID)
    );
}

/// The head of a JPEG and of a PNG: enough for the type by bytes.
const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0x00];
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

fn article_request(id: &str, body: &str) -> serde_json::Value {
    serde_json::json!({
        "operation_id": id, "block_type": "article", "title": "Article",
        "url": "https://e4.page.test/post", "body": body, "tags": [],
    })
}

/// The one answer of a Save.
fn saved(vault: &VaultLayout, request: serde_json::Value) -> serde_json::Value {
    let mut answers = responses(|| handle_save_block(vault, request));
    answers.retain(|answer| answer.get("progress").is_none());
    assert_eq!(answers.len(), 1, "{answers:?}");
    answers.pop().unwrap()
}

/// The note a committed Save wrote.
fn note_of(vault: &VaultLayout, response: &serde_json::Value) -> String {
    std::fs::read_to_string(vault.block_path(response["slug"].as_str().unwrap())).unwrap()
}

/// Е4.1, Н10: a picture that stays a link to its server is named in the
/// answer, with why; one picture whose address ends in a strange extension
/// no longer leaves every picture of the article remote.
#[test]
fn inline_media_left_on_other_servers_are_named_in_the_answer() {
    let (_tmp, vault) = space();
    let at = |name: &str| format!("https://e4-1.media.test/{name}");
    fake_web::serve(&at("a.png"), fake_web::Answer::Bytes { content_type: "image/png", body: PNG.to_vec() });
    fake_web::serve(&at("gone.jpg"), fake_web::Answer::Status(404));
    fake_web::serve(&at("cut.jpg"), fake_web::Answer::Cut(JPEG.to_vec()));
    fake_web::serve(&at("odd.j-pg"), fake_web::Answer::Bytes { content_type: "image/jpeg", body: JPEG.to_vec() });
    let body = format!(
        "# Article\n\n![a]({})\n\n![gone]({})\n\n![cut]({})\n\n![odd]({})\n",
        at("a.png"),
        at("gone.jpg"),
        at("cut.jpg"),
        at("odd.j-pg")
    );

    let response = saved(&vault, article_request("e4-1-inline", &body));

    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(
        response["remote_media"],
        serde_json::json!([
            { "url": at("gone.jpg"), "kind": "image", "reason": "download_failed" },
            { "url": at("cut.jpg"), "kind": "image", "reason": "download_failed" },
        ]),
        "{response}"
    );
    let note = note_of(&vault, &response);
    assert!(note.contains("(image 1).png|a]]"), "{note}");
    assert!(note.contains(&format!("![gone]({})", at("gone.jpg"))), "{note}");
    assert!(!note.contains(&at("odd.j-pg")), "a strange extension left a picture remote: {note}");
}

/// Е4.1, Н10: the pictures past the limit of 30 stay links, and are named.
#[test]
fn pictures_past_the_limit_are_named_in_the_answer() {
    let (_tmp, vault) = space();
    let at = |index: usize| format!("https://e4-1-limit.media.test/{index}.png");
    let mut body = String::from("# Article\n\n");
    for index in 0..=MAX_INLINE_IMAGES as usize {
        fake_web::serve(&at(index), fake_web::Answer::Bytes { content_type: "image/png", body: PNG.to_vec() });
        body.push_str(&format!("![p]({})\n\n", at(index)));
    }

    let response = saved(&vault, article_request("e4-1-limit", &body));

    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(
        response["remote_media"],
        serde_json::json!([{ "url": at(MAX_INLINE_IMAGES as usize), "kind": "image", "reason": "limit" }]),
        "{response}"
    );
}

/// Е4.1, Н10: a video that stays remote and a poster that cannot be saved
/// for it are both named.
#[test]
fn a_video_and_its_poster_left_remote_are_named_in_the_answer() {
    let (_tmp, vault) = space();
    let video = "https://e4-1-poster.media.test/clip.mp4";
    let poster = "https://e4-1-poster.media.test/poster.jpg";
    fake_web::serve(video, fake_web::Answer::Status(403));
    fake_web::serve(poster, fake_web::Answer::Status(500));
    let mut request = article_request("e4-1-poster", &format!("# Article\n\n![]({video})\n"));
    request["video_posters"] = serde_json::json!([{ "video_url": video, "poster_url": poster }]);

    let response = saved(&vault, request);

    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(
        response["remote_media"],
        serde_json::json!([
            { "url": video, "kind": "video", "reason": "download_failed" },
            { "url": poster, "kind": "poster", "reason": "download_failed" },
        ]),
        "{response}"
    );
}

/// Е4.11: the helper reports the extension build only when every copy Mine
/// keeps for browsers names it: the copy browsers load from the folder
/// adopted before managed packages (`clipper/extension`) and the managed one.
/// Copies that disagree say nothing about what a browser runs.
#[test]
fn the_installed_extension_build_is_the_one_every_copy_names() {
    let tmp = TempDir::new().unwrap();
    let install = |folder: &str, build: &str| {
        let dist = tmp.path().join(folder).join("dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(tmp.path().join(folder).join("manifest.json"), r#"{"name":"Mine"}"#).unwrap();
        std::fs::write(dist.join("runtime-identity.json"), format!(r#"{{"buildId":"{build}","commit":"c"}}"#))
            .unwrap();
    };
    install("clipper/managed-v1/extension", "new");
    assert_eq!(installed_extension_build(tmp.path()).as_deref(), Some("new"));
    install("clipper/extension", "old");
    assert_eq!(installed_extension_build(tmp.path()), None, "copies that disagree named a build");
    install("clipper/extension", "new");
    assert_eq!(installed_extension_build(tmp.path()).as_deref(), Some("new"));
}

/// Run a Save of `request` in `vault` with `publish` in place of the file
/// publication.
fn save_publishing(
    vault: &VaultLayout,
    request: &serde_json::Value,
    publish: impl FnMut(&Path, &Path) -> anyhow::Result<()>,
) -> anyhow::Result<serde_json::Value> {
    let p: SaveBlockParams = serde_json::from_value(request.clone()).unwrap();
    let binding = save_operations::binding_id(vault).unwrap();
    let store = operation_store(vault).unwrap();
    let locked = store.lock(&binding).unwrap();
    let id = request["operation_id"].as_str().unwrap();
    let mut record = locked.begin(id, fingerprint_capture(&p, &binding), request).unwrap();
    perform_save_block_with_publisher(vault, p, &locked, &mut record, publish)
}

/// Е4.14: the card's name was taken by another writer the moment the card
/// was published (`EEXIST`). Nothing of the card was written, so it is
/// published under the next free name; before, the Save stayed `unknown`
/// for good. The other writer's file is left as it is.
#[test]
fn a_card_name_taken_at_publication_is_saved_under_a_free_name() {
    let (_tmp, vault) = space();
    let request = serde_json::json!({
        "operation_id": "e4-14-race", "block_type": "link", "title": "Taken",
        "url": "https://example.com", "body": "", "tags": [],
    });
    let response = save_publishing(&vault, &request, |staged, path| {
        if path.ends_with("Cards/Taken.md") {
            std::fs::write(path, "another writer").unwrap();
        }
        files::copy_new_atomically(staged, path)
    })
    .expect("the Save is decided");

    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(response["slug"], "Cards/Taken (2)", "{response}");
    assert_eq!(std::fs::read_to_string(vault.root().join("Cards/Taken.md")).unwrap(), "another writer");
    assert!(vault.root().join("Cards/Taken (2).md").is_file());
    let looked_up = responses(|| handle_get_save_operation(&vault, serde_json::json!({ "operation_id": "e4-14-race" })));
    assert_eq!(looked_up[0]["outcome"], "committed", "{looked_up:?}");
    assert_eq!(looked_up[0]["slug"], "Cards/Taken (2)");
}

/// Е4.14: the name was taken after the media were published and before the
/// card was: the card goes under the next free name, beside its media.
#[test]
fn a_card_name_taken_after_its_media_is_saved_under_a_free_name() {
    let (_tmp, vault) = space();
    let upload = clipper_uploads::write_pending_upload(&vault, "shot.jpg", None, JPEG).unwrap();
    let request = serde_json::json!({
        "operation_id": upload.upload_id, "block_type": "image", "title": "Shot",
        "pre_uploaded_id": upload.upload_id, "body": "", "tags": [],
    });
    let card = vault.root().join("Cards/Shot.md");
    let response = save_publishing(&vault, &request, |staged, path| {
        files::copy_new_atomically(staged, path)?;
        if path.extension().is_some_and(|ext| ext != "md") {
            std::fs::write(&card, "another writer").unwrap();
        }
        Ok(())
    })
    .expect("the Save is decided");

    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(response["slug"], "Cards/Shot (2)", "{response}");
    assert_eq!(std::fs::read_to_string(&card).unwrap(), "another writer");
    let note = std::fs::read_to_string(vault.root().join("Cards/Shot (2).md")).unwrap();
    assert!(note.contains("Shot.jpg"), "{note}");
}

/// Н9: a lookup answers while a save of the same space holds the journal.
/// A finished operation answers from its receipt; one still under way is
/// `unknown` for now. Before, the lookup waited for the save to end.
#[test]
fn a_lookup_answers_while_a_save_holds_the_journal() {
    let (_tmp, vault) = space();
    let done = saved(&vault, link_request("e4-n9-done", &[]));
    assert_eq!(done["outcome"], "committed");
    let binding = save_operations::binding_id(&vault).unwrap();
    let store = operation_store(&vault).unwrap();
    let held = store.lock(&binding).unwrap();
    {
        let p: SaveBlockParams = serde_json::from_value(link_request("e4-n9-running", &[])).unwrap();
        held.begin("e4-n9-running", fingerprint_capture(&p, &binding), &link_request("e4-n9-running", &[]))
            .unwrap();
    }

    let (sender, answers) = std::sync::mpsc::channel();
    let lookup_vault = vault.clone();
    std::thread::spawn(move || {
        for id in ["e4-n9-done", "e4-n9-running"] {
            let answer = responses(|| {
                handle_get_save_operation(&lookup_vault, serde_json::json!({ "operation_id": id }));
            });
            let _ = sender.send(answer[0].clone());
        }
    });
    let finished = answers.recv_timeout(Duration::from_secs(5)).expect("the lookup waited for the save");
    let running = answers.recv_timeout(Duration::from_secs(5)).expect("the lookup waited for the save");
    drop(held);

    assert_eq!(finished["outcome"], "committed", "{finished}");
    assert_eq!(finished["slug"], done["slug"]);
    assert_eq!(running["outcome"], "unknown", "{running}");
    assert_eq!(running["code"], "operation_busy", "{running}");
}

/// Н9, Е4.3: while a Save keeps working the clipper hears so, at most once
/// per interval; a Save that stopped producing signs of work says nothing,
/// and nothing is said after the answer.
#[test]
fn a_save_that_keeps_working_says_so_and_a_stuck_one_does_not() {
    static BUSY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    static STUCK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let count = || {
        let reports = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = Arc::clone(&reports);
        let report = move || {
            counted.fetch_add(1, Ordering::SeqCst);
        };
        (reports, report)
    };

    let (busy, report) = count();
    reporting_progress(&BUSY, Duration::from_millis(100), report, || {
        for _ in 0..20 {
            BUSY.fetch_add(1, Ordering::Relaxed);
            std::thread::sleep(Duration::from_millis(30));
        }
    });
    let reported = busy.load(Ordering::SeqCst);
    assert!((3..=7).contains(&reported), "{reported} reports in 600 ms at most every 100 ms");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(busy.load(Ordering::SeqCst), reported, "a report came after the answer");

    let (stuck, report) = count();
    reporting_progress(&STUCK, Duration::from_millis(100), report, || {
        std::thread::sleep(Duration::from_millis(600));
    });
    assert_eq!(stuck.load(Ordering::SeqCst), 0, "a stuck save said it was working");
}

/// Н9, Е4.3: a large download that keeps its bytes coming is a Save at
/// work, however long it takes; its parts are the signs of work.
#[test]
fn the_parts_of_a_slow_download_are_signs_of_work() {
    let (_tmp, vault) = space();
    let url = "https://e4-3.media.test/large.png";
    fake_web::serve(
        url,
        fake_web::Answer::Slow { body: PNG.repeat(64), chunks: 8, pause: Duration::from_millis(80) },
    );
    let reports = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = Arc::clone(&reports);
    let request = article_request("e4-3-slow", &format!("# Article\n\n![large]({url})\n"));
    let response = reporting_progress(
        &WORK_SIGNS,
        Duration::from_millis(100),
        move || {
            counted.fetch_add(1, Ordering::SeqCst);
        },
        || save_block_response(&vault, request),
    );
    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(response["remote_media"], serde_json::json!([]), "{response}");
    assert!(reports.load(Ordering::SeqCst) >= 3, "the download said nothing while it ran");
}

/// The card a Save wrote is in the index as a pass of the app would put it,
/// with the stamp of its file: the next pass knows it unchanged and never
/// reads it again. Before, the helper wrote the row without the stamp, the
/// next pass took the card for a new one, and in an iCloud space that had
/// evicted it a user's action waited for its download (live case,
/// 13.10.2026: `mine card delete` read a card the clipper had saved).
#[test]
fn the_next_pass_knows_a_saved_card_without_reading_it() {
    let (_tmp, vault) = space();
    {
        let (vault, conn, _) = db::open_vault_index(vault.clone()).unwrap();
        mine_lib::storage::reconcile::reconcile_vault(&conn, &vault).unwrap();
    }
    let response = saved(&vault, link_request("e4-stamp", &[]));
    assert_eq!(response["outcome"], "committed", "{response}");
    let note = vault.block_path(response["slug"].as_str().unwrap());
    // iCloud takes the card's contents off this Mac.
    test_seam::mark_offloaded(&note);

    let (selected, conn, _) = db::open_vault_index(vault.clone()).unwrap();
    let action = mine_lib::storage::reconcile::reconcile_vault_for_action(&conn, &selected).unwrap();
    assert!(action.deferred.is_empty(), "the action's pass took the card for a new one: {:?}", action.deferred);
    mine_lib::storage::reconcile::reconcile_vault(&conn, &selected).unwrap();
    assert_eq!(test_seam::reads_of(&note), 0, "a pass read the card the Save had just indexed");
    test_seam::mark_downloaded(&note);
}

/// A new collection waits for no other note: a card synced from another
/// Mac whose contents iCloud keeps off this one is not read, where the
/// identity history read every new note of the space (SPEC_CLOUD_STORAGE.md,
/// Х12). The app's next pass enrolls the page, as any note written beside it.
#[test]
fn a_new_collection_reads_no_other_note() {
    let (_tmp, vault) = space();
    let synced = vault.root().join("Cards/From another Mac.md");
    std::fs::write(&synced, "# From another Mac\n\nText.\n").unwrap();
    test_seam::mark_offloaded(&synced);

    let created = responses(|| handle_create_channel(&vault, serde_json::json!({ "tag": "Reading" })));

    assert_eq!(created[0]["ok"], true, "{created:?}");
    assert_eq!(test_seam::reads_of(&synced), 0, "a new collection brought another note down");
    test_seam::mark_downloaded(&synced);
}

/// Е4.4: the helper's `log::warn!` lines reach its journal, and every
/// journal line starts with the local time to the millisecond.
#[test]
fn log_records_reach_the_journal_with_their_time() {
    install_journal_logger();
    take_journal_lines();
    log::warn!("inline-media: a probe line");
    host_log("a plain line");
    let lines = take_journal_lines();
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert!(lines[0].contains(" WARN native_host"), "{lines:?}");
    assert!(lines[0].ends_with(": inline-media: a probe line"), "{lines:?}");
    assert!(lines[1].ends_with(" a plain line"), "{lines:?}");
    for line in &lines {
        // `YYYY-MM-DDTHH:MM:SS.mmm `
        let stamp = &line[..24];
        assert_eq!(&stamp[4..5], "-", "{line}");
        assert_eq!(&stamp[10..11], "T", "{line}");
        assert_eq!(&stamp[19..20], ".", "{line}");
        assert!(stamp[20..23].bytes().all(|byte| byte.is_ascii_digit()), "{line}");
    }
}
