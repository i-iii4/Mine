#[cfg(feature = "desktop")]
use std::borrow::Cow;
#[cfg(feature = "desktop")]
use std::fs::File;
#[cfg(feature = "desktop")]
use std::io::{Read, Seek, SeekFrom};
#[cfg(feature = "desktop")]
use std::path::{Path, PathBuf};

#[cfg(feature = "desktop")]
use http_range::HttpRange;
#[cfg(feature = "desktop")]
use percent_encoding::percent_decode_str;
#[cfg(feature = "desktop")]
use tauri::http::{header::*, Method, Request, Response, StatusCode};
#[cfg(feature = "desktop")]
use tauri::{Manager, Runtime};
#[cfg(feature = "desktop")]
use unicode_normalization::UnicodeNormalization;

#[cfg(feature = "desktop")]
const MAX_RANGE_LEN: u64 = 1000 * 1024;

#[cfg(feature = "desktop")]
pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol("asset", |ctx, request, responder| {
        let app = ctx.app_handle().clone();
        let app_for_respond = app.clone();
        tauri::async_runtime::spawn(async move {
            let response =
                tauri::async_runtime::spawn_blocking(move || build_asset_response(&app, request))
                    .await
                    .unwrap_or_else(|err| {
                        log::error!("asset protocol task join failed: {}", err);
                        Response::builder()
                            .status(StatusCode::INTERNAL_SERVER_ERROR)
                            .body(Vec::<u8>::new().into())
                            .expect("failed to build asset protocol join-error response")
                    });
            // The respond MUST run on the main thread. WKURLSchemeTask is
            // main-thread state: wry validates the task and then walks
            // didReceiveResponse/didReceiveData/didFinish as one straight-line
            // block, while WebKit delivers task cancellation (a scrolled-away
            // <img>, a navigation) on the main thread. Responding from a tokio
            // worker lets a cancellation land between wry's validity check and
            // the ObjC calls; the resulting NSException surfaces as a Rust
            // panic inside an extern "C" frame, which cannot unwind — an
            // instant SIGABRT of the whole app (tauri#12338; four crashes on
            // 10.08.2026, identical stacks). On the main thread the respond
            // block and the cancellation serialize, so the race cannot exist.
            if let Err(err) =
                app_for_respond.run_on_main_thread(move || responder.respond(response))
            {
                log::error!("asset protocol respond dispatch failed: {}", err);
            }
        });
    })
}

#[cfg(feature = "desktop")]
fn build_asset_response<R: Runtime>(
    app: &tauri::AppHandle<R>,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    let mut resp = Response::builder().header("Access-Control-Allow-Origin", "*");

    let Some(path) = decode_request_path(&request) else {
        return empty_response(resp.status(StatusCode::BAD_REQUEST));
    };

    if !app.asset_protocol_scope().is_allowed(&path) {
        log::error!(
            "asset protocol not configured to allow path: {}",
            path.display()
        );
        return empty_response(resp.status(StatusCode::FORBIDDEN));
    }

    let Ok(meta) = std::fs::metadata(&path) else {
        log::error!("asset path missing: {}", path.display());
        return empty_response(resp.status(StatusCode::NOT_FOUND));
    };

    let len = meta.len();
    let mime_type = mime_type_for_file(&path);
    resp = resp.header(CONTENT_TYPE, mime_type);

    if request.method() == Method::HEAD {
        return empty_response(resp.header(CONTENT_LENGTH, len));
    }

    if let Some(range_header) = request.headers().get(RANGE).and_then(|r| r.to_str().ok()) {
        return build_range_response(resp, &path, len, mime_type, range_header);
    }

    match std::fs::read(&path) {
        Ok(buf) => response_with_body(resp.header(CONTENT_LENGTH, buf.len()), buf),
        Err(err) => {
            log::error!("asset read failed path={} err={}", path.display(), err);
            empty_response(resp.status(StatusCode::INTERNAL_SERVER_ERROR))
        }
    }
}

#[cfg(feature = "desktop")]
fn decode_request_path(request: &Request<Vec<u8>>) -> Option<PathBuf> {
    let path = request.uri().path().strip_prefix('/')?;
    let decoded: String = percent_decode_str(path).decode_utf8_lossy().into_owned();
    let normalized: String = decoded.nfc().collect();
    Some(PathBuf::from(normalized))
}

#[cfg(feature = "desktop")]
fn build_range_response(
    mut resp: tauri::http::response::Builder,
    path: &Path,
    len: u64,
    mime_type: &'static str,
    range_header: &str,
) -> Response<Cow<'static, [u8]>> {
    resp = resp
        .header(ACCEPT_RANGES, "bytes")
        .header(ACCESS_CONTROL_EXPOSE_HEADERS, "content-range");

    let Ok(ranges) = HttpRange::parse(range_header, len) else {
        return response_with_body(
            Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(CONTENT_RANGE, format!("bytes */{len}")),
            Vec::<u8>::new(),
        );
    };

    let ranges = ranges
        .iter()
        .filter_map(|r| {
            let start = r.start;
            let mut end = r.start + r.length - 1;
            if start >= len || end >= len || end < start {
                None
            } else {
                end = start + (end - start).min(len - start).min(MAX_RANGE_LEN - 1);
                Some((start, end))
            }
        })
        .collect::<Vec<_>>();

    if ranges.is_empty() {
        return response_with_body(
            Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(CONTENT_RANGE, format!("bytes */{len}")),
            Vec::<u8>::new(),
        );
    }

    if ranges.len() == 1 {
        let (start, end) = ranges[0];
        let nbytes = end + 1 - start;
        match read_file_range(path, start, nbytes) {
            Ok(buf) => response_with_body(
                resp.status(StatusCode::PARTIAL_CONTENT)
                    .header(CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                    .header(CONTENT_LENGTH, nbytes),
                buf,
            ),
            Err(err) => {
                log::error!(
                    "asset range read failed path={} err={}",
                    path.display(),
                    err
                );
                empty_response(resp.status(StatusCode::INTERNAL_SERVER_ERROR))
            }
        }
    } else {
        let boundary = multipart_boundary();
        let boundary_sep = format!("\r\n--{boundary}\r\n");
        let boundary_closer = format!("\r\n--{boundary}--\r\n");
        let mut multipart = Vec::new();

        for (start, end) in ranges {
            let nbytes = end + 1 - start;
            let Ok(buf) = read_file_range(path, start, nbytes) else {
                return empty_response(resp.status(StatusCode::INTERNAL_SERVER_ERROR));
            };
            multipart.extend_from_slice(boundary_sep.as_bytes());
            multipart.extend_from_slice(format!("{CONTENT_TYPE}: {mime_type}\r\n").as_bytes());
            multipart.extend_from_slice(
                format!("{CONTENT_RANGE}: bytes {start}-{end}/{len}\r\n\r\n").as_bytes(),
            );
            multipart.extend_from_slice(&buf);
        }
        multipart.extend_from_slice(boundary_closer.as_bytes());

        response_with_body(
            resp.status(StatusCode::PARTIAL_CONTENT)
                .header(
                    CONTENT_TYPE,
                    format!("multipart/byteranges; boundary={boundary}"),
                )
                .header(CONTENT_LENGTH, multipart.len()),
            multipart,
        )
    }
}

#[cfg(feature = "desktop")]
fn read_file_range(path: &Path, start: u64, len: u64) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut take = file.take(len);
    let mut buf = Vec::with_capacity(len as usize);
    take.read_to_end(&mut buf)?;
    Ok(buf)
}

#[cfg(feature = "desktop")]
fn response_with_body<T: Into<Cow<'static, [u8]>>>(
    builder: tauri::http::response::Builder,
    body: T,
) -> Response<Cow<'static, [u8]>> {
    builder.body(body.into()).unwrap_or_else(|_| {
        Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Vec::<u8>::new().into())
            .expect("failed to build fallback response")
    })
}

#[cfg(feature = "desktop")]
fn empty_response(builder: tauri::http::response::Builder) -> Response<Cow<'static, [u8]>> {
    response_with_body(builder, Vec::<u8>::new())
}

#[cfg(feature = "desktop")]
fn multipart_boundary() -> String {
    format!(
        "mine-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    )
}

#[cfg(feature = "desktop")]
fn mime_type_for_file(path: &Path) -> &'static str {
    if should_sniff_image_content(path) {
        if let Some(mime) = mime_type_from_magic(path) {
            return mime;
        }
    }
    mime_type_for_path(path)
}

#[cfg(feature = "desktop")]
fn should_sniff_image_content(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(str::to_lowercase)
            .as_deref(),
        Some("jpg" | "jpeg" | "png" | "gif" | "webp" | "avif" | "heic" | "heif")
    )
}

#[cfg(feature = "desktop")]
fn mime_type_from_magic(path: &Path) -> Option<&'static str> {
    let mut file = File::open(path).ok()?;
    let mut buf = [0u8; 16];
    let n = file.read(&mut buf).ok()?;
    let bytes = &buf[..n];

    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let brand = &bytes[8..12];
        if matches!(brand, b"avif" | b"avis") {
            return Some("image/avif");
        }
        if matches!(
            brand,
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1"
        ) {
            return Some("image/heic");
        }
    }

    None
}

#[cfg(feature = "desktop")]
fn mime_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        Some("avif") => "image/avif",
        Some("heic" | "heif") => "image/heic",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("m4v") => "video/x-m4v",
        Some("md" | "txt") => "text/plain; charset=utf-8",
        Some("json") => "application/json",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

#[cfg(all(test, feature = "desktop"))]
mod tests {
    use super::*;

    #[test]
    fn mime_type_sniffs_png_saved_under_jpg_extension() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("text-thumb.jpg");
        std::fs::write(
            &path,
            [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0],
        )
        .unwrap();

        assert_eq!(mime_type_for_file(&path), "image/png");
    }

    #[test]
    fn mime_type_sniffs_jpeg_saved_under_png_extension() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("photo.png");
        std::fs::write(&path, [0xFF, 0xD8, 0xFF, 0x00]).unwrap();

        assert_eq!(mime_type_for_file(&path), "image/jpeg");
    }

    #[test]
    fn mime_type_falls_back_to_extension_when_magic_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("maybe.jpg");
        std::fs::write(&path, b"not enough image magic").unwrap();

        assert_eq!(mime_type_for_file(&path), "image/jpeg");
    }
}
