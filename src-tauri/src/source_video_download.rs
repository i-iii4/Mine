//! Download Media: a card's source video becomes a file in the space.
//!
//! The bundled `yt-dlp` reads the video's formats, then downloads an H.264
//! video stream up to 720p and an AAC audio stream as two files; the bundled
//! `video-mux-helper` joins them without re-encoding (Mine ships no ffmpeg).
//! When YouTube offers no separate pair, one progressive MP4 with sound is
//! taken instead. The finished file is published into the space by one atomic
//! mutation (`commands::blocks::attach_downloaded_source_video`), and becomes
//! the card's main video. Progress, cancellation and failure are reported as
//! `source-video-download` events. See SPEC_MEDIA_ASSET_ACTIONS.md
//! «Download Media».

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// Event carrying a download's state to the interface.
pub const EVENT: &str = "source-video-download";
/// The tallest picture downloaded. Higher streams cost far more space for a
/// card preview, and 720p H.264 plays everywhere macOS does.
const MAX_HEIGHT: u64 = 720;
/// Prefix of the progress lines this module asks `yt-dlp` to print.
const PROGRESS_PREFIX: &str = "MINE-PROGRESS";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum DownloadState {
    Downloading { percent: u8 },
    Finishing,
    Done,
    Failed { message: String },
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
struct DownloadEvent {
    slug: String,
    #[serde(flatten)]
    state: DownloadState,
}

/// The streams chosen for one video.
#[derive(Debug, Clone, PartialEq)]
pub struct FormatChoice {
    /// Format ids in download order; two ids mean video then audio.
    pub ids: Vec<String>,
    /// Expected bytes per format id, used when a stream does not report its size.
    pub sizes: Vec<(String, u64)>,
}

fn text<'a>(format: &'a serde_json::Value, key: &str) -> &'a str {
    format.get(key).and_then(serde_json::Value::as_str).unwrap_or("")
}

fn number(format: &serde_json::Value, key: &str) -> f64 {
    format.get(key).and_then(serde_json::Value::as_f64).unwrap_or(0.0)
}

fn size_of(format: &serde_json::Value) -> u64 {
    ["filesize", "filesize_approx"]
        .iter()
        .find_map(|key| format.get(*key).and_then(serde_json::Value::as_u64))
        .unwrap_or(0)
}

fn height_of(format: &serde_json::Value) -> u64 {
    format.get("height").and_then(serde_json::Value::as_u64).unwrap_or(0)
}

/// Pick the streams from `yt-dlp -J` output: the tallest H.264 MP4 video up
/// to 720p with the best stereo AAC, or failing that one progressive MP4.
pub fn choose_formats(meta: &serde_json::Value) -> Option<FormatChoice> {
    let formats = meta.get("formats")?.as_array()?;
    let direct = |format: &&serde_json::Value| text(format, "protocol") == "https";
    let video = formats
        .iter()
        .filter(direct)
        .filter(|f| text(f, "vcodec").starts_with("avc1") && text(f, "acodec") == "none" && text(f, "ext") == "mp4")
        .filter(|f| (1..=MAX_HEIGHT).contains(&height_of(f)))
        .max_by(|a, b| {
            (height_of(a), number(a, "fps") as u64, number(a, "tbr") as u64)
                .cmp(&(height_of(b), number(b, "fps") as u64, number(b, "tbr") as u64))
        });
    let audio = formats
        .iter()
        .filter(direct)
        .filter(|f| text(f, "vcodec") == "none" && text(f, "ext") == "m4a" && text(f, "acodec").starts_with("mp4a.40.2"))
        .filter(|f| f.get("audio_channels").and_then(serde_json::Value::as_u64).unwrap_or(2) <= 2)
        .max_by(|a, b| number(a, "abr").total_cmp(&number(b, "abr")));
    if let (Some(video), Some(audio)) = (video, audio) {
        let ids = vec![text(video, "format_id").to_owned(), text(audio, "format_id").to_owned()];
        let sizes = vec![(ids[0].clone(), size_of(video)), (ids[1].clone(), size_of(audio))];
        return Some(FormatChoice { ids, sizes });
    }
    let progressive = formats
        .iter()
        .filter(direct)
        .filter(|f| text(f, "vcodec").starts_with("avc1") && text(f, "acodec").starts_with("mp4a") && text(f, "ext") == "mp4")
        .filter(|f| height_of(f) <= MAX_HEIGHT)
        .max_by_key(|f| height_of(f))?;
    let id = text(progressive, "format_id").to_owned();
    Some(FormatChoice { sizes: vec![(id.clone(), size_of(progressive))], ids: vec![id] })
}

/// One progress line: `MINE-PROGRESS <format_id> <downloaded> <total> <estimate>`.
fn parse_progress(line: &str) -> Option<(String, u64, Option<u64>)> {
    let mut parts = line.strip_prefix(PROGRESS_PREFIX)?.split_whitespace();
    let id = parts.next()?.to_owned();
    let downloaded = parts.next()?.parse::<f64>().ok()? as u64;
    let total = parts.next().and_then(|value| value.parse::<f64>().ok());
    let estimate = parts.next().and_then(|value| value.parse::<f64>().ok());
    Some((id, downloaded, total.or(estimate).map(|value| value as u64)))
}

/// Progress of all streams together, from 0 to 99; 100 belongs to the finished file.
fn overall_percent(choice: &FormatChoice, done: &HashMap<String, (u64, u64)>) -> u8 {
    let mut received = 0u64;
    let mut expected = 0u64;
    for (id, size) in &choice.sizes {
        let (got, total) = done.get(id).copied().unwrap_or((0, *size));
        let total = if total > 0 { total } else { *size };
        received += got.min(total);
        expected += total;
    }
    if expected == 0 {
        return 0;
    }
    ((received * 100 / expected).min(99)) as u8
}

/// A readable reason from `yt-dlp`'s error output.
fn failure_message(stderr: &str) -> String {
    let last_error = stderr
        .lines()
        .rev()
        .find(|line| line.starts_with("ERROR:"))
        .map(|line| line.trim_start_matches("ERROR:").trim().to_owned());
    match last_error {
        Some(error) if error.contains("Sign in to confirm") => {
            "YouTube asked to sign in to confirm this is not a bot.".to_owned()
        }
        Some(error) if error.contains("403") => {
            "YouTube refused the download (HTTP 403).".to_owned()
        }
        Some(error) => error,
        None => "The video downloader stopped without a reason.".to_owned(),
    }
}

struct Job {
    cancel: AtomicBool,
    child: Mutex<Option<Child>>,
    state: Mutex<DownloadState>,
}

/// Running and finished downloads, by card slug.
#[derive(Default)]
pub struct SourceVideoDownloads {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
}

impl SourceVideoDownloads {
    /// The last known state of a card's download, if one ran in this session.
    pub fn status(&self, slug: &str) -> Option<DownloadState> {
        let jobs = self.jobs.lock().ok()?;
        let job = jobs.get(slug)?;
        job.state.lock().ok().map(|state| state.clone())
    }

    /// Start downloading the card's source video, unless it already is.
    ///
    /// # Errors
    /// The card has no YouTube source, or no space is open.
    pub fn start(&self, app: &AppHandle, slug: String, source_url: &str) -> Result<(), String> {
        let source = mine_core::domain::video_source::parse_youtube_source(source_url)
            .ok_or_else(|| "The card has no supported source video.".to_owned())?;
        let vault_root = {
            let state = app.state::<crate::commands::state::AppState>();
            let vault_state = state.vault_state.lock().map_err(|error| error.to_string())?;
            vault_state
                .as_ref()
                .map(|vs| vs.vault.root().to_path_buf())
                .ok_or_else(|| "No space is open.".to_owned())?
        };
        let job = {
            let mut jobs = self.jobs.lock().map_err(|error| error.to_string())?;
            if let Some(existing) = jobs.get(&slug) {
                let running = existing
                    .state
                    .lock()
                    .map(|state| matches!(*state, DownloadState::Downloading { .. } | DownloadState::Finishing))
                    .unwrap_or(false);
                if running {
                    return Ok(());
                }
            }
            let job = Arc::new(Job {
                cancel: AtomicBool::new(false),
                child: Mutex::new(None),
                state: Mutex::new(DownloadState::Downloading { percent: 0 }),
            });
            jobs.insert(slug.clone(), job.clone());
            job
        };
        report(app, &slug, &job, DownloadState::Downloading { percent: 0 });
        let app = app.clone();
        std::thread::Builder::new()
            .name("source-video-download".into())
            .spawn(move || {
                let outcome = run(&app, &job, &slug, &source.video_id, &vault_root);
                let state = match outcome {
                    _ if job.cancel.load(Ordering::SeqCst) => DownloadState::Cancelled,
                    Ok(()) => DownloadState::Done,
                    Err(message) => DownloadState::Failed { message },
                };
                report(&app, &slug, &job, state);
            })
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// Stop a running download; its partial files are removed.
    pub fn cancel(&self, slug: &str) {
        let Some(job) = self.jobs.lock().ok().and_then(|jobs| jobs.get(slug).cloned()) else {
            return;
        };
        job.cancel.store(true, Ordering::SeqCst);
        let mut slot = match job.child.lock() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(child) = slot.as_mut() {
            let _ = child.kill();
        }
    }
}

fn report(app: &AppHandle, slug: &str, job: &Job, state: DownloadState) {
    if let Ok(mut current) = job.state.lock() {
        if *current == state {
            return;
        }
        *current = state.clone();
    }
    if let Err(error) = app.emit(EVENT, DownloadEvent { slug: slug.to_owned(), state }) {
        log::warn!("source video download event: {error}");
    }
}

/// Removes the working directory whatever happens.
struct Staging(PathBuf);

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run(app: &AppHandle, job: &Job, slug: &str, video_id: &str, vault_root: &Path) -> Result<(), String> {
    let tools = Tools {
        ytdlp: bundled_tool(app, "yt-dlp").ok_or("The bundled video downloader is missing.")?,
        joiner: bundled_tool(app, "video-mux-helper").ok_or("The bundled video joiner is missing.")?,
    };
    let staging = Staging(std::env::temp_dir().join(format!(
        "mine-source-video-{video_id}-{}",
        std::process::id()
    )));
    let finished = download_to_file(job, &tools, video_id, &staging.0, |state| report(app, slug, job, state))?;
    if job.cancel.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }
    crate::commands::blocks::attach_downloaded_source_video(app, vault_root, slug, video_id, &finished)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// The downloader and the joiner, wherever they were found.
struct Tools {
    ytdlp: PathBuf,
    joiner: PathBuf,
}

/// Download the video into `staging` and return the finished MP4 there.
fn download_to_file(
    job: &Job,
    tools: &Tools,
    video_id: &str,
    staging: &Path,
    mut on_state: impl FnMut(DownloadState),
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(staging).map_err(|error| error.to_string())?;
    let watch_url = format!("https://www.youtube.com/watch?v={video_id}");

    let meta = run_ytdlp(job, &tools.ytdlp, &["-J", "--no-playlist", &watch_url], |_| {})?;
    let meta: serde_json::Value =
        serde_json::from_str(&meta).map_err(|error| format!("Unreadable video details: {error}"))?;
    let choice = choose_formats(&meta).ok_or("YouTube offers no MP4 stream for this video.")?;

    let template = format!("{}/%(format_id)s.%(ext)s", staging.display());
    let progress_template = format!(
        "download:{PROGRESS_PREFIX} %(info.format_id)s %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s"
    );
    let selection = choice.ids.join(",");
    let mut received: HashMap<String, (u64, u64)> = HashMap::new();
    run_ytdlp(
        job,
        &tools.ytdlp,
        &[
            "--no-playlist", "--no-mtime", "--no-part", "--newline",
            "-f", &selection, "-o", &template,
            "--progress-template", &progress_template,
            &watch_url,
        ],
        |line| {
            if let Some((id, got, total)) = parse_progress(line) {
                received.insert(id, (got, total.unwrap_or(0)));
                on_state(DownloadState::Downloading { percent: overall_percent(&choice, &received) });
            }
        },
    )?;

    // The format filters guarantee these extensions: MP4 video, M4A audio.
    let file_for = |index: usize| {
        let extension = if choice.ids.len() == 2 && index == 1 { "m4a" } else { "mp4" };
        staging.join(format!("{}.{extension}", choice.ids[index]))
    };
    if choice.ids.len() == 1 {
        return Ok(file_for(0));
    }
    on_state(DownloadState::Finishing);
    let joined = staging.join("joined.mp4");
    // The real length comes from the source: AVFoundation doubles it for
    // YouTube's fragmented files.
    let seconds = meta
        .get("duration")
        .and_then(serde_json::Value::as_f64)
        .filter(|seconds| *seconds > 0.0)
        .ok_or("YouTube did not report the video's length.")?;
    let output = Command::new(&tools.joiner)
        .arg(file_for(0))
        .arg(file_for(1))
        .arg(&joined)
        .arg(seconds.to_string())
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Could not join video and sound: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(joined)
}

/// Run `yt-dlp`, feeding stdout lines to `on_line`; returns all of stdout.
fn run_ytdlp(job: &Job, ytdlp: &Path, args: &[&str], mut on_line: impl FnMut(&str)) -> Result<String, String> {
    if job.cancel.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }
    let mut child = Command::new(ytdlp)
        .args(args)
        .env("PATH", tool_search_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start the video downloader: {error}"))?;
    let stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    if let Ok(mut slot) = job.child.lock() {
        *slot = Some(child);
    }
    let stderr_reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(stderr) = stderr.as_mut() {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });
    let mut collected = String::new();
    if let Some(stdout) = stdout {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            on_line(&line);
            collected.push_str(&line);
            collected.push('\n');
        }
    }
    let status = job
        .child
        .lock()
        .ok()
        .and_then(|mut slot| slot.take())
        .map(|mut child| child.wait());
    let stderr = stderr_reader.join().unwrap_or_default();
    if job.cancel.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }
    match status {
        Some(Ok(status)) if status.success() => Ok(collected),
        _ => Err(failure_message(&stderr)),
    }
}

/// `yt-dlp` solves YouTube's player challenges with Deno when one is
/// installed; the app's own PATH is minimal, so the usual places are added.
fn tool_search_path() -> String {
    let mut dirs = vec!["/opt/homebrew/bin".to_owned(), "/usr/local/bin".to_owned()];
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(format!("{home}/.deno/bin"));
    }
    dirs.push(std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()));
    dirs.join(":")
}

/// A binary shipped in the bundle's `binaries/`, or in the source tree during development.
fn bundled_tool(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("binaries").join(name));
        candidates.push(resources.join(name));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join(name));
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Formats as `yt-dlp -J` listed them for a YouTube video on 27.09.2026.
    fn meta() -> serde_json::Value {
        json!({ "formats": [
            { "format_id": "139", "ext": "m4a", "vcodec": "none", "acodec": "mp4a.40.5", "abr": 48.8, "protocol": "https", "filesize": 3_871_021 },
            { "format_id": "140", "ext": "m4a", "vcodec": "none", "acodec": "mp4a.40.2", "abr": 129.5, "audio_channels": 2, "protocol": "https", "filesize": 10_271_496 },
            { "format_id": "258", "ext": "m4a", "vcodec": "none", "acodec": "mp4a.40.2", "abr": 387.9, "audio_channels": 6, "protocol": "https", "filesize": 30_767_611 },
            { "format_id": "134", "ext": "mp4", "vcodec": "avc1.4d401e", "acodec": "none", "height": 360, "fps": 30, "protocol": "https", "filesize": 18_294_110 },
            { "format_id": "18", "ext": "mp4", "vcodec": "avc1.42001E", "acodec": "mp4a.40.2", "height": 360, "protocol": "https", "filesize_approx": 28_526_904 },
            { "format_id": "298", "ext": "mp4", "vcodec": "avc1.4d4020", "acodec": "none", "height": 720, "fps": 60, "protocol": "https", "filesize": 150_524_867 },
            { "format_id": "136", "ext": "mp4", "vcodec": "avc1.4d401f", "acodec": "none", "height": 720, "fps": 30, "protocol": "https", "filesize": 33_500_000 },
            { "format_id": "299", "ext": "mp4", "vcodec": "avc1.64002a", "acodec": "none", "height": 1080, "fps": 60, "protocol": "https", "filesize": 257_619_653 },
            { "format_id": "303", "ext": "webm", "vcodec": "vp9", "acodec": "none", "height": 1080, "protocol": "https" },
            { "format_id": "hls-720", "ext": "mp4", "vcodec": "avc1.4d401f", "acodec": "none", "height": 720, "fps": 60, "protocol": "m3u8_native" }
        ]})
    }

    #[test]
    fn picks_the_tallest_h264_up_to_720p_and_stereo_aac() {
        let choice = choose_formats(&meta()).expect("formats");
        assert_eq!(choice.ids, vec!["298", "140"]);
        assert_eq!(choice.sizes, vec![("298".into(), 150_524_867), ("140".into(), 10_271_496)]);
    }

    #[test]
    fn falls_back_to_one_progressive_mp4_without_a_separate_pair() {
        let mut meta = meta();
        meta["formats"].as_array_mut().unwrap().retain(|f| f["format_id"] != "140" && f["format_id"] != "258");
        let choice = choose_formats(&meta).expect("formats");
        assert_eq!(choice.ids, vec!["18"]);
        assert_eq!(choice.sizes, vec![("18".into(), 28_526_904)]);
    }

    #[test]
    fn refuses_a_video_without_any_mp4_stream() {
        let meta = json!({ "formats": [{ "format_id": "303", "ext": "webm", "vcodec": "vp9", "acodec": "none", "height": 1080, "protocol": "https" }] });
        assert_eq!(choose_formats(&meta), None);
    }

    #[test]
    fn reads_progress_lines_with_missing_totals() {
        assert_eq!(parse_progress("MINE-PROGRESS 298 1024 2048 NA"), Some(("298".into(), 1024, Some(2048))));
        assert_eq!(parse_progress("MINE-PROGRESS 140 512 NA 1000.5"), Some(("140".into(), 512, Some(1000))));
        assert_eq!(parse_progress("MINE-PROGRESS 140 512 NA NA"), Some(("140".into(), 512, None)));
        assert_eq!(parse_progress("[download] 12.3% of 10MiB"), None);
    }

    #[test]
    fn overall_progress_weighs_streams_by_size_and_stops_short_of_done() {
        let choice = FormatChoice {
            ids: vec!["v".into(), "a".into()],
            sizes: vec![("v".into(), 900), ("a".into(), 100)],
        };
        let mut received = HashMap::new();
        assert_eq!(overall_percent(&choice, &received), 0);
        received.insert("v".into(), (450, 900));
        assert_eq!(overall_percent(&choice, &received), 45);
        received.insert("v".into(), (900, 900));
        received.insert("a".into(), (100, 0));
        assert_eq!(overall_percent(&choice, &received), 99);
    }

    /// Real YouTube, real binaries from `binaries/`: run by hand with
    /// `cargo test -p mine --lib real_youtube -- --ignored`.
    #[test]
    #[ignore = "downloads from YouTube"]
    fn real_youtube_download_produces_one_playable_mp4() {
        let binaries = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let tools = Tools { ytdlp: binaries.join("yt-dlp"), joiner: binaries.join("video-mux-helper") };
        let job = Job {
            cancel: AtomicBool::new(false),
            child: Mutex::new(None),
            state: Mutex::new(DownloadState::Downloading { percent: 0 }),
        };
        let staging = tempfile::tempdir().unwrap();
        let mut states = Vec::new();
        // "Me at the zoo": 19 seconds, small in every format.
        let file = download_to_file(&job, &tools, "jNQXAC9IVRw", staging.path(), |state| states.push(state))
            .unwrap_or_else(|error| panic!("download failed: {error}"));
        assert!(file.metadata().unwrap().len() > 100_000, "{}", file.display());
        assert!(states.iter().any(|state| matches!(state, DownloadState::Downloading { percent } if *percent > 0)));
        println!("{} bytes at {}; states: {states:?}", file.metadata().unwrap().len(), file.display());
    }

    #[test]
    fn explains_the_usual_refusals() {
        assert_eq!(failure_message("WARNING: x\nERROR: unable to download video data: HTTP Error 403: Forbidden\n"), "YouTube refused the download (HTTP 403).");
        assert_eq!(failure_message("ERROR: [youtube] abc: Sign in to confirm you’re not a bot"), "YouTube asked to sign in to confirm this is not a bot.");
        assert_eq!(failure_message("ERROR: Video unavailable"), "Video unavailable");
        assert_eq!(failure_message(""), "The video downloader stopped without a reason.");
    }
}
