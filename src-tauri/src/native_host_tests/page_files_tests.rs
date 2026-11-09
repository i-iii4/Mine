//! The one route of a file from the page (SPEC_CLIPPER.md, «Один путь файла со
//! страницы»): table Б8 row by row, the requests a file costs the site, the
//! uploads of `browser_files` from their taking to their release (Б9), the line
//! of each file in the journal (Б10) and a request of an older extension.

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

fn article(id: &str, body: &str, browser_files: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "operation_id": id, "block_type": "article", "url": "https://shop.b8.test/a",
        "body": body, "tags": [], "browser_files": browser_files,
    })
}

fn card(id: &str, block_type: &str, image_url: &str, browser_files: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "operation_id": id, "block_type": block_type, "url": "https://shop.b8.test/a",
        "title": format!("Card {id}"), "body": "# Card", "tags": [], "image_url": image_url,
        "browser_files": browser_files,
    })
}

/// A JPEG head and bytes of its own, so that files are never merged by accident.
fn jpeg(mark: &str) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0x00, 0x01];
    bytes.extend_from_slice(mark.as_bytes());
    bytes
}

fn uploaded(vault: &VaultLayout, name: &str, content_type: &str, bytes: &[u8]) -> String {
    clipper_uploads::write_pending_upload(vault, name, Some(content_type.to_string()), bytes)
        .unwrap()
        .upload_id
}

fn note_of(vault: &VaultLayout, response: &serde_json::Value) -> String {
    std::fs::read_to_string(vault.block_path(response["slug"].as_str().unwrap())).unwrap()
}

fn media_names(vault: &VaultLayout) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(vault.media_dir())
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// The journal lines of this run about `url`.
fn journal_about(url: &str) -> Vec<String> {
    ALL_JOURNAL_LINES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
        .filter(|line| line.contains(url))
        .cloned()
        .collect()
}

fn upload_gone(vault: &VaultLayout, upload: &str) -> bool {
    !clipper_uploads::pending_upload_dir(vault, upload).unwrap().exists()
}

/// The bytes of an upload are gone and only its receipt stays.
fn upload_released(vault: &VaultLayout, upload: &str) -> bool {
    let manifest = clipper_uploads::load_pending_upload(vault, upload).unwrap();
    let payload = clipper_uploads::pending_upload_dir(vault, upload).unwrap().join(&manifest.payload_filename);
    manifest.committed && !payload.exists()
}

// ─── Table Б8 ───────────────────────────────────────────────────────────────

/// Rows «Файл из кэша страницы» and «Файл от запроса браузера»: the helper takes
/// the file and asks the site nothing. The stand-in web serves no such address,
/// so a request would fail the Save.
#[test]
fn a_file_from_the_browser_costs_the_helper_no_request() {
    let (_tmp, vault) = space();
    let cached = "https://cdn.b8-taken.test/cached.jpg";
    let requested = "https://cdn.b8-taken.test/requested.jpg";
    let from_page = "https://cdn.b8-taken.test/page.jpg";
    let body = format!("# A\n\n![c]({cached})\n\n![r]({requested})\n\n![p]({from_page})\n");
    let files = serde_json::json!([
        { "url": cached, "upload_id": uploaded(&vault, "a.jpg", "image/jpeg", &jpeg("cached")), "source": "cache" },
        { "url": requested, "upload_id": uploaded(&vault, "b.jpg", "image/jpeg", &jpeg("requested")),
          "source": "browser", "final_url": requested },
        { "url": from_page, "upload_id": uploaded(&vault, "c.jpg", "image/jpeg", &jpeg("page")), "source": "page" },
    ]);

    let response = saved(&vault, article("b8-taken", &body, files));

    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(response["remote_media"], serde_json::json!([]), "{response}");
    let note = note_of(&vault, &response);
    assert!(!note.contains("cdn.b8-taken.test"), "{note}");
    assert_eq!(media_names(&vault).len(), 3);
    for url in [cached, requested, from_page] {
        assert_eq!((fake_web::gets(url), fake_web::heads(url)), (0, 0), "{url}");
    }
}

/// Row `429`: no download, and the following files of the host are not asked
/// for either; a file of that host the browser has stays a file (from the cache).
#[test]
fn a_429_of_the_browser_closes_the_host_for_the_helper() {
    let (_tmp, vault) = space();
    let at = |name: &str| format!("https://cdn.b8-429.test/{name}");
    let elsewhere = "https://other.b8-429.test/fine.jpg";
    for name in ["limited.jpg", "next.jpg", "unlisted.jpg"] {
        fake_web::serve(&at(name), fake_web::Answer::Bytes { content_type: "image/jpeg", body: jpeg(name) });
    }
    fake_web::serve(elsewhere, fake_web::Answer::Bytes { content_type: "image/jpeg", body: jpeg("elsewhere") });
    let body = format!(
        "# A\n\n![a]({})\n\n![b]({})\n\n![c]({})\n\n![d]({})\n\n![e]({elsewhere})\n",
        at("limited.jpg"), at("next.jpg"), at("unlisted.jpg"), at("cached.jpg")
    );
    let files = serde_json::json!([
        { "url": at("limited.jpg"), "status": 429, "retry_after": 600 },
        { "url": at("next.jpg"), "failure": "host_limited", "retry_after": 600 },
        { "url": at("cached.jpg"), "upload_id": uploaded(&vault, "x.jpg", "image/jpeg", &jpeg("cached")), "source": "cache" },
    ]);

    let response = saved(&vault, article("b8-429", &body, files));

    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(
        response["remote_media"],
        serde_json::json!([
            { "url": at("limited.jpg"), "kind": "image", "reason": "download_failed" },
            { "url": at("next.jpg"), "kind": "image", "reason": "download_failed" },
            { "url": at("unlisted.jpg"), "kind": "image", "reason": "download_failed" },
        ]),
    );
    for name in ["limited.jpg", "next.jpg", "unlisted.jpg", "cached.jpg"] {
        assert_eq!(fake_web::gets(&at(name)), 0, "{name}");
    }
    assert_eq!(fake_web::gets(elsewhere), 1);
    let note = note_of(&vault, &response);
    assert!(note.contains("(image 4).jpg|d]]"), "a file from the cache stayed a link: {note}");
}

/// Row `429` of a picture card: the Save names the site and when to retry (Б3).
#[test]
fn a_picture_card_refused_with_429_says_when_to_retry() {
    let (_tmp, vault) = space();
    let url = "https://cdn.b8-card-429.test/a.jpg";
    fake_web::serve(url, fake_web::Answer::Bytes { content_type: "image/jpeg", body: jpeg("never") });

    let response = saved(&vault, card("b8-card-429", "image", url, serde_json::json!([{ "url": url, "status": 429, "retry_after": 600 }])));

    assert_eq!(response["ok"], false, "{response}");
    assert_eq!(
        response["error"],
        "cdn.b8-card-429.test is not giving the file right now (HTTP 429). Try again in 10 min."
    );
    assert_eq!(fake_web::gets(url), 0);
}

/// Rows `404`, `410`: the file is not on the site, the helper does not ask.
#[test]
fn a_file_the_site_does_not_have_is_not_asked_for_again() {
    let (_tmp, vault) = space();
    let gone = "https://cdn.b8-gone.test/gone.jpg";
    let removed = "https://cdn.b8-gone.test/removed.jpg";
    fake_web::serve(gone, fake_web::Answer::Bytes { content_type: "image/jpeg", body: jpeg("never") });
    let body = format!("# A\n\n![g]({gone})\n\n![r]({removed})\n");
    let files = serde_json::json!([{ "url": gone, "status": 404 }, { "url": removed, "status": 410 }]);

    let response = saved(&vault, article("b8-gone", &body, files));

    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(response["remote_media"].as_array().unwrap().len(), 2);
    assert_eq!((fake_web::gets(gone), fake_web::gets(removed)), (0, 0));
    assert!(note_of(&vault, &response).contains(gone));
}

/// Row «Другой код отказа, ответ `text/html`»: one attempt, which may succeed.
#[test]
fn another_refusal_of_the_browser_is_worth_one_attempt() {
    let (_tmp, vault) = space();
    let refused = "https://cdn.b8-one.test/refused.jpg";
    let page = "https://cdn.b8-one.test/page.jpg";
    let broken = "https://cdn.b8-one.test/broken.jpg";
    fake_web::serve(refused, fake_web::Answer::Bytes { content_type: "image/jpeg", body: jpeg("refused") });
    fake_web::serve(page, fake_web::Answer::Bytes { content_type: "image/jpeg", body: jpeg("page") });
    fake_web::serve(broken, fake_web::Answer::Status(503));
    let body = format!("# A\n\n![a]({refused})\n\n![b]({page})\n\n![c]({broken})\n");
    let files = serde_json::json!([
        { "url": refused, "status": 403 },
        { "url": page, "failure": "not_a_file" },
        { "url": broken, "status": 500 },
    ]);

    let response = saved(&vault, article("b8-one", &body, files));

    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(
        response["remote_media"],
        serde_json::json!([{ "url": broken, "kind": "image", "reason": "download_failed" }]),
    );
    assert_eq!((fake_web::gets(refused), fake_web::gets(page), fake_web::gets(broken)), (1, 1, 1));
}

/// A web page is not the file for the helper either (Б8).
#[test]
fn a_web_page_does_not_become_the_file_of_the_helper() {
    let (_tmp, vault) = space();
    let url = "https://cdn.b8-html.test/picture.jpg";
    fake_web::serve(url, fake_web::Answer::Bytes { content_type: "text/html", body: b"<html>Are you a robot?".to_vec() });

    let response = saved(&vault, card("b8-html", "image", url, serde_json::json!([{ "url": url, "failure": "not_a_file" }])));

    assert_eq!(response["ok"], false, "{response}");
    assert_eq!(response["error"], "cdn.b8-html.test did not give the file: the answer is a web page.");
    assert_eq!(fake_web::gets(url), 1);
}

/// Row «Нет ответа»: up to three attempts, as without the browser.
#[test]
fn no_answer_of_the_browser_is_worth_three_attempts() {
    let (_tmp, vault) = space();
    let url = "https://cdn.b8-silent.test/a.jpg";
    fake_web::serve(url, fake_web::Answer::Cut(jpeg("part")));
    let body = format!("# A\n\n![a]({url})\n");

    let response = saved(&vault, article("b8-silent", &body, serde_json::json!([{ "url": url, "failure": "no_answer" }])));

    assert_eq!(response["remote_media"].as_array().unwrap().len(), 1, "{response}");
    assert_eq!(fake_web::gets(url), 3);
}

/// A word this helper does not know is an answer it did not get.
#[test]
fn an_unknown_failure_counts_as_no_answer() {
    let (_tmp, vault) = space();
    let url = "https://cdn.b8-future.test/a.jpg";
    fake_web::serve(url, fake_web::Answer::Bytes { content_type: "image/jpeg", body: jpeg("future") });
    let body = format!("# A\n\n![a]({url})\n");

    let response = saved(&vault, article("b8-future", &body, serde_json::json!([{ "url": url, "failure": "something_new" }])));

    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(fake_web::gets(url), 1);
}

/// Row «Файл больше 500 МиБ»: no download, and the video takes its poster.
#[test]
fn a_video_too_large_for_the_browser_takes_its_poster() {
    let (_tmp, vault) = space();
    let video = "https://cdn.b8-large.test/clip.mp4";
    let poster = "https://cdn.b8-large.test/poster.jpg";
    fake_web::serve(video, fake_web::Answer::Bytes { content_type: "video/mp4", body: b"never".to_vec() });
    let mut request = article(
        "b8-large",
        &format!("# A\n\n![]({video})\n"),
        serde_json::json!([
            { "url": video, "failure": "too_large" },
            { "url": poster, "upload_id": uploaded(&vault, "p.jpg", "image/jpeg", &jpeg("poster")), "source": "browser", "final_url": poster },
        ]),
    );
    request["video_posters"] = serde_json::json!([{ "video_url": video, "poster_url": poster }]);

    let response = saved(&vault, request);

    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(fake_web::gets(video), 0);
    assert_eq!(fake_web::gets(poster), 0);
    assert_eq!(
        response["remote_media"],
        serde_json::json!([{ "url": video, "kind": "video", "reason": "download_failed" }]),
    );
    let note = note_of(&vault, &response);
    assert!(note.contains("(poster).jpg"), "{note}");
    assert!(note.contains(&format!("]({video})")), "{note}");
}

/// Row «Браузер не спрашивал»: as today, up to three attempts.
#[test]
fn a_file_the_browser_did_not_ask_for_is_downloaded_as_before() {
    let (_tmp, vault) = space();
    let url = "https://cdn.b8-unasked.test/a.jpg";
    let other = "https://cdn.b8-unasked.test/b.jpg";
    fake_web::serve(url, fake_web::Answer::Status(500));
    fake_web::serve(other, fake_web::Answer::Bytes { content_type: "image/jpeg", body: jpeg("other") });
    let body = format!("# A\n\n![a]({url})\n\n![b]({other})\n");
    let mut request = article("b8-unasked", &body, serde_json::json!([]));
    request.as_object_mut().unwrap().remove("browser_files");

    let response = saved(&vault, request);

    assert_eq!(fake_web::gets(url), 3);
    assert_eq!(fake_web::gets(other), 1);
    assert_eq!(response["remote_media"].as_array().unwrap().len(), 1, "{response}");
}

/// «Правило о закрытом хосте»: a `429` of the fallback download closes the host
/// for the following files of the Save too.
#[test]
fn a_429_of_the_helper_closes_the_host_for_the_following_files() {
    let (_tmp, vault) = space();
    let first = "https://cdn.b8-own-429.test/og.jpg";
    let next = "https://cdn.b8-own-429.test/next.jpg";
    fake_web::serve(first, fake_web::Answer::TooManyRequests { retry_after: Some("60") });
    fake_web::serve(next, fake_web::Answer::Bytes { content_type: "image/jpeg", body: jpeg("next") });
    let mut request = card("b8-own-429", "link", first, serde_json::json!([]));
    request["body"] = serde_json::json!(format!("# Link\n\n![n]({next})\n"));

    let response = saved(&vault, request);

    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(fake_web::gets(first), 1);
    assert_eq!(fake_web::gets(next), 0, "the closed host was asked again");
    assert_eq!(response["remote_media"].as_array().unwrap().len(), 1, "{response}");
}

// ─── What a file costs ──────────────────────────────────────────────────────

/// Б8, Б9: an address the browser answered about costs no `HEAD`: the type of
/// its upload says what it is, and only an address it did not answer about is
/// probed.
#[test]
fn an_address_from_browser_files_costs_no_head() {
    let (_tmp, vault) = space();
    let at = |name: &str| format!("https://pds.b9-head.test/xrpc/{name}");
    fake_web::serve(&at("refused"), fake_web::Answer::Bytes { content_type: "video/mp4", body: b"\x00\x00\x00\x20ftypisom".to_vec() });
    fake_web::serve(&at("unasked"), fake_web::Answer::Bytes { content_type: "image/png", body: b"\x89PNG\r\n\x1a\n-unasked".to_vec() });
    let body = format!("# A\n\n![u]({})\n\n![r]({})\n\n![n]({})\n", at("uploaded"), at("refused"), at("unasked"));
    let files = serde_json::json!([
        { "url": at("uploaded"), "upload_id": uploaded(&vault, "x", "video/mp4", b"\x00\x00\x00\x20ftypisom-a"), "source": "browser" },
        { "url": at("refused"), "status": 403 },
    ]);

    let response = saved(&vault, article("b9-head", &body, files));

    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(fake_web::heads(&at("uploaded")), 0);
    assert_eq!(fake_web::heads(&at("refused")), 0);
    assert_eq!(fake_web::heads(&at("unasked")), 1);
    let names = media_names(&vault);
    assert!(names.iter().any(|name| name.contains("(video 1).mp4")), "{names:?}");
}

/// Б9: an address without a type that the browser could not get is named by what
/// the helper's own download answered, with no `HEAD`: a video stays a video.
#[test]
fn the_download_of_the_helper_says_what_an_address_without_a_type_holds() {
    let (_tmp, vault) = space();
    let url = "https://ipfs.b9-type.test/ipfs/bafy";
    fake_web::serve(url, fake_web::Answer::Bytes { content_type: "video/mp4", body: b"\x00\x00\x00\x20ftypisom".to_vec() });
    let body = format!("# A\n\n![]({url})\n");

    let response = saved(&vault, article("b9-type", &body, serde_json::json!([{ "url": url, "failure": "no_answer" }])));

    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(fake_web::heads(url), 0);
    let names = media_names(&vault);
    assert_eq!(names.len(), 1, "{names:?}");
    assert!(names[0].ends_with(".mp4"), "{names:?}");
    assert!(note_of(&vault, &response).contains(".mp4"));
}

/// Б8, Б9: an address repeated in the body is one file and one request; each
/// place keeps its caption (Ф5).
#[test]
fn a_repeated_address_costs_one_request_and_takes_one_file() {
    let (_tmp, vault) = space();
    let fetched = "https://cdn.b9-repeat.test/fetched.jpg";
    let upload = "https://cdn.b9-repeat.test/uploaded.jpg";
    fake_web::serve(fetched, fake_web::Answer::Bytes { content_type: "image/jpeg", body: jpeg("fetched") });
    let body = format!("# A\n\n![one]({upload})\n\n![two]({upload})\n\n![three]({fetched})\n\n![four]({fetched})\n");
    let id = uploaded(&vault, "x.jpg", "image/jpeg", &jpeg("uploaded"));
    let files = serde_json::json!([{ "url": upload, "upload_id": id, "source": "cache" }]);

    let response = saved(&vault, article("b9-repeat", &body, files));

    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(fake_web::gets(fetched), 1);
    let note = note_of(&vault, &response);
    assert!(note.contains("(image 1).jpg|one]]") && note.contains("(image 1).jpg|two]]"), "{note}");
    assert!(note.contains("(image 2).jpg|three]]") && note.contains("(image 2).jpg|four]]"), "{note}");
    assert_eq!(media_names(&vault).len(), 2);
    assert!(upload_released(&vault, &id));
}

/// Б11: the body has no limit on its media, and each medium becomes a file.
#[test]
fn a_body_of_100_media_is_saved_as_100_files() {
    let (_tmp, vault) = space();
    let at = |index: usize| format!("https://cdn.b11-long.test/{index}.jpg");
    let mut body = String::from("# Long article\n\n");
    let mut files = Vec::new();
    for index in 0..100 {
        body.push_str(&format!("![p]({})\n\n", at(index)));
        if index % 2 == 0 {
            fake_web::serve(&at(index), fake_web::Answer::Bytes { content_type: "image/jpeg", body: jpeg(&index.to_string()) });
        } else {
            let id = uploaded(&vault, "p.jpg", "image/jpeg", &jpeg(&index.to_string()));
            files.push(serde_json::json!({ "url": at(index), "upload_id": id, "source": "cache" }));
        }
    }

    let response = saved(&vault, article("b11-long", &body, serde_json::json!(files)));

    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(response["remote_media"], serde_json::json!([]), "{response}");
    assert_eq!(media_names(&vault).len(), 100);
    assert!(!note_of(&vault, &response).contains("cdn.b11-long.test"));
}

/// Б9: the preview of a video from the browser is its `thumbnail`, not its `file`.
#[test]
fn the_preview_of_a_video_from_the_browser_is_its_thumbnail() {
    let (_tmp, vault) = space();
    let url = "https://i.b9-thumb.test/vi/abc/maxresdefault.jpg";
    let id = uploaded(&vault, "preview.jpg", "image/jpeg", &jpeg("preview"));
    let files = serde_json::json!([{ "url": url, "upload_id": id, "source": "browser", "final_url": url }]);

    let response = saved(&vault, card("b9-thumb", "video", url, files));

    assert_eq!(response["outcome"], "committed", "{response}");
    let note = note_of(&vault, &response);
    let frontmatter = note.split("---").nth(1).unwrap();
    assert!(frontmatter.contains("thumbnail:"), "{note}");
    assert!(!frontmatter.contains("\nfile:"), "{note}");
    assert_eq!(fake_web::gets(url), 0);
    assert!(upload_released(&vault, &id));
}

/// Б4: a link keeps its preview from the browser, and is saved without one when
/// nobody got it.
#[test]
fn a_link_is_saved_with_or_without_its_preview() {
    let (_tmp, vault) = space();
    let shown = "https://cdn.b4-link.test/og.jpg";
    let id = uploaded(&vault, "og.jpg", "image/jpeg", &jpeg("og"));
    let response = saved(&vault, card("b4-link", "link", shown, serde_json::json!([{ "url": shown, "upload_id": id, "source": "browser" }])));
    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(media_names(&vault).len(), 1);

    let (_tmp, vault) = space();
    let refused = "https://cdn.b4-link.test/gone.jpg";
    let response = saved(&vault, card("b4-link-2", "link", refused, serde_json::json!([{ "url": refused, "status": 404 }])));
    assert_eq!(response["outcome"], "committed", "{response}");
    assert!(media_names(&vault).is_empty());
}

// ─── The life of an upload ──────────────────────────────────────────────────

/// Б9: after the commit each upload gives up its bytes, also when its file was
/// renamed by its content or merged with a repeat. The check after the commit
/// finds the file by the name the helper wrote into the upload.
#[test]
fn uploads_are_released_after_the_commit_and_the_renames() {
    let (_tmp, vault) = space();
    let avif = b"\x00\x00\x00\x1cftypavif\x00\x00\x00\x00avifmif1miaf";
    let at = |name: &str| format!("https://cdn.b9-release.test/{name}");
    let named_png = uploaded(&vault, "logo.png", "image/png", avif);
    let first = uploaded(&vault, "a.jpg", "image/jpeg", &jpeg("same"));
    let second = uploaded(&vault, "b.jpg", "image/jpeg", &jpeg("same"));
    let body = format!("# A\n\n![l]({})\n\n![a]({})\n\n![b]({})\n", at("logo.png"), at("a.jpg"), at("b.jpg"));
    let files = serde_json::json!([
        { "url": at("logo.png"), "upload_id": named_png, "source": "cache" },
        { "url": at("a.jpg"), "upload_id": first, "source": "cache" },
        { "url": at("b.jpg"), "upload_id": second, "source": "cache" },
    ]);

    let response = saved(&vault, article("b9-release", &body, files));

    assert_eq!(response["outcome"], "committed", "{response}");
    let names = media_names(&vault);
    assert_eq!(names.len(), 2, "{names:?}");
    assert!(names.iter().any(|name| name.ends_with(".avif")), "{names:?}");
    for upload in [&named_png, &first, &second] {
        assert!(upload_released(&vault, upload), "{upload} kept its bytes");
    }
    let manifest = clipper_uploads::load_pending_upload(&vault, &named_png).unwrap();
    assert!(manifest.finalization.unwrap().filename.ends_with(".avif"));
}

/// Б9: the upload of a card file renamed by its content is released too, through
/// `pre_uploaded_id` of a screenshot as well.
#[test]
fn a_card_file_renamed_by_its_content_releases_its_upload() {
    let (_tmp, vault) = space();
    let avif = b"\x00\x00\x00\x1cftypavif\x00\x00\x00\x00avifmif1miaf";
    let upload = "https://cdn.b9-card.test/photo.jpg";
    let by_browser = uploaded(&vault, "photo.jpg", "image/jpeg", avif);
    let response = saved(&vault, card("b9-card", "image", upload, serde_json::json!([{ "url": upload, "upload_id": by_browser, "source": "cache" }])));
    assert_eq!(response["outcome"], "committed", "{response}");
    assert!(upload_released(&vault, &by_browser));

    let screenshot = uploaded(&vault, "shot.jpg", "image/jpeg", avif);
    let response = saved(&vault, serde_json::json!({
        "operation_id": "b9-shot", "block_type": "image", "url": "https://shop.b8.test/shot", "title": "Shot",
        "body": "", "tags": [], "pre_uploaded_id": screenshot,
    }));
    assert_eq!(response["outcome"], "committed", "{response}");
    assert!(upload_released(&vault, &screenshot), "a renamed screenshot kept its bytes");
}

/// Б9: a poster that was not needed goes after the commit, and so does an upload
/// for an address the request does not name.
#[test]
fn an_upload_the_save_did_not_need_goes_after_the_commit() {
    let (_tmp, vault) = space();
    let video = "https://cdn.b9-unused.test/clip.mp4";
    let poster = "https://cdn.b9-unused.test/poster.jpg";
    let stranger = "https://cdn.b9-unused.test/stranger.jpg";
    let video_upload = uploaded(&vault, "clip.mp4", "video/mp4", b"\x00\x00\x00\x20ftypisom");
    let poster_upload = uploaded(&vault, "poster.jpg", "image/jpeg", &jpeg("poster"));
    let stranger_upload = uploaded(&vault, "stranger.jpg", "image/jpeg", &jpeg("stranger"));
    let mut request = article(
        "b9-unused",
        &format!("# A\n\n![]({video})\n"),
        serde_json::json!([
            { "url": video, "upload_id": video_upload, "source": "browser" },
            { "url": poster, "upload_id": poster_upload, "source": "browser" },
            { "url": stranger, "upload_id": stranger_upload, "source": "browser" },
        ]),
    );
    request["video_posters"] = serde_json::json!([{ "video_url": video, "poster_url": poster }]);

    let response = saved(&vault, request);

    assert_eq!(response["outcome"], "committed", "{response}");
    assert!(upload_released(&vault, &video_upload));
    assert!(upload_gone(&vault, &poster_upload), "the unneeded poster stayed");
    assert!(upload_gone(&vault, &stranger_upload), "the upload of a stranger stayed");
    assert!(!note_of(&vault, &response).contains("poster"), "the unneeded poster was used");
    assert_eq!(media_names(&vault).len(), 1);
}

/// Б9: a rejected Save gives up its uploads, and a new one goes the route again.
#[test]
fn a_rejected_save_gives_up_its_uploads() {
    let (_tmp, vault) = space();
    let url = "https://cdn.b9-rejected.test/a.jpg";
    let id = uploaded(&vault, "a.jpg", "image/jpeg", &jpeg("a"));
    let mut request = article("b9-rejected", &format!("# A\n\n![a]({url})\n"), serde_json::json!([{ "url": url, "upload_id": id, "source": "cache" }]));
    request["tags"] = serde_json::json!(["No such collection"]);

    let response = saved(&vault, request);

    assert_eq!(response["terminal_rejected"], true, "{response}");
    assert_eq!(response["code"], "collection_not_found", "{response}");
    assert!(upload_gone(&vault, &id));
}

/// A picture card whose file nobody got is rejected: its unused upload goes too.
#[test]
fn a_picture_card_without_its_file_is_rejected_and_keeps_nothing() {
    let (_tmp, vault) = space();
    let url = "https://cdn.b9-no-file.test/a.jpg";
    let stranger = uploaded(&vault, "s.jpg", "image/jpeg", &jpeg("s"));
    let files = serde_json::json!([
        { "url": url, "status": 404 },
        { "url": "https://cdn.b9-no-file.test/other.jpg", "upload_id": stranger, "source": "browser" },
    ]);

    let response = saved(&vault, card("b9-no-file", "image", url, files));

    assert_eq!(response["terminal_rejected"], true, "{response}");
    assert_eq!(response["error"], "cdn.b9-no-file.test did not give the file (HTTP 404).");
    assert!(upload_gone(&vault, &stranger));
    assert!(std::fs::read_dir(vault.root().join("Cards")).unwrap().next().is_none());
}

/// Б9: the same operation again answers with its receipt and asks nobody; the
/// uploads stay released.
#[test]
fn the_same_operation_again_answers_its_receipt() {
    let (_tmp, vault) = space();
    let url = "https://cdn.b9-again.test/a.jpg";
    let id = uploaded(&vault, "a.jpg", "image/jpeg", &jpeg("a"));
    let request = article("b9-again", &format!("# A\n\n![a]({url})\n"), serde_json::json!([{ "url": url, "upload_id": id, "source": "cache" }]));

    let first = saved(&vault, request.clone());
    let again = saved(&vault, request);

    assert_eq!(first["slug"], again["slug"]);
    assert_eq!(again["outcome"], "committed", "{again}");
    assert_eq!(fake_web::gets(url), 0);
    assert_eq!(media_names(&vault).len(), 1);
}

// ─── Incorrect input ────────────────────────────────────────────────────────

/// A wrong `upload_id` and an upload of another folder give way to the fallback
/// download, and the journal says so (Б9).
#[test]
fn an_upload_the_helper_cannot_take_gives_way_to_a_download() {
    let (tmp, vault) = space();
    let wrong = "https://cdn.b9-wrong.test/wrong.jpg";
    let foreign = "https://cdn.b9-wrong.test/foreign.jpg";
    let missing = "https://cdn.b9-wrong.test/missing.jpg";
    for url in [wrong, foreign, missing] {
        fake_web::serve(url, fake_web::Answer::Bytes { content_type: "image/jpeg", body: jpeg(url) });
    }
    let other = VaultLayout::with_derived_root(tmp.path().join("other"), vault.derived_root().to_path_buf());
    std::fs::create_dir_all(other.root()).unwrap();
    std::fs::write(other.root().join("marker"), b"x").unwrap();
    let foreign_upload = clipper_uploads::write_pending_upload(&other, "f.jpg", None, &jpeg("foreign")).unwrap().upload_id;
    let body = format!("# A\n\n![a]({wrong})\n\n![b]({foreign})\n\n![c]({missing})\n");
    let files = serde_json::json!([
        { "url": wrong, "upload_id": "../../escape", "source": "cache" },
        { "url": foreign, "upload_id": foreign_upload, "source": "cache" },
        { "url": missing, "upload_id": "0123456789abcdef0123456789abcdef", "source": "cache" },
    ]);

    let response = saved(&vault, article("b9-wrong", &body, files));

    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(response["remote_media"], serde_json::json!([]), "{response}");
    for url in [wrong, foreign, missing] {
        assert_eq!(fake_web::gets(url), 1, "{url}");
        let lines = journal_about(url);
        assert!(lines.iter().any(|line| line.contains("the upload is not taken")), "{lines:?}");
        assert!(lines.iter().any(|line| line.contains("from helper")), "{lines:?}");
    }
    assert!(clipper_uploads::pending_upload_dir(&other, &foreign_upload).unwrap().exists(), "the upload of another folder was removed");
}

/// Б7: the address after redirects that leads inside is not taken from a request
/// outside the page; the helper's own download checks each hop itself. A request
/// of the page is the page's own (Б5).
#[test]
fn a_file_led_to_an_internal_address_is_not_taken() {
    let (_tmp, vault) = space();
    let led = "https://cdn.b7-final.test/led.jpg";
    let own = "http://192.168.1.5/own.jpg";
    let led_upload = uploaded(&vault, "a.jpg", "image/jpeg", &jpeg("internal"));
    let own_upload = uploaded(&vault, "b.jpg", "image/jpeg", &jpeg("own"));
    let body = format!("# A\n\n![a]({led})\n\n![b]({own})\n");
    let files = serde_json::json!([
        { "url": led, "upload_id": led_upload, "source": "browser", "final_url": "http://10.0.0.5/secret.jpg" },
        { "url": own, "upload_id": own_upload, "source": "page", "final_url": own },
    ]);

    let response = saved(&vault, article("b7-final", &body, files));

    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(
        response["remote_media"],
        serde_json::json!([{ "url": led, "kind": "image", "reason": "download_failed" }]),
    );
    assert_eq!(media_names(&vault).len(), 1);
    assert!(journal_about(led).iter().any(|line| line.contains("10.0.0.5")));
    assert!(upload_gone(&vault, &led_upload), "the upload not taken stayed");
    assert!(upload_released(&vault, &own_upload));
}

// ─── The plan ───────────────────────────────────────────────────────────────

/// Б7: the plan is the core's, and `reachable` says where each name resolves now.
#[test]
fn the_plan_says_which_files_the_browser_may_ask_for() {
    fake_web::without_dns("nowhere.b7-plan.test");
    let answer = plan_page_files_response(&serde_json::json!({
        "action": "plan_page_files",
        "document_url": "https://shop.b7-plan.test/p/1",
        "image_url": "https://cdn.b7-plan.test/og.jpg",
        "body": "![a](https://files.b7-plan.test/a.jpg)\n\n![b](https://nowhere.b7-plan.test/b.jpg)\n\n\
                 ![c](http://10.0.0.5/c.jpg)\n\n![v](https://cdn.b7-plan.test/v.mp4)\n",
        "video_posters": [{ "video_url": "https://cdn.b7-plan.test/v.mp4", "poster_url": "https://cdn.b7-plan.test/p.jpg" }],
    }));

    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(answer["parallel"], 3);
    assert_eq!(answer["per_domain"], 2);
    let files = answer["files"].as_array().unwrap();
    let of = |url: &str| files.iter().find(|file| file["url"] == url).unwrap();
    assert_eq!(files.len(), 6);
    assert_eq!(of("https://files.b7-plan.test/a.jpg")["reachable"], true);
    assert_eq!(of("https://files.b7-plan.test/a.jpg")["cookies"], true);
    assert_eq!(of("https://cdn.b7-plan.test/og.jpg")["referer"], "https://shop.b7-plan.test/");
    assert_eq!(of("https://nowhere.b7-plan.test/b.jpg")["reachable"], false, "a name without an answer");
    assert_eq!(of("http://10.0.0.5/c.jpg")["reachable"], false);
    assert_eq!(of("https://cdn.b7-plan.test/p.jpg")["poster_of"], "https://cdn.b7-plan.test/v.mp4");
    assert_eq!(fake_web::gets("https://cdn.b7-plan.test/og.jpg"), 0);
}

#[test]
fn a_plan_without_the_page_is_refused() {
    let answer = plan_page_files_response(&serde_json::json!({ "action": "plan_page_files", "body": "" }));
    assert_eq!(answer["ok"], false, "{answer}");
    assert_eq!(answer["code"], "invalid_request");
}

/// Б9: uploads of a collection the clipper left are removed; an upload with a
/// `finalization` stays.
#[test]
fn discarding_removes_only_the_uploads_no_save_took() {
    let (_tmp, vault) = space();
    let free = uploaded(&vault, "a.jpg", "image/jpeg", &jpeg("a"));
    let taken = uploaded(&vault, "b.jpg", "image/jpeg", &jpeg("b"));
    clipper_uploads::record_upload_publication(&vault, &taken, "B.jpg", "hash").unwrap();

    let answer = discard_pending_uploads_response(
        &vault,
        &serde_json::json!({ "upload_ids": [free, taken, "not an id"] }),
    );

    assert_eq!(answer, serde_json::json!({ "ok": true, "discarded": 1 }));
    assert!(upload_gone(&vault, &free));
    assert!(!upload_gone(&vault, &taken));
}

// ─── The journal ────────────────────────────────────────────────────────────

/// Б10: one line per file: its address, where it came from, why it was refused
/// with the code. Before, the body's reason was lost in `to_string()`.
#[test]
fn each_file_has_a_line_with_its_source_and_its_reason() {
    let (_tmp, vault) = space();
    let at = |name: &str| format!("https://cdn.b10.test/{name}");
    fake_web::serve(&at("forbidden.jpg"), fake_web::Answer::Status(403));
    fake_web::serve(&at("fetched.jpg"), fake_web::Answer::Bytes { content_type: "image/jpeg", body: jpeg("fetched") });
    fake_web::serve(&at("after.jpg"), fake_web::Answer::Bytes { content_type: "image/jpeg", body: jpeg("after") });
    let body = format!(
        "# A\n\n![a]({})\n\n![b]({})\n\n![c]({})\n\n![d]({})\n\n![e]({})\n",
        at("cache.jpg"), at("request.jpg"), at("forbidden.jpg"), at("fetched.jpg"), at("after.jpg"),
    );
    let files = serde_json::json!([
        { "url": at("cache.jpg"), "upload_id": uploaded(&vault, "a.jpg", "image/jpeg", &jpeg("a")), "source": "cache" },
        { "url": at("request.jpg"), "upload_id": uploaded(&vault, "b.jpg", "image/jpeg", &jpeg("b")), "source": "browser" },
        { "url": at("after.jpg"), "status": 403 },
    ]);

    let response = saved(&vault, article("b10", &body, files));

    assert_eq!(response["outcome"], "committed", "{response}");
    let line = |name: &str| {
        let lines = journal_about(&at(name));
        assert_eq!(lines.len(), 1, "{lines:?}");
        lines[0].clone()
    };
    assert!(line("cache.jpg").ends_with(&format!("page-file: {} from cache", at("cache.jpg"))), "{}", line("cache.jpg"));
    assert!(line("request.jpg").ends_with("from browser"), "{}", line("request.jpg"));
    assert!(line("fetched.jpg").ends_with("from helper"), "{}", line("fetched.jpg"));
    assert!(line("after.jpg").ends_with("from helper (browser: HTTP 403)"), "{}", line("after.jpg"));
    assert!(
        line("forbidden.jpg").ends_with("from link: cdn.b10.test did not give the file (HTTP 403)."),
        "{}",
        line("forbidden.jpg")
    );
}

/// Б10: a poster is named in the journal too.
#[test]
fn a_poster_nobody_got_has_its_line() {
    let (_tmp, vault) = space();
    let video = "https://cdn.b10-poster.test/clip.mp4";
    let poster = "https://cdn.b10-poster.test/poster.jpg";
    fake_web::serve(video, fake_web::Answer::Status(404));
    fake_web::serve(poster, fake_web::Answer::Status(500));
    let mut request = article("b10-poster", &format!("# A\n\n![]({video})\n"), serde_json::json!([]));
    request["video_posters"] = serde_json::json!([{ "video_url": video, "poster_url": poster }]);

    saved(&vault, request);

    assert!(journal_about(poster).iter().any(|line| line.contains("(HTTP 500)")), "{:?}", journal_about(poster));
}

// ─── Older clients ──────────────────────────────────────────────────────────

/// Б9: a request without `browser_files` keeps the fingerprint it had before the
/// field: this value was computed by the helper of 06.11.2026 without the field.
#[test]
fn an_old_request_keeps_its_fingerprint() {
    let p: SaveBlockParams = serde_json::from_value(serde_json::json!({
        "block_type": "article", "url": "https://shop.test/a", "body": "# A\n\n![p](https://cdn.test/a.jpg)",
        "tags": [], "image_url": "https://cdn.test/og.jpg",
        "video_posters": [{ "video_url": "https://cdn.test/v.mp4", "poster_url": "https://cdn.test/p.jpg" }],
    }))
    .unwrap();
    assert_eq!(
        fingerprint_capture(&p, "binding-1"),
        "69406222b5f219cb669fde7a62fa7a83e322ab634f47e7636fead4acc83d300b"
    );
    let stored = serde_json::to_value(&p).unwrap();
    assert!(stored.get("browser_files").is_none(), "{stored}");
}

/// Another list is another request: an operation ID cannot change its files.
#[test]
fn another_list_of_files_is_another_request() {
    let (_tmp, vault) = space();
    let url = "https://cdn.b9-conflict.test/a.jpg";
    let body = format!("# A\n\n![a]({url})\n");
    let first = uploaded(&vault, "a.jpg", "image/jpeg", &jpeg("a"));
    let response = saved(&vault, article("b9-conflict", &body, serde_json::json!([{ "url": url, "upload_id": first, "source": "cache" }])));
    assert_eq!(response["outcome"], "committed", "{response}");

    let refused = saved(&vault, article("b9-conflict", &body, serde_json::json!([{ "url": url, "status": 404 }])));

    assert_eq!(refused["code"], "operation_conflict", "{refused}");
}

// ─── One write of the card ──────────────────────────────────────────────────

/// «Article inline-media pipeline»: the card is written once, after every file
/// of the page is published.
#[test]
fn the_card_appears_only_after_all_its_files() {
    let (_tmp, vault) = space();
    let at = |name: &str| format!("https://cdn.b9-order.test/{name}");
    fake_web::serve(&at("b.jpg"), fake_web::Answer::Bytes { content_type: "image/jpeg", body: jpeg("b") });
    let body = format!("# A\n\n![a]({})\n\n![b]({})\n", at("a.jpg"), at("b.jpg"));
    let request = article(
        "b9-order",
        &body,
        serde_json::json!([{ "url": at("a.jpg"), "upload_id": uploaded(&vault, "a.jpg", "image/jpeg", &jpeg("a")), "source": "cache" }]),
    );
    let p: SaveBlockParams = serde_json::from_value(request.clone()).unwrap();
    let binding = save_operations::binding_id(&vault).unwrap();
    let store = operation_store(&vault).unwrap();
    let locked = store.lock(&binding).unwrap();
    let mut record = locked.begin("b9-order", fingerprint_capture(&p, &binding), &request).unwrap();
    let published = Mutex::new(Vec::new());

    let response = perform_save_block_with_publisher(&vault, p, &locked, &mut record, |staged, path| {
        files::copy_new_atomically(staged, path)?;
        published.lock().unwrap().push(path.extension().unwrap().to_string_lossy().into_owned());
        Ok(())
    })
    .unwrap();

    assert_eq!(response["outcome"], "committed", "{response}");
    assert_eq!(*published.lock().unwrap(), ["jpg", "jpg", "md"]);
}

/// Older records of the journal name one upload; they are read and released.
#[test]
fn a_record_with_one_upload_is_read_as_before() {
    let older: save_operations::SaveOperationRecord = serde_json::from_value(serde_json::json!({
        "version": 1, "operation_id": "o", "binding_id": "b", "fingerprint": "f", "reserved_name": null,
        "pending_upload_id": "one", "phase": { "phase": "staging_v2" },
    }))
    .unwrap();
    assert_eq!(older.pending_upload_ids, ["one"]);
    let empty: save_operations::SaveOperationRecord = serde_json::from_value(serde_json::json!({
        "version": 1, "operation_id": "o", "binding_id": "b", "fingerprint": "f", "reserved_name": null,
        "pending_upload_id": null, "phase": { "phase": "staging_v2" },
    }))
    .unwrap();
    assert!(empty.pending_upload_ids.is_empty());
    let written = serde_json::to_value(&older).unwrap();
    assert_eq!(written["pending_upload_ids"], serde_json::json!(["one"]));
    assert!(written.get("pending_upload_id").is_none());
}
