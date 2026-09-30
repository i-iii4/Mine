//! Download Media: a card's source video becomes a file in the space.
//!
//! The bundled `yt-dlp` reads the video's formats, then downloads an H.264
//! video stream up to 720p and an AAC audio stream as two files; the bundled
//! `video-mux-helper` joins them without re-encoding (Mine ships no ffmpeg).
//! When YouTube offers no separate pair, one progressive MP4 with sound is
//! taken instead. The finished file is published into the space by one atomic
//! mutation (`commands::blocks::attach_downloaded_source_video`) and embedded
//! under the card's heading, as a saved post's video is. Progress,
//! cancellation and failure are reported as
//! `source-video-download` events. See SPEC_MEDIA_ASSET_ACTIONS.md
//! «Download Media».

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::domain::vault::VaultLayout;

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
    /// Reading the video's formats: the length of this step is unknown.
    Preparing,
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
    /// The space the download was started in: its result goes there, even
    /// if another space is open by then (SPEC_AUDIT_FIXES.md, Ф9).
    vault: VaultLayout,
}

/// One download: a card of one space. Cards with the same name in two
/// spaces are two downloads.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct JobKey {
    space: PathBuf,
    slug: String,
}

/// Running and finished downloads, by space and card.
#[derive(Default)]
pub struct SourceVideoDownloads {
    jobs: Mutex<HashMap<JobKey, Arc<Job>>>,
}

/// The open space, as the download will need it at the end.
fn open_space(app: &AppHandle) -> Option<VaultLayout> {
    let state = app.state::<crate::commands::state::AppState>();
    let vault_state = state.vault_state.lock().ok()?;
    vault_state.as_ref().map(|vs| vs.vault.clone())
}

impl SourceVideoDownloads {
    fn job(&self, app: &AppHandle, slug: &str) -> Option<Arc<Job>> {
        let space = open_space(app)?.root().to_path_buf();
        let jobs = self.jobs.lock().ok()?;
        jobs.get(&JobKey { space, slug: slug.to_owned() }).cloned()
    }

    /// The last known state of a card's download in the open space, if one
    /// ran in this session.
    pub fn status(&self, app: &AppHandle, slug: &str) -> Option<DownloadState> {
        let job = self.job(app, slug)?;
        let state = job.state.lock().ok()?;
        Some(state.clone())
    }

    /// Start downloading the card's source video, unless it already is.
    ///
    /// # Errors
    /// The card has no YouTube source, or no space is open.
    pub fn start(&self, app: &AppHandle, slug: String, source_url: &str) -> Result<(), String> {
        let source = mine_core::domain::video_source::parse_youtube_source(source_url)
            .ok_or_else(|| "The card has no supported source video.".to_owned())?;
        let vault = open_space(app).ok_or_else(|| "No space is open.".to_owned())?;
        let key = JobKey {
            space: vault.root().to_path_buf(),
            slug: slug.clone(),
        };
        let job = {
            let mut jobs = self.jobs.lock().map_err(|error| error.to_string())?;
            if let Some(existing) = jobs.get(&key) {
                let running = existing
                    .state
                    .lock()
                    .map(|state| state.is_running())
                    .unwrap_or(false);
                if running {
                    return Ok(());
                }
            }
            let job = Arc::new(Job {
                cancel: AtomicBool::new(false),
                child: Mutex::new(None),
                state: Mutex::new(DownloadState::Preparing),
                vault,
            });
            jobs.insert(key, job.clone());
            job
        };
        emit(app, &job, &slug, DownloadState::Preparing);
        let app = app.clone();
        std::thread::Builder::new()
            .name("source-video-download".into())
            .spawn(move || {
                let outcome = run(&app, &job, &slug, &source.video_id);
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

    /// Stop a running download of a card in the open space; its partial
    /// files are removed.
    pub fn cancel(&self, app: &AppHandle, slug: &str) {
        if let Some(job) = self.job(app, slug) {
            job.stop();
        }
    }
}

impl Job {
    /// Stop the download at whatever step it is: a process that is running
    /// is ended; one about to start is ended as soon as it is registered.
    fn stop(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        let mut slot = match self.child.lock() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(child) = slot.as_mut() {
            let _ = child.kill();
        }
    }

    /// Hand a started process to the job so a cancel can end it. A cancel
    /// that came between the start and this moment found nothing to end; it
    /// is honoured here (SPEC_AUDIT_FIXES.md, А7.5).
    fn register(&self, child: Child) {
        let mut slot = match self.child.lock() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        };
        *slot = Some(child);
        if self.cancel.load(Ordering::SeqCst) {
            if let Some(child) = slot.as_mut() {
                let _ = child.kill();
            }
        }
    }

    /// Wait for the registered process to end.
    fn wait(&self) -> Option<std::io::Result<std::process::ExitStatus>> {
        let child = match self.child.lock() {
            Ok(mut slot) => slot.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        child.map(|mut child| child.wait())
    }
}

impl DownloadState {
    fn is_running(&self) -> bool {
        matches!(self, Self::Preparing | Self::Downloading { .. } | Self::Finishing)
    }
}

/// Record a new state and tell the interface; repeats are not re-sent.
fn report(app: &AppHandle, slug: &str, job: &Job, state: DownloadState) {
    if let Ok(mut current) = job.state.lock() {
        if *current == state {
            return;
        }
        *current = state.clone();
    }
    emit(app, job, slug, state);
}

/// Progress is shown for the open space only: a card of the same name in
/// another space is another card.
fn emit(app: &AppHandle, job: &Job, slug: &str, state: DownloadState) {
    let shown = open_space(app).is_some_and(|open| open.root() == job.vault.root());
    if !shown {
        return;
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

/// A working folder of its own for every download: two cards of one video
/// never share files (SPEC_AUDIT_FIXES.md, А7.1).
fn staging_dir(video_id: &str) -> PathBuf {
    use std::sync::atomic::AtomicU64;
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "mine-source-video-{video_id}-{}-{nonce}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ))
}

fn run(app: &AppHandle, job: &Job, slug: &str, video_id: &str) -> Result<(), String> {
    let tools = Tools {
        ytdlp: bundled_tool(app, "yt-dlp").ok_or("The bundled video downloader is missing.")?,
        joiner: bundled_tool(app, "video-mux-helper").ok_or("The bundled video joiner is missing.")?,
    };
    let staging = Staging(staging_dir(video_id));
    let finished = download_to_file(job, &tools, video_id, &staging.0, |state| report(app, slug, job, state))?;
    if job.cancel.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }
    crate::commands::blocks::attach_downloaded_source_video(app, &job.vault, slug, video_id, &finished)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// A finished download kept for a space whose folder was not reachable when
/// the download ended. It is attached the next time the space opens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeptDownload {
    pub slug: String,
    pub video_id: String,
    pub file: String,
}

fn kept_dir(vault: &VaultLayout) -> PathBuf {
    vault.derived_root().join("source-videos")
}

fn kept_list(vault: &VaultLayout) -> PathBuf {
    kept_dir(vault).join("kept.json")
}

/// The downloads kept for `vault`.
pub fn kept_downloads(vault: &VaultLayout) -> Vec<KeptDownload> {
    std::fs::read(kept_list(vault))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_kept(vault: &VaultLayout, kept: &[KeptDownload]) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(kept).map_err(|error| error.to_string())?;
    crate::storage::files::write_atomically(&kept_list(vault), &bytes).map_err(|error| format!("{error:#}"))
}

/// Keep a finished download in the space's derived store: its folder is not
/// reachable now, and the result must not be lost (Ф9).
pub fn keep_download(vault: &VaultLayout, slug: &str, video_id: &str, finished: &Path) -> Result<(), String> {
    let dir = kept_dir(vault);
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let name = staging_dir(video_id)
        .file_name()
        .map(|name| format!("{}.mp4", name.to_string_lossy()))
        .ok_or("no name for the kept video")?;
    let kept_path = dir.join(&name);
    crate::storage::files::move_exclusive(finished, &kept_path).map_err(|error| format!("{error:#}"))?;
    let mut kept = kept_downloads(vault);
    kept.push(KeptDownload {
        slug: slug.to_owned(),
        video_id: video_id.to_owned(),
        file: name,
    });
    write_kept(vault, &kept)
}

/// Attach the downloads kept for the space that has just opened, in the
/// background. A kept video whose card no longer wants it is discarded.
pub fn adopt_kept_downloads(app: AppHandle, vault: VaultLayout) {
    if kept_downloads(&vault).is_empty() {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("kept-source-videos".into())
        .spawn(move || {
            for kept in kept_downloads(&vault) {
                let path = kept_dir(&vault).join(&kept.file);
                let outcome = crate::commands::blocks::attach_downloaded_source_video(
                    &app,
                    &vault,
                    &kept.slug,
                    &kept.video_id,
                    &path,
                );
                if let Err(error) = &outcome {
                    log::warn!("kept video for {} not attached: {error}", kept.slug);
                }
                // Attached, or no longer wanted by its card: either way it
                // leaves the list. A space that closed meanwhile keeps it.
                if open_space(&app).is_some_and(|open| open.root() == vault.root()) {
                    let _ = std::fs::remove_file(&path);
                    let rest: Vec<KeptDownload> =
                        kept_downloads(&vault).into_iter().filter(|entry| entry != &kept).collect();
                    if let Err(error) = write_kept(&vault, &rest) {
                        log::warn!("kept video list: {error}");
                    }
                }
            }
        });
    if let Err(error) = spawned {
        log::warn!("kept source videos: {error}");
    }
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
    // The join can take a while on a long video: it is a registered process
    // a cancel ends, like the download (А7.5).
    if job.cancel.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }
    let mut joiner = Command::new(&tools.joiner)
        .arg(file_for(0))
        .arg(file_for(1))
        .arg(&joined)
        .arg(seconds.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let mut stderr = joiner.stderr.take();
    job.register(joiner);
    let stderr = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(stderr) = stderr.as_mut() {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });
    let status = job.wait();
    let stderr = stderr.join().unwrap_or_default();
    if job.cancel.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }
    match status {
        Some(Ok(status)) if status.success() => Ok(joined),
        _ => Err(format!("Could not join video and sound: {}", stderr.trim())),
    }
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
    job.register(child);
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
    let status = job.wait();
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

    fn job() -> Job {
        Job {
            cancel: AtomicBool::new(false),
            child: Mutex::new(None),
            state: Mutex::new(DownloadState::Preparing),
            vault: VaultLayout::new(PathBuf::from("/space")),
        }
    }

    #[test]
    fn a_cancel_before_the_process_is_registered_still_ends_it() {
        let job = job();
        job.stop();
        let child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let started = std::time::Instant::now();
        job.register(child);
        let status = job.wait().unwrap().unwrap();
        assert!(!status.success());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn a_cancel_ends_a_registered_process() {
        let job = job();
        job.register(Command::new("/bin/sleep").arg("30").spawn().unwrap());
        job.stop();
        assert!(!job.wait().unwrap().unwrap().success());
    }

    #[test]
    fn every_download_works_in_its_own_folder() {
        assert_ne!(staging_dir("abc"), staging_dir("abc"));
    }

    #[test]
    fn a_kept_download_is_listed_for_its_space() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::with_derived_root(dir.path().join("space"), dir.path().join("derived"));
        let finished = dir.path().join("joined.mp4");
        std::fs::write(&finished, b"video").unwrap();
        keep_download(&vault, "Cards/Film", "9KDDhAOyv9k", &finished).unwrap();
        let kept = kept_downloads(&vault);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].slug, "Cards/Film");
        assert_eq!(std::fs::read(kept_dir(&vault).join(&kept[0].file)).unwrap(), b"video");
        assert!(!finished.exists());
    }

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
        let job = job();
        let staging = tempfile::tempdir().unwrap();
        let mut states = Vec::new();
        // "Me at the zoo": 19 seconds, small in every format.
        let file = download_to_file(&job, &tools, "jNQXAC9IVRw", staging.path(), |state| states.push(state))
            .unwrap_or_else(|error| panic!("download failed: {error}"));
        assert!(file.metadata().unwrap().len() > 100_000, "{}", file.display());
        assert!(states.iter().any(|state| matches!(state, DownloadState::Downloading { percent } if *percent > 0)));
        assert_eq!(states.last(), Some(&DownloadState::Finishing));
        println!("{} bytes at {}; states: {states:?}", file.metadata().unwrap().len(), file.display());
    }

    #[test]
    fn preparing_downloading_and_joining_are_running_states() {
        assert!(DownloadState::Preparing.is_running());
        assert!(DownloadState::Downloading { percent: 3 }.is_running());
        assert!(DownloadState::Finishing.is_running());
        assert!(!DownloadState::Done.is_running());
        assert!(!DownloadState::Cancelled.is_running());
        assert!(!DownloadState::Failed { message: String::new() }.is_running());
        assert_eq!(serde_json::to_value(DownloadState::Preparing).unwrap(), serde_json::json!({ "state": "preparing" }));
    }

    #[test]
    fn explains_the_usual_refusals() {
        assert_eq!(failure_message("WARNING: x\nERROR: unable to download video data: HTTP Error 403: Forbidden\n"), "YouTube refused the download (HTTP 403).");
        assert_eq!(failure_message("ERROR: [youtube] abc: Sign in to confirm you’re not a bot"), "YouTube asked to sign in to confirm this is not a bot.");
        assert_eq!(failure_message("ERROR: Video unavailable"), "Video unavailable");
        assert_eq!(failure_message(""), "The video downloader stopped without a reason.");
    }
}
