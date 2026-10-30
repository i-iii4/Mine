//! The file of a picture card (SPEC_CLIPPER.md, «Файл картинки из браузера,
//! отказ сайта и причина ошибки», 29.10.2026): the browser's bytes through
//! the upload server (Б1), and the reason of a failed download in the answer
//! and the journal instead of `MissingMedia` (Б3). The single request on a
//! `429` (Б2) is tested where downloads are made, in `net.rs`.

use super::*;
use mine_lib::domain::vault::VaultWriteLayout;
use tempfile::TempDir;

/// A space with the standard layout.
fn space() -> (TempDir, VaultLayout) {
    let tmp = TempDir::new().unwrap();
    let vault = VaultLayout::with_derived_root(tmp.path().join("space"), tmp.path().join("derived"))
        .with_write_layout(VaultWriteLayout::standard());
    for folder in ["Cards", "Collections", "Media"] {
        std::fs::create_dir_all(vault.root().join(folder)).unwrap();
    }
    (tmp, vault)
}

/// The one answer of a Save.
fn saved(vault: &VaultLayout, request: serde_json::Value) -> serde_json::Value {
    SC0_RESPONSE_CAPTURE.with(|capture| *capture.borrow_mut() = Some(Vec::new()));
    handle_save_block(vault, request);
    let sent = SC0_RESPONSE_CAPTURE.with(|capture| capture.borrow_mut().take().unwrap());
    let mut answers: Vec<serde_json::Value> = sent
        .iter()
        .map(|text| serde_json::from_str(text).unwrap())
        .filter(|answer: &serde_json::Value| answer.get("progress").is_none())
        .collect();
    assert_eq!(answers.len(), 1, "{answers:?}");
    answers.pop().unwrap()
}

fn picture_request(id: &str, image_url: &str) -> serde_json::Value {
    serde_json::json!({
        "operation_id": id, "block_type": "image", "url": "https://shop.test/products/shirt",
        "body": "", "tags": [], "image_url": image_url, "width": 800, "height": 600,
    })
}

/// No card note was written in the space.
fn no_card_written(vault: &VaultLayout) -> bool {
    std::fs::read_dir(vault.root().join("Cards")).unwrap().next().is_none()
}

/// The head of a JPEG: enough for its type by bytes.
const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0x00, 0x01];

#[test]
fn an_upload_names_its_source_and_older_builds_send_screenshots() {
    assert_eq!(UploadSource::of_request("/upload?filename=a.jpg"), Ok(UploadSource::Screenshot));
    assert_eq!(UploadSource::of_request("/upload?source=screenshot"), Ok(UploadSource::Screenshot));
    assert_eq!(UploadSource::of_request("/upload?filename=a.jpg&source=browser_file"), Ok(UploadSource::BrowserFile));
    assert!(UploadSource::of_request("/upload?source=disk").is_err());
}

/// Б1: a file from the browser has the limit of the helper's own download,
/// 500 MiB; a screenshot keeps 25 MiB.
#[test]
fn a_browser_file_has_the_download_limit_and_a_screenshot_keeps_its_own() {
    assert_eq!(UploadSource::BrowserFile.limit(), net::MAX_MEDIA_BYTES);
    assert_eq!(UploadSource::BrowserFile.limit(), 500 * 1024 * 1024);
    assert_eq!(UploadSource::Screenshot.limit(), 25 * 1024 * 1024);

    let (_tmp, vault) = space();
    let over_screenshot = UploadSource::Screenshot.limit() + 1;
    let mut body = std::io::repeat(1).take(over_screenshot);
    let refused = store_upload_body(&vault, UploadSource::Screenshot, "shot.png", None, None, &mut body);
    assert_eq!(refused.map_err(|refusal| refusal.status), Err(UPLOAD_TOO_LARGE));

    let mut body = std::io::repeat(1).take(over_screenshot);
    let kept = store_upload_body(&vault, UploadSource::BrowserFile, "picture.jpg", None, Some(over_screenshot), &mut body)
        .expect("a browser file over 25 MiB is taken");
    assert_eq!(kept["size"], over_screenshot);
}

/// Б1: a declared length over 500 MiB is refused before a byte is read.
#[test]
fn a_browser_file_over_500_mib_is_refused_unread() {
    struct Unread;
    impl Read for Unread {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            panic!("the body of a refused upload was read");
        }
    }
    let (_tmp, vault) = space();

    let refused = store_upload_body(
        &vault,
        UploadSource::BrowserFile,
        "picture.jpg",
        None,
        Some(net::MAX_MEDIA_BYTES + 1),
        &mut Unread,
    );

    assert_eq!(refused.map_err(|refusal| refusal.status), Err(UPLOAD_TOO_LARGE));
    assert!(!clipper_uploads::pending_uploads_dir(&vault).exists());
}

/// Б1: the bytes the browser had become the card's file as they are, and the
/// helper downloads nothing (the stand-in web serves no address here, so a
/// download would fail the save).
#[test]
fn the_browser_file_becomes_the_card_file_without_a_download() {
    let (_tmp, vault) = space();
    let mut picture = JPEG.to_vec();
    picture.extend((0..=255u8).cycle().take(64 * 1024));
    let uploaded = store_upload_body(
        &vault,
        UploadSource::BrowserFile,
        "Harvest.jpg",
        Some("image/jpeg".into()),
        Some(picture.len() as u64),
        &mut &picture[..],
    )
    .unwrap();
    let upload_id = uploaded["upload_id"].as_str().unwrap();

    let response = saved(
        &vault,
        serde_json::json!({
            "operation_id": upload_id, "block_type": "image",
            "url": "https://b1.picture.test/Harvest.jpg", "body": "", "tags": [],
            "pre_uploaded_id": upload_id, "width": 800, "height": 600,
        }),
    );

    assert_eq!(response["outcome"], "committed", "{response}");
    let note = std::fs::read_to_string(vault.block_path(response["slug"].as_str().unwrap())).unwrap();
    let media: Vec<_> = std::fs::read_dir(vault.media_dir()).unwrap().flatten().map(|entry| entry.path()).collect();
    assert_eq!(media.len(), 1, "{media:?}");
    let name = media[0].file_name().unwrap().to_str().unwrap();
    assert!(note.contains(&format!("[[{name}]]")), "{note}");
    assert_eq!(std::fs::read(&media[0]).unwrap(), picture);
}

/// Б2, Б3: a site that refuses with `429` is named with its code and the
/// time to retry, in the answer and in the journal; nothing is written.
#[test]
fn a_refused_download_names_the_site_the_code_and_when_to_retry() {
    let (_tmp, vault) = space();
    let url = "https://upload.b3-limited.test/a/Harvest.jpg";
    fake_web::serve(url, fake_web::Answer::TooManyRequests { retry_after: Some("600") });
    take_journal_lines();

    let response = saved(&vault, picture_request("b3-429", url));

    let reason = "upload.b3-limited.test is not giving the file right now (HTTP 429). Try again in 10 min.";
    assert_eq!(response["ok"], false, "{response}");
    assert_eq!(response["outcome"], "not_committed", "{response}");
    assert_eq!(response["error"], reason, "{response}");
    assert!(!response["error"].as_str().unwrap().contains("MissingMedia"));
    let journal = take_journal_lines();
    assert!(journal.iter().any(|line| line.contains(reason)), "{journal:?}");
    assert!(no_card_written(&vault));
}

/// Б3: another HTTP failure names the site and the code.
#[test]
fn a_failed_download_names_the_site_and_the_code() {
    let (_tmp, vault) = space();
    let url = "https://cdn.b3-gone.test/picture.jpg";
    fake_web::serve(url, fake_web::Answer::Status(404));

    let response = saved(&vault, picture_request("b3-404", url));

    assert_eq!(response["error"], "cdn.b3-gone.test did not give the file (HTTP 404).", "{response}");
    assert!(no_card_written(&vault));
}

/// Б3: a failure without an HTTP answer names the site and its cause.
#[test]
fn a_download_without_an_answer_names_the_site_and_the_cause() {
    let (_tmp, vault) = space();
    let url = "https://cdn.b3-cut.test/picture.jpg";
    fake_web::serve(url, fake_web::Answer::Cut(JPEG.to_vec()));

    let response = saved(&vault, picture_request("b3-cut", url));

    assert_eq!(
        response["error"],
        "cdn.b3-cut.test did not give the file: connection reset by peer.",
        "{response}"
    );
}

/// Б3: `MissingMedia` stays for a request that named no file at all.
#[test]
fn a_request_without_a_file_source_is_still_missing_media() {
    let (_tmp, vault) = space();

    let response = saved(
        &vault,
        serde_json::json!({
            "operation_id": "b3-none", "block_type": "image", "url": "https://shop.test/products/shirt",
            "body": "", "tags": [],
        }),
    );

    assert_eq!(response["ok"], false, "{response}");
    assert!(response["error"].as_str().unwrap().starts_with("MissingMedia:"), "{response}");
}

#[test]
fn a_wait_is_said_in_seconds_minutes_or_hours() {
    assert_eq!(wait_text(Duration::from_secs(45)), "45 s");
    assert_eq!(wait_text(Duration::from_secs(600)), "10 min");
    assert_eq!(wait_text(Duration::from_secs(601)), "11 min");
    assert_eq!(wait_text(Duration::from_secs(3600)), "1 h");
    assert_eq!(wait_text(Duration::from_secs(5400)), "1 h 30 min");
}

/// Б3: a `429` without `Retry-After` asks to try again later.
#[test]
fn a_refusal_without_retry_after_asks_for_later() {
    let error = anyhow::Error::from(net::HttpStatusError::new(
        "https://cdn.b3.test/a.jpg",
        net::TOO_MANY_REQUESTS,
        None,
        std::time::SystemTime::now(),
    ))
    .context("download failed: https://cdn.b3.test/a.jpg");
    assert_eq!(
        media_download_reason("https://cdn.b3.test/a.jpg", &error),
        "cdn.b3.test is not giving the file right now (HTTP 429). Try again later."
    );
}
