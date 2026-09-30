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
//! `source-video-download` events. See `SPEC_MEDIA_ASSET_ACTIONS.md`
//! «Download Media».

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::blocks::{MediaAssetActionError, MediaAssetMutationResult};
use crate::domain::vault::VaultLayout;

/// Event carrying a download's state to the interface.
pub const EVENT: &str = "source-video-download";
/// The tallest picture downloaded. Higher streams cost far more space for a
/// card preview, and 720p H.264 plays everywhere macOS does.
const MAX_HEIGHT: u64 = 720;
/// Prefix of the progress lines this module asks `yt-dlp` to print.
const PROGRESS_PREFIX: &str = "MINE-PROGRESS";
/// How often a job looks whether its process has ended: short enough that a
/// cancel feels immediate.
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(50);

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
    /// The running process, kept here until it has ended so a cancel can
    /// reach it at any moment (`SPEC_AUDIT_FIXES.md`, Б3.3).
    child: Mutex<Option<Child>>,
    state: Mutex<DownloadState>,
    /// The space the download was started in: its result goes there, even
    /// if another space is open by then (`SPEC_AUDIT_FIXES.md`, Ф9).
    vault: VaultLayout,
}

/// Whether two layouts are one space: the same folder holding the same
/// identity, which names the space's derived store. A space placed at the
/// folder of another one is another space (`SPEC_AUDIT_FIXES.md`, Ф9, Б3.4).
pub(crate) fn same_space(a: &VaultLayout, b: &VaultLayout) -> bool {
    a.root() == b.root() && a.derived_root() == b.derived_root()
}

/// One download: a card of one space. Cards with the same name in two
/// spaces are two downloads, including two spaces that used one folder one
/// after the other.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct JobKey {
    space: PathBuf,
    identity: PathBuf,
    slug: String,
}

impl JobKey {
    fn new(vault: &VaultLayout, slug: &str) -> Self {
        Self {
            space: vault.root().to_path_buf(),
            identity: vault.derived_root().to_path_buf(),
            slug: slug.to_owned(),
        }
    }
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
        let key = JobKey::new(&open_space(app)?, slug);
        let jobs = self.jobs.lock().ok()?;
        jobs.get(&key).cloned()
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
        let key = JobKey::new(&vault, &slug);
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

/// Run a download tool as the leader of a process group of its own, with the
/// job's working folder `temp` as its temporary folder (see `kill_group`).
fn spawn_tool(command: &mut Command, temp: &Path) -> std::io::Result<Child> {
    command.env("TMPDIR", temp).process_group(0).spawn()
}

/// Kill the process group `child` leads.
///
/// What this guarantees, checked against the bundled `yt-dlp` on 30.09.2026:
/// it is a `PyInstaller` one-file build, a launcher that unpacks Python (about
/// 70 MB) into `TMPDIR` and runs it as a second process sharing the
/// launcher's stdout and stderr. Killing the launcher alone leaves that
/// second process downloading with the pipes open, so the reads of this
/// module do not end, and leaves the unpacked copy behind. Every tool here
/// is started by `spawn_tool`, so the signal reaches the whole group (the
/// launcher, the Python process and whatever that one starts) and the
/// unpacked copy lies in the job's working folder, which `Staging` removes.
/// A process that leaves the group on its own (`setsid`) is out of reach;
/// neither `yt-dlp` nor the joiner does that.
fn kill_group(child: &Child) {
    let Ok(group) = libc::pid_t::try_from(child.id()) else {
        return;
    };
    // SAFETY: `killpg` takes plain integers and touches no memory. The child
    // is not reaped while it is in the job's slot, so its id, which is also
    // its group's id, cannot belong to any other process.
    let reached_group = unsafe { libc::killpg(group, libc::SIGKILL) } == 0;
    if !reached_group {
        // SAFETY: as above. A child started without a group of its own is
        // killed alone.
        unsafe {
            libc::kill(group, libc::SIGKILL);
        }
    }
}

fn lock_slot(slot: &Mutex<Option<Child>>) -> MutexGuard<'_, Option<Child>> {
    slot.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Job {
    /// Stop the download at whatever step it is: a process that is running
    /// is ended; one about to start is ended as soon as it is registered.
    fn stop(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Some(child) = lock_slot(&self.child).as_ref() {
            kill_group(child);
        }
    }

    /// Hand a started process to the job so a cancel can end it. A cancel
    /// that came between the start and this moment found nothing to end; it
    /// is honoured here (`SPEC_AUDIT_FIXES.md`, А7.5).
    fn register(&self, child: Child) {
        let mut slot = lock_slot(&self.child);
        *slot = Some(child);
        if self.cancel.load(Ordering::SeqCst) {
            if let Some(child) = slot.as_ref() {
                kill_group(child);
            }
        }
    }

    /// Wait for the registered process to end. The process stays in the slot
    /// the whole time, so `stop` reaches it while this waits
    /// (`SPEC_AUDIT_FIXES.md`, Б3.3).
    fn wait(&self) -> Option<std::io::Result<ExitStatus>> {
        loop {
            {
                let mut slot = lock_slot(&self.child);
                let child = slot.as_mut()?;
                match child.try_wait() {
                    Ok(None) => {}
                    ended => {
                        *slot = None;
                        return ended.transpose();
                    }
                }
            }
            std::thread::sleep(PROCESS_POLL_INTERVAL);
        }
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
    let shown = open_space(app).is_some_and(|open| same_space(&open, &job.vault));
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
/// never share files (`SPEC_AUDIT_FIXES.md`, А7.1).
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

/// Every change of a kept list is read, changed and written back under this
/// lock: download jobs and the adoption of kept downloads run on threads of
/// their own, and without it one writer drops what another has just added
/// (`SPEC_AUDIT_FIXES.md`, Б3.2). One lock for all spaces: changes are rare
/// and short.
static KEPT_LIST: Mutex<()> = Mutex::new(());

/// One adoption at a time: a space opened twice in quick succession must not
/// attach one kept video twice.
static ADOPTION: Mutex<()> = Mutex::new(());

/// The kept list as stored. A missing list is an empty one; an unreadable
/// one is an error, so no change is written over records it may still hold.
fn read_kept(vault: &VaultLayout) -> Result<Vec<KeptDownload>, String> {
    let path = kept_list(vault);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("kept video list {} is unreadable: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("kept video list {}: {error}", path.display())),
    }
}

/// The downloads kept for `vault`; none when the list cannot be read.
pub fn kept_downloads(vault: &VaultLayout) -> Vec<KeptDownload> {
    read_kept(vault).unwrap_or_else(|error| {
        log::warn!("{error}");
        Vec::new()
    })
}

/// Apply `change` to the kept list of `vault` as one step (see `KEPT_LIST`).
fn change_kept(vault: &VaultLayout, change: impl FnOnce(&mut Vec<KeptDownload>)) -> Result<(), String> {
    let _list = KEPT_LIST.lock().unwrap_or_else(PoisonError::into_inner);
    let mut kept = read_kept(vault)?;
    change(&mut kept);
    let bytes = serde_json::to_vec_pretty(&kept).map_err(|error| error.to_string())?;
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
    let record = KeptDownload {
        slug: slug.to_owned(),
        video_id: video_id.to_owned(),
        file: name,
    };
    if let Err(error) = change_kept(vault, |kept| kept.push(record)) {
        // A video without its record would stay in the store for good, and
        // nothing would ever attach it: the download reports the failure.
        if let Err(removal) = std::fs::remove_file(&kept_path) {
            log::warn!("unlisted kept video {}: {removal}", kept_path.display());
        }
        return Err(error);
    }
    Ok(())
}

/// Take a kept download off the list of `vault`.
fn forget_kept(vault: &VaultLayout, kept: &KeptDownload) -> Result<(), String> {
    change_kept(vault, |list| list.retain(|entry| entry != kept))
}

/// What one attempt to attach a kept download means for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeptFate {
    /// Attached, kept again under a new record, or refused for good: the
    /// video and its record go.
    Settled,
    /// A transient failure: the video and its record stay for the next
    /// time the space opens.
    Retry,
}

/// What attaching a downloaded video to its card came to.
type AttachOutcome = Result<MediaAssetMutationResult, MediaAssetActionError>;

fn kept_fate(outcome: &AttachOutcome) -> KeptFate {
    match outcome {
        // Attached, or for a space that closed meanwhile moved to a record
        // of its own; or the card is gone, links another clip or has its own
        // video now, an answer no later attempt changes.
        Ok(_) | Err(MediaAssetActionError::InvalidMediaRef { .. }) => KeptFate::Settled,
        // A busy index, a card edited in Obsidian between the read and the
        // write, an unreadable folder: all pass (SPEC_AUDIT_FIXES.md, Б3.1).
        Err(_) => KeptFate::Retry,
    }
}

/// Act on the outcome of attaching `kept` to its card in `vault`.
pub(crate) fn settle_kept_download(vault: &VaultLayout, kept: &KeptDownload, outcome: &AttachOutcome) {
    if let Err(error) = outcome {
        log::warn!("kept video for {} not attached: {error}", kept.slug);
    }
    if kept_fate(outcome) == KeptFate::Retry {
        return;
    }
    let path = kept_dir(vault).join(&kept.file);
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        // Attaching moved it into the space.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!("kept video {}: {error}", path.display()),
    }
    if let Err(error) = forget_kept(vault, kept) {
        log::warn!("kept video list: {error}");
    }
}

/// Attach the downloads kept for the space that has just opened, in the
/// background. A kept video whose card no longer wants it is discarded; one
/// that failed for a passing reason waits for the next opening.
pub fn adopt_kept_downloads(app: AppHandle, vault: VaultLayout) {
    if kept_downloads(&vault).is_empty() {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("kept-source-videos".into())
        .spawn(move || {
            let _adopting = ADOPTION.lock().unwrap_or_else(PoisonError::into_inner);
            for kept in kept_downloads(&vault) {
                let path = kept_dir(&vault).join(&kept.file);
                if !path.is_file() {
                    // Attached by an earlier adoption, or lost: nothing to attach.
                    if let Err(error) = forget_kept(&vault, &kept) {
                        log::warn!("kept video list: {error}");
                    }
                    continue;
                }
                let outcome = crate::commands::blocks::attach_downloaded_source_video(
                    &app,
                    &vault,
                    &kept.slug,
                    &kept.video_id,
                    &path,
                );
                settle_kept_download(&vault, &kept, &outcome);
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
    mut on_state: impl FnMut(DownloadState) + Send,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(staging).map_err(|error| error.to_string())?;
    let watch_url = format!("https://www.youtube.com/watch?v={video_id}");

    let meta = run_ytdlp(job, &tools.ytdlp, staging, &["-J", "--no-playlist", &watch_url], |_| {})?;
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
        staging,
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
    join_streams(job, &tools.joiner, staging, &[file_for(0), file_for(1)], &joined, seconds)
}

/// Join the video and audio files into `output` with the `helper`. A long
/// video takes a while: the helper is a registered process a cancel ends at
/// any moment, like the download (`SPEC_AUDIT_FIXES.md`, А7.5, Б3.3).
fn join_streams(
    job: &Job,
    helper: &Path,
    temp: &Path,
    streams: &[PathBuf],
    output: &Path,
    seconds: f64,
) -> Result<PathBuf, String> {
    if job.cancel.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }
    let mut process = spawn_tool(
        Command::new(helper)
            .args(streams)
            .arg(output)
            .arg(seconds.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped()),
        temp,
    )
    .map_err(|error| error.to_string())?;
    let stderr = process.stderr.take();
    job.register(process);
    let (status, stderr) = std::thread::scope(|scope| {
        let stderr = scope.spawn(move || read_all(stderr));
        let status = job.wait();
        (status, stderr.join().unwrap_or_default())
    });
    if job.cancel.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }
    match status {
        Some(Ok(status)) if status.success() => Ok(output.to_path_buf()),
        _ => Err(format!("Could not join video and sound: {}", stderr.trim())),
    }
}

/// Everything a process writes to one of its pipes, as text.
fn read_all(stream: Option<impl Read>) -> String {
    let mut text = String::new();
    if let Some(mut stream) = stream {
        if let Err(error) = stream.read_to_string(&mut text) {
            log::warn!("reading a video tool's output: {error}");
        }
    }
    text
}

/// Run `yt-dlp`, feeding stdout lines to `on_line`; returns all of stdout.
///
/// The output is read on threads of their own while this thread waits for
/// the process, so a cancel ends the wait at once; the kill reaches every
/// process that holds the pipes open (see `kill_group`), so the reads end
/// too. `temp` is the job's working folder.
fn run_ytdlp(
    job: &Job,
    ytdlp: &Path,
    temp: &Path,
    args: &[&str],
    mut on_line: impl FnMut(&str) + Send,
) -> Result<String, String> {
    if job.cancel.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }
    let mut child = spawn_tool(
        Command::new(ytdlp)
            .args(args)
            .env("PATH", tool_search_path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
        temp,
    )
    .map_err(|error| format!("Could not start the video downloader: {error}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    job.register(child);
    let (status, collected, stderr) = std::thread::scope(|scope| {
        let stderr = scope.spawn(move || read_all(stderr));
        let stdout = scope.spawn(|| {
            let mut collected = String::new();
            if let Some(stdout) = stdout {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    on_line(&line);
                    collected.push_str(&line);
                    collected.push('\n');
                }
            }
            collected
        });
        let status = job.wait();
        (status, stdout.join().unwrap_or_default(), stderr.join().unwrap_or_default())
    });
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

    /// A cancel must end the job's wait well before a 30 second process would.
    const CANCEL_DEADLINE: Duration = Duration::from_secs(5);
    /// Long enough for the waiting thread to be inside `wait`.
    const WAITING: Duration = Duration::from_millis(300);

    fn sleeper() -> Child {
        spawn_tool(Command::new("/bin/sleep").arg("30"), &std::env::temp_dir()).unwrap()
    }

    #[test]
    fn a_cancel_before_the_process_is_registered_still_ends_it() {
        let job = job();
        job.stop();
        let started = Instant::now();
        job.register(sleeper());
        let status = job.wait().unwrap().unwrap();
        assert!(!status.success());
        assert!(started.elapsed() < CANCEL_DEADLINE);
    }

    #[test]
    fn a_cancel_ends_a_registered_process() {
        let job = job();
        job.register(sleeper());
        job.stop();
        assert!(!job.wait().unwrap().unwrap().success());
    }

    /// Б3.3: the join is waited for with its process still reachable, so a
    /// cancel that comes while the job waits ends it.
    #[test]
    fn a_cancel_ends_a_process_the_job_is_already_waiting_for() {
        let job = job();
        job.register(sleeper());
        let started = Instant::now();
        let status = std::thread::scope(|scope| {
            let waiting = scope.spawn(|| job.wait());
            std::thread::sleep(WAITING);
            job.stop();
            waiting.join().unwrap()
        });
        assert!(!status.unwrap().unwrap().success());
        assert!(started.elapsed() < CANCEL_DEADLINE, "{:?}", started.elapsed());
    }

    /// Б3.3: a cancelled join returns at once, not when the joiner is done.
    #[test]
    fn a_cancelled_join_returns_before_the_joiner_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let joiner = dir.path().join("joiner");
        std::fs::write(&joiner, "#!/bin/sh\nexec /bin/sleep 30\n").unwrap();
        std::fs::set_permissions(&joiner, <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o755))
            .unwrap();
        let job = job();
        let started = Instant::now();
        let outcome = std::thread::scope(|scope| {
            let joining = scope.spawn(|| {
                join_streams(&job, &joiner, dir.path(), &[dir.path().join("v.mp4")], &dir.path().join("joined.mp4"), 19.0)
            });
            std::thread::sleep(WAITING);
            job.stop();
            joining.join().unwrap()
        });
        assert_eq!(outcome, Err("cancelled".to_owned()));
        assert!(started.elapsed() < CANCEL_DEADLINE, "{:?}", started.elapsed());
    }

    /// Like the bundled `yt-dlp`, a launcher whose second process holds
    /// stdout: the cancel reaches both, and the read ends.
    #[test]
    fn a_cancel_reaches_the_process_the_downloader_started() {
        let dir = tempfile::tempdir().unwrap();
        let job = job();
        let started = Instant::now();
        let outcome = std::thread::scope(|scope| {
            let running = scope.spawn(|| {
                run_ytdlp(&job, Path::new("/bin/sh"), dir.path(), &["-c", "/bin/sleep 30 & wait"], |_| {})
            });
            std::thread::sleep(WAITING);
            job.stop();
            running.join().unwrap()
        });
        assert_eq!(outcome, Err("cancelled".to_owned()));
        assert!(started.elapsed() < CANCEL_DEADLINE, "{:?}", started.elapsed());
    }

    /// A process group that ignores `SIGTERM` is stopped all the same.
    #[test]
    fn a_process_group_that_ignores_termination_is_still_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let job = job();
        let started = Instant::now();
        let outcome = std::thread::scope(|scope| {
            let running = scope.spawn(|| {
                run_ytdlp(&job, Path::new("/bin/sh"), dir.path(), &["-c", "trap '' TERM; /bin/sleep 30 & wait"], |_| {})
            });
            std::thread::sleep(WAITING);
            job.stop();
            running.join().unwrap()
        });
        assert_eq!(outcome, Err("cancelled".to_owned()));
        assert!(started.elapsed() < CANCEL_DEADLINE, "{:?}", started.elapsed());
    }

    /// The bundled `yt-dlp` from `binaries/`, stopped while it waits for
    /// input: its whole process group ends, and what its launcher unpacked
    /// lies in the job's folder, not in the system temporary folder. Run by
    /// hand with `cargo test -p mine --lib bundled_downloader -- --ignored`.
    #[test]
    #[ignore = "needs the bundled yt-dlp in binaries/"]
    fn a_stopped_bundled_downloader_ends_whole_and_unpacks_into_the_job_folder() {
        const UNPACKED_PREFIX: &str = "_MEI";
        let unpacked = |folder: &Path| -> std::collections::BTreeSet<std::ffi::OsString> {
            std::fs::read_dir(folder)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .filter(|name| name.to_string_lossy().starts_with(UNPACKED_PREFIX))
                .collect()
        };
        let system_before = unpacked(&std::env::temp_dir());
        let folder = tempfile::tempdir().unwrap();
        let ytdlp = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join("yt-dlp");
        let mut child = spawn_tool(
            Command::new(ytdlp)
                .args(["-a", "-", "--simulate"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null()),
            folder.path(),
        )
        .unwrap();
        // Kept open: the downloader waits for URLs on it.
        let _input = child.stdin.take();
        let group = libc::pid_t::try_from(child.id()).unwrap();
        let job = job();
        job.register(child);
        let started = Instant::now();
        while unpacked(folder.path()).is_empty() {
            assert!(started.elapsed() < CANCEL_DEADLINE, "the launcher never unpacked");
            std::thread::sleep(PROCESS_POLL_INTERVAL);
        }
        // Long enough for the launcher to start its second process.
        std::thread::sleep(CANCEL_DEADLINE / 2);

        job.stop();
        let status = job.wait().unwrap().unwrap();

        assert!(!status.success());
        // SAFETY: signal 0 only asks whether a process of the group is left.
        assert_ne!(unsafe { libc::killpg(group, 0) }, 0, "a process of the group survived");
        assert_eq!(unpacked(&std::env::temp_dir()), system_before);
    }

    #[test]
    fn every_download_works_in_its_own_folder() {
        assert_ne!(staging_dir("abc"), staging_dir("abc"));
    }

    /// Б3.4: a space that took the folder of another one is another space,
    /// and so is each card's download there.
    #[test]
    fn two_spaces_at_one_folder_are_two_spaces() {
        let first = VaultLayout::with_derived_root(PathBuf::from("/space"), PathBuf::from("/vaults/a"));
        let second = VaultLayout::with_derived_root(PathBuf::from("/space"), PathBuf::from("/vaults/b"));
        assert!(same_space(&first, &first.clone()));
        assert!(!same_space(&first, &second));
        assert_ne!(JobKey::new(&first, "Film"), JobKey::new(&second, "Film"));
    }

    fn kept_vault(dir: &Path) -> VaultLayout {
        VaultLayout::with_derived_root(dir.join("space"), dir.join("derived"))
    }

    fn finished_video(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, name.as_bytes()).unwrap();
        path
    }

    #[test]
    fn a_kept_download_is_listed_for_its_space() {
        let dir = tempfile::tempdir().unwrap();
        let vault = kept_vault(dir.path());
        let finished = dir.path().join("joined.mp4");
        std::fs::write(&finished, b"video").unwrap();
        keep_download(&vault, "Cards/Film", "9KDDhAOyv9k", &finished).unwrap();
        let kept = kept_downloads(&vault);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].slug, "Cards/Film");
        assert_eq!(std::fs::read(kept_dir(&vault).join(&kept[0].file)).unwrap(), b"video");
        assert!(!finished.exists());
    }

    /// Б3.2: downloads that end at once all stay on the list.
    #[test]
    fn downloads_kept_at_the_same_time_are_all_listed() {
        const DOWNLOADS: usize = 16;
        let dir = tempfile::tempdir().unwrap();
        let vault = kept_vault(dir.path());
        let finished: Vec<PathBuf> =
            (0..DOWNLOADS).map(|index| finished_video(dir.path(), &format!("video-{index}.mp4"))).collect();
        let start = std::sync::Barrier::new(DOWNLOADS);
        std::thread::scope(|scope| {
            for (index, file) in finished.iter().enumerate() {
                let (vault, start) = (&vault, &start);
                scope.spawn(move || {
                    start.wait();
                    keep_download(vault, &format!("Cards/Film {index}"), "9KDDhAOyv9k", file).unwrap();
                });
            }
        });
        let kept = kept_downloads(&vault);
        assert_eq!(kept.len(), DOWNLOADS);
        for entry in &kept {
            assert!(kept_dir(&vault).join(&entry.file).is_file(), "{}", entry.file);
        }
    }

    /// Б3.2: an adoption that takes attached videos off the list keeps the
    /// ones a download adds meanwhile.
    #[test]
    fn taking_videos_off_the_list_keeps_the_ones_added_meanwhile() {
        const EACH: usize = 8;
        let dir = tempfile::tempdir().unwrap();
        let vault = kept_vault(dir.path());
        for index in 0..EACH {
            keep_download(&vault, &format!("Cards/Old {index}"), "9KDDhAOyv9k", &finished_video(dir.path(), &format!("old-{index}.mp4")))
                .unwrap();
        }
        let old = kept_downloads(&vault);
        let fresh: Vec<PathBuf> =
            (0..EACH).map(|index| finished_video(dir.path(), &format!("new-{index}.mp4"))).collect();
        let start = std::sync::Barrier::new(EACH * 2);
        std::thread::scope(|scope| {
            for (index, (entry, file)) in old.iter().zip(&fresh).enumerate() {
                let (vault, start) = (&vault, &start);
                scope.spawn(move || {
                    start.wait();
                    forget_kept(vault, entry).unwrap();
                });
                scope.spawn(move || {
                    start.wait();
                    keep_download(vault, &format!("Cards/New {index}"), "9KDDhAOyv9k", file).unwrap();
                });
            }
        });
        let mut slugs: Vec<String> = kept_downloads(&vault).into_iter().map(|entry| entry.slug).collect();
        slugs.sort();
        let mut expected: Vec<String> = (0..EACH).map(|index| format!("Cards/New {index}")).collect();
        expected.sort();
        assert_eq!(slugs, expected);
    }

    /// Б3.1: a passing failure keeps the video and its record for the next
    /// opening; a refusal for good removes both.
    #[test]
    fn only_a_final_answer_removes_a_kept_video() {
        let dir = tempfile::tempdir().unwrap();
        let vault = kept_vault(dir.path());
        keep_download(&vault, "Cards/Film", "9KDDhAOyv9k", &finished_video(dir.path(), "joined.mp4")).unwrap();
        let kept = kept_downloads(&vault).remove(0);
        let file = kept_dir(&vault).join(&kept.file);

        for passing in [
            "database is locked",
            "'Cards/Film.md' changed outside Mine; nothing was written",
        ] {
            settle_kept_download(&vault, &kept, &Err(MediaAssetActionError::Internal { message: passing.into() }));
            assert_eq!(kept_downloads(&vault), vec![kept.clone()], "{passing}");
            assert!(file.is_file(), "{passing}");
        }

        settle_kept_download(
            &vault,
            &kept,
            &Err(MediaAssetActionError::InvalidMediaRef { reason: "the card no longer links to this video".into() }),
        );
        assert!(kept_downloads(&vault).is_empty());
        assert!(!file.exists());
    }

    use super::*;
    use serde_json::json;
    use std::time::Instant;

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
