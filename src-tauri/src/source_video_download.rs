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
//!
//! Every tool runs through `tool_process` (SPEC_DEEP_AUDIT.md, Н4): a process
//! group of its own, a time limit, `Blocked` told apart. A download belongs to
//! its card, not to the card's name: a rename or a move keeps its progress,
//! its Cancel and its video (Н4). Quitting Mine stops every download, and a
//! video already finished but not yet in its card is kept for the next launch
//! (Н3).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::commands::blocks::{MediaAssetActionError, MediaAssetMutationResult};
use crate::domain::vault::VaultLayout;
use crate::tool_process::{Limits, RunningTools, ToolFailure};

/// Event carrying a download's state to the interface.
pub const EVENT: &str = "source-video-download";
/// The tallest picture downloaded. Higher streams cost far more space for a
/// card preview, and 720p H.264 plays everywhere macOS does.
const MAX_HEIGHT: u64 = 720;
/// Prefix of the progress lines this module asks `yt-dlp` to print.
const PROGRESS_PREFIX: &str = "MINE-PROGRESS";
/// Reading a video's formats is one request to YouTube: past this the
/// downloader is stuck, behind a system dialog or a dead connection (Н4).
const DETAILS_TIME_LIMIT: Duration = Duration::from_secs(120);
/// A download reports progress several times a second; this long without a
/// line from the downloader means it stalled (Н4). A long video keeps going as
/// long as it reports.
const DOWNLOAD_SILENCE_LIMIT: Duration = Duration::from_secs(120);
/// Joining the streams of a 720p video takes seconds to a few minutes; the
/// joiner reports nothing while it works, so its limit is the whole run.
const JOIN_TIME_LIMIT: Duration = Duration::from_secs(15 * 60);
/// The error of a step that ended because the person cancelled or Mine is
/// quitting: never shown, the job's final state says what happened.
const STOPPED: &str = "stopped";

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

/// A readable reason from `yt-dlp`'s error output. A refusal of macOS to
/// load the downloader is told apart (Н4): it says the tool is unusable here,
/// not that this video failed.
fn failure_message(stderr: &str) -> String {
    if let ToolFailure::Blocked(detail) = crate::tool_process::classify_failure(stderr) {
        return blocked_message(&detail);
    }
    let last_error = stderr
        .lines()
        .rev()
        .find(|line| line.starts_with("ERROR:"))
        .map(|line| line.trim_start_matches("ERROR:").trim().to_owned());
    match last_error {
        Some(error) if error.contains("Sign in to confirm") => {
            "YouTube asked to sign in to confirm this is not a bot.".to_owned()
        }
        // YouTube changes its player, and a downloader older than the change
        // gets 403 for every video (SPEC_MEDIA_ASSET_ACTIONS.md, «Download
        // Media»): the person learns the likely cause, not only the code (Е2.5).
        Some(error) if error.contains("403") => {
            "YouTube refused the download (HTTP 403). The bundled video downloader may be out of date.".to_owned()
        }
        Some(error) => error,
        None => "The video downloader stopped without a reason.".to_owned(),
    }
}

fn blocked_message(detail: &str) -> String {
    format!("macOS blocked the bundled video downloader: {detail}")
}

/// Why a tool gave no usable answer, as the person reads it.
fn tool_failure_message(tool: &str, failure: &ToolFailure) -> String {
    match failure {
        ToolFailure::Missing(detail) => format!("The bundled {tool} could not start: {detail}"),
        ToolFailure::Blocked(detail) => blocked_message(detail),
        ToolFailure::Timeout(limit) => format!(
            "The {tool} stopped responding and was ended after {} s.",
            limit.as_secs()
        ),
        ToolFailure::Failed(detail) => format!("The {tool} failed: {detail}"),
    }
}

/// A card's file as the file system knows it: the device and the inode,
/// which a rename or a move within the volume keeps (Н4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardKey {
    pub device: u64,
    pub inode: u64,
}

impl CardKey {
    /// The key of the file at `path`, if it is there.
    pub fn of(path: &Path) -> Option<Self> {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::metadata(path).ok()?;
        Some(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
}

/// Where a job stands. One lock holds it, so a Cancel and the start of the
/// delivery cannot both win (Е2.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// The tools are running.
    Downloading,
    /// The person cancelled: the tools were ended and the files go.
    Cancelled,
    /// Mine is quitting: the tools were ended; a finished video is kept (Н3).
    Quitting,
    /// The finished video is going into its card. A Cancel now comes too
    /// late: the video goes in, and the job says so.
    Delivering,
}

/// The card a job belongs to: its name now, and its file's key.
#[derive(Debug, Clone)]
struct CardRef {
    slug: String,
    key: Option<CardKey>,
}

struct Job {
    vault: VaultLayout,
    video_id: String,
    card: Mutex<CardRef>,
    /// The job's tools. Closing them ends the one running and any started
    /// later (`RunningTools::close`).
    tools: RunningTools,
    phase: Mutex<Phase>,
    state: Mutex<DownloadState>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Job {
    fn new(vault: VaultLayout, video_id: &str, slug: &str, key: Option<CardKey>) -> Self {
        Self {
            vault,
            video_id: video_id.to_owned(),
            card: Mutex::new(CardRef {
                slug: slug.to_owned(),
                key,
            }),
            tools: RunningTools::new(),
            phase: Mutex::new(Phase::Downloading),
            state: Mutex::new(DownloadState::Preparing),
        }
    }

    /// The card's name now.
    fn slug(&self) -> String {
        lock(&self.card).slug.clone()
    }

    fn key(&self) -> Option<CardKey> {
        lock(&self.card).key
    }

    /// The card is called `slug` now (Н4).
    fn follow(&self, slug: &str) {
        lock(&self.card).slug = slug.to_owned();
    }

    fn phase(&self) -> Phase {
        *lock(&self.phase)
    }

    fn is_running(&self) -> bool {
        lock(&self.state).is_running()
    }

    /// The person's Cancel: the download ends at whatever step it is, unless
    /// the video is already going into its card (Е2.6). Returns whether the
    /// Cancel took.
    fn cancel(&self) -> bool {
        let mut phase = lock(&self.phase);
        if *phase != Phase::Downloading {
            return false;
        }
        *phase = Phase::Cancelled;
        drop(phase);
        self.tools.close();
        true
    }

    /// Mine is quitting (Н3): the tools end; a delivery under way finishes.
    fn quit(&self) {
        let mut phase = lock(&self.phase);
        if *phase != Phase::Downloading {
            return;
        }
        *phase = Phase::Quitting;
        drop(phase);
        self.tools.close();
    }

    /// The video is finished: from here on it goes into the card, unless the
    /// job was stopped before. Returns the phase that stopped it.
    fn begin_delivery(&self) -> Result<(), Phase> {
        let mut phase = lock(&self.phase);
        match *phase {
            Phase::Downloading => {
                *phase = Phase::Delivering;
                Ok(())
            }
            stopped => Err(stopped),
        }
    }

    /// Whether the person or the exit stopped the job.
    fn stopped(&self) -> bool {
        matches!(self.phase(), Phase::Cancelled | Phase::Quitting)
    }
}

/// What a job's end shows: a video that went into its card is Done even when
/// a Cancel came during the delivery (Е2.6); a stopped job that delivered
/// nothing is Cancelled.
fn final_state(outcome: &Result<(), String>, phase: Phase) -> DownloadState {
    match (outcome, phase) {
        (Ok(()), _) => DownloadState::Done,
        (Err(_), Phase::Cancelled) => DownloadState::Cancelled,
        (Err(message), _) => DownloadState::Failed {
            message: message.clone(),
        },
    }
}

/// Whether two layouts are one space: the same folder and the same identity,
/// which names the space's derived store. A space placed at the folder of
/// another one is another space (`SPEC_AUDIT_FIXES.md`, Ф9, Б3.4).
///
/// Both layouts are what the app knew when they were made. Whether the
/// folder still holds that space on disk is asked where a result is
/// published into it (`root_guard`; Г2.2): a disconnected disk leaves the
/// open session naming a folder that is not there.
pub(crate) fn same_space(a: &VaultLayout, b: &VaultLayout) -> bool {
    a.root() == b.root() && a.derived_root() == b.derived_root()
}

/// Running and finished downloads of this session. A job belongs to a card
/// of one space: cards with the same name in two spaces are two downloads,
/// including two spaces that used one folder one after the other.
#[derive(Default)]
pub struct SourceVideoDownloads {
    jobs: Mutex<Vec<Arc<Job>>>,
    threads: Mutex<Vec<JoinHandle<()>>>,
    /// Mine is quitting: no download starts (Н3).
    quitting: AtomicBool,
}

impl SourceVideoDownloads {
    /// The job of the card `slug` in the space `vault`: by the card's name,
    /// or, for a card renamed or moved outside Mine, by its file (Н4). A job
    /// found by its file follows the card's new name.
    fn job_for(&self, vault: &VaultLayout, slug: &str) -> Option<Arc<Job>> {
        let jobs = lock(&self.jobs);
        let in_space = || jobs.iter().rev().filter(|job| same_space(&job.vault, vault));
        if let Some(job) = in_space().find(|job| job.slug() == slug) {
            return Some(Arc::clone(job));
        }
        let key = CardKey::of(&vault.block_path(slug))?;
        let job = in_space().find(|job| job.key() == Some(key))?;
        job.follow(slug);
        Some(Arc::clone(job))
    }

    /// The last known state of a card's download in the space `vault`, if
    /// one ran in this session.
    pub fn status(&self, vault: &VaultLayout, slug: &str) -> Option<DownloadState> {
        let job = self.job_for(vault, slug)?;
        let state = lock(&job.state).clone();
        Some(state)
    }

    /// A card of `vault` was renamed in Mine from `from` to `to`: its
    /// download goes on under the new name (Н4).
    pub fn follow_rename(&self, vault: &VaultLayout, from: &str, to: &str) {
        let jobs = lock(&self.jobs);
        for job in jobs.iter().filter(|job| same_space(&job.vault, vault) && job.slug() == from) {
            job.follow(to);
        }
    }

    /// A new job for the card `slug`, unless one is running for it.
    fn register(&self, vault: &VaultLayout, slug: &str, video_id: &str) -> Result<Option<Arc<Job>>, String> {
        if self.quitting.load(Ordering::SeqCst) {
            return Err("Mine is quitting; the download did not start.".to_owned());
        }
        if self.job_for(vault, slug).is_some_and(|job| job.is_running()) {
            return Ok(None);
        }
        let job = Arc::new(Job::new(
            vault.clone(),
            video_id,
            slug,
            CardKey::of(&vault.block_path(slug)),
        ));
        lock(&self.jobs).push(Arc::clone(&job));
        Ok(Some(job))
    }

    /// Start downloading the card's source video into the space `vault`,
    /// unless it already is.
    ///
    /// # Errors
    /// The card has no YouTube source, or Mine is quitting.
    pub fn start(
        &self,
        app: &AppHandle,
        vault: VaultLayout,
        slug: String,
        source_url: &str,
    ) -> Result<(), String> {
        let source = mine_core::domain::video_source::parse_youtube_source(source_url)
            .ok_or_else(|| "The card has no supported source video.".to_owned())?;
        let Some(job) = self.register(&vault, &slug, &source.video_id)? else {
            return Ok(());
        };
        emit(app, &job, DownloadState::Preparing);
        // The download keeps its space open until it ends (SPEC_TABS.md, В8).
        let lease = {
            let state = app.state::<crate::commands::state::AppState>();
            let open = state.spaces.by_root(job.vault.root());
            open.map(|space| state.spaces.lease(space.vault_id()))
        };
        let app = app.clone();
        let handle = std::thread::Builder::new()
            .name("source-video-download".into())
            .spawn(move || {
                let _lease = lease;
                let outcome = run(&app, &job);
                if job.phase() == Phase::Quitting {
                    // The windows are going; the kept video comes in at the
                    // next launch (Н3).
                    if let Err(message) = &outcome {
                        log::info!("download of {} ended with Mine: {message}", job.slug());
                    }
                    return;
                }
                report(&app, &job, final_state(&outcome, job.phase()));
            })
            .map_err(|error| error.to_string())?;
        let mut threads = lock(&self.threads);
        threads.retain(|thread| !thread.is_finished());
        threads.push(handle);
        Ok(())
    }

    /// Stop a running download of a card in the space `vault`; its partial
    /// files are removed.
    pub fn cancel(&self, vault: &VaultLayout, slug: &str) {
        if let Some(job) = self.job_for(vault, slug) {
            job.cancel();
        }
    }

    /// Mine is quitting (Н3): no download starts from now on, every running
    /// one stops with its process group, and this waits up to `deadline` for
    /// the jobs to clean up: working folders removed, finished videos kept.
    /// Returns how many jobs were still going at the deadline.
    pub fn shutdown(&self, deadline: Duration) -> usize {
        self.quitting.store(true, Ordering::SeqCst);
        for job in lock(&self.jobs).iter() {
            job.quit();
        }
        let threads = std::mem::take(&mut *lock(&self.threads));
        let started = Instant::now();
        let mut unfinished = 0;
        for thread in threads {
            while !thread.is_finished() && started.elapsed() < deadline {
                std::thread::sleep(SHUTDOWN_POLL);
            }
            if thread.is_finished() {
                let _ = thread.join();
            } else {
                unfinished += 1;
            }
        }
        unfinished
    }
}

/// How often a quitting app looks whether a download job has ended.
const SHUTDOWN_POLL: Duration = Duration::from_millis(25);

impl DownloadState {
    fn is_running(&self) -> bool {
        matches!(self, Self::Preparing | Self::Downloading { .. } | Self::Finishing)
    }
}

/// Record a new state and tell the interface; repeats are not re-sent.
fn report(app: &AppHandle, job: &Job, state: DownloadState) {
    {
        let mut current = lock(&job.state);
        if *current == state {
            return;
        }
        *current = state.clone();
    }
    emit(app, job, state);
}

/// Progress reaches the tabs of the job's space only, named by the card's
/// name now: a card of the same name in another space is another card
/// (SPEC_TABS.md, В21).
fn emit(app: &AppHandle, job: &Job, state: DownloadState) {
    let space = app
        .state::<crate::commands::state::AppState>()
        .spaces
        .by_root(job.vault.root());
    let Some(space) = space else {
        return;
    };
    if !space.layout().is_ok_and(|open| same_space(&open, &job.vault)) {
        return;
    }
    crate::commands::space_events::emit_to_space(
        app,
        space.vault_id(),
        EVENT,
        DownloadEvent { slug: job.slug(), state },
    );
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

fn run(app: &AppHandle, job: &Job) -> Result<(), String> {
    let tools = Tools {
        ytdlp: bundled_ytdlp(app).ok_or("The bundled video downloader is missing.")?,
        joiner: bundled_tool(app, "video-mux-helper").ok_or("The bundled video joiner is missing.")?,
    };
    let staging = Staging(staging_dir(&job.video_id));
    let finished = download_to_file(job, &tools, &staging.0, |state| report(app, job, state))?;
    deliver_finished(job, &finished, |slug, key, finished| {
        crate::commands::blocks::attach_downloaded_source_video(app, &job.vault, slug, key, &job.video_id, finished)
    })
}

/// A finished video goes into its card under the card's name now (Н4), or,
/// when Mine is quitting, into the space's kept list for the next launch
/// (Н3). A Cancel before this point drops it; after, it comes too late (Е2.6).
fn deliver_finished(
    job: &Job,
    finished: &Path,
    attach: impl FnOnce(&str, Option<CardKey>, &Path) -> AttachOutcome,
) -> Result<(), String> {
    match job.begin_delivery() {
        Ok(()) => {
            let slug = job.slug();
            let key = job.key();
            deliver_download(&job.vault, &slug, key, &job.video_id, finished, |finished| {
                attach(&slug, key, finished)
            })
        }
        Err(Phase::Quitting) => {
            keep_download(&job.vault, &job.slug(), job.key(), &job.video_id, finished)?;
            Err("Mine quit before the video went into the card; it is kept and will be added at the next launch.".to_owned())
        }
        Err(_) => Err(STOPPED.to_owned()),
    }
}

/// Hand a finished download to its card through `attach` (`SPEC_AUDIT_FIXES.md`,
/// Ф9, В3.2).
///
/// A refusal no later attempt changes (the card links another clip or has
/// its own video now) leaves the video to the job's working folder, which
/// goes. Any other failure passes: a card not found (Н4), a busy index, the
/// card edited in Obsidian between the read and the write, a folder that
/// cannot be read now. Then the video is kept for the space, as a download
/// finished for a closed space is, and attached when the space opens again;
/// the job still reports the failure, saying the video is kept.
pub(crate) fn deliver_download(
    vault: &VaultLayout,
    slug: &str,
    key: Option<CardKey>,
    video_id: &str,
    finished: &Path,
    attach: impl FnOnce(&Path) -> AttachOutcome,
) -> Result<(), String> {
    let outcome = attach(finished);
    let Err(error) = &outcome else {
        return Ok(());
    };
    if kept_fate(&outcome) == KeptFate::Settled {
        return Err(error.to_string());
    }
    match keep_download(vault, slug, key, video_id, finished) {
        Ok(()) => Err(format!(
            "{error}. The video is kept and will be added the next time this space opens."
        )),
        Err(keeping) => Err(format!("{error}. The video could not be kept: {keeping}")),
    }
}

/// A finished download kept for a space whose folder was not reachable when
/// the download ended, whose card was not found, or that Mine quit before
/// it went in. It is attached the next time the space opens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeptDownload {
    pub slug: String,
    pub video_id: String,
    pub file: String,
    /// The card's file when the download started, to find it renamed (Н4).
    /// Absent in a list written before 13.10.2026.
    #[serde(default)]
    pub card: Option<CardKey>,
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

/// Write the kept list whole and durably. It belongs to the derived store,
/// and it is what a quitting Mine writes after new source writes stopped
/// (Н3), so it does not pass the source write gate.
fn write_kept_list(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("the kept list has no folder")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    temporary.write_all(bytes).map_err(|error| error.to_string())?;
    temporary.as_file().sync_all().map_err(|error| error.to_string())?;
    temporary.persist(path).map_err(|error| error.to_string())?;
    std::fs::File::open(parent)
        .and_then(|folder| folder.sync_all())
        .map_err(|error| error.to_string())
}

/// Move a finished video into the derived store, durably and without the
/// source write gate (see `write_kept_list`).
fn move_into_store(from: &Path, to: &Path) -> Result<(), String> {
    match std::fs::rename(from, to) {
        Ok(()) => {}
        Err(error) if error.raw_os_error() == Some(libc::EXDEV) => {
            std::fs::copy(from, to).map_err(|error| error.to_string())?;
            std::fs::File::open(to)
                .and_then(|file| file.sync_all())
                .map_err(|error| error.to_string())?;
            std::fs::remove_file(from).map_err(|error| error.to_string())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    let parent = to.parent().ok_or("the kept video has no folder")?;
    std::fs::File::open(parent)
        .and_then(|folder| folder.sync_all())
        .map_err(|error| error.to_string())
}

/// Apply `change` to the kept list of `vault` as one step (see `KEPT_LIST`).
fn change_kept(vault: &VaultLayout, change: impl FnOnce(&mut Vec<KeptDownload>)) -> Result<(), String> {
    let _list = KEPT_LIST.lock().unwrap_or_else(PoisonError::into_inner);
    let mut kept = read_kept(vault)?;
    change(&mut kept);
    let bytes = serde_json::to_vec_pretty(&kept).map_err(|error| error.to_string())?;
    write_kept_list(&kept_list(vault), &bytes)
}

/// Keep a finished download in the space's derived store: it could not go
/// into its card now, and the result must not be lost (Ф9, Н3, Н4).
pub fn keep_download(
    vault: &VaultLayout,
    slug: &str,
    card: Option<CardKey>,
    video_id: &str,
    finished: &Path,
) -> Result<(), String> {
    let dir = kept_dir(vault);
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let name = staging_dir(video_id)
        .file_name()
        .map(|name| format!("{}.mp4", name.to_string_lossy()))
        .ok_or("no name for the kept video")?;
    let kept_path = dir.join(&name);
    move_into_store(finished, &kept_path)?;
    let record = KeptDownload {
        slug: slug.to_owned(),
        video_id: video_id.to_owned(),
        file: name,
        card,
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
        // of its own; or the card links another clip or has its own video
        // now, an answer no later attempt changes.
        Ok(_) | Err(MediaAssetActionError::InvalidMediaRef { .. }) => KeptFate::Settled,
        // A card not found (Н4), a busy index, a card edited in Obsidian
        // between the read and the write, an unreadable folder: all pass
        // (SPEC_AUDIT_FIXES.md, Б3.1).
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
/// that failed for a passing reason, its card not found included, waits for
/// the next opening.
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
                    kept.card,
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
    staging: &Path,
    mut on_state: impl FnMut(DownloadState),
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(staging).map_err(|error| error.to_string())?;
    let watch_url = format!("https://www.youtube.com/watch?v={}", job.video_id);

    let meta = run_ytdlp(
        job,
        &tools.ytdlp,
        staging,
        &["-J", "--no-playlist", &watch_url],
        Limits { total: Some(DETAILS_TIME_LIMIT), idle: None },
        |_| {},
    )?;
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
        Limits { total: None, idle: Some(DOWNLOAD_SILENCE_LIMIT) },
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
/// video takes a while: the helper is one of the job's tools, which a cancel
/// ends at any moment, like the download (`SPEC_AUDIT_FIXES.md`, А7.5, Б3.3).
fn join_streams(
    job: &Job,
    helper: &Path,
    temp: &Path,
    streams: &[PathBuf],
    output: &Path,
    seconds: f64,
) -> Result<PathBuf, String> {
    if job.stopped() {
        return Err(STOPPED.into());
    }
    let mut command = Command::new(helper);
    command.args(streams).arg(output).arg(seconds.to_string()).env("TMPDIR", temp);
    let outcome = crate::tool_process::run_lines(
        &mut command,
        Limits { total: Some(JOIN_TIME_LIMIT), idle: None },
        &job.tools,
        |_| {},
    );
    if job.stopped() {
        return Err(STOPPED.into());
    }
    match outcome {
        Ok(exit) if exit.success => Ok(output.to_path_buf()),
        Ok(exit) => Err(format!("Could not join video and sound: {}", exit.stderr.trim())),
        Err(failure) => Err(tool_failure_message("video joiner", &failure)),
    }
}

/// Run `yt-dlp` under `limits` as one of the job's tools, feeding stdout
/// lines to `on_line`; returns all of stdout. `temp` is the job's working
/// folder, the tool's `TMPDIR`: whatever it writes there goes with the job.
fn run_ytdlp(
    job: &Job,
    ytdlp: &Path,
    temp: &Path,
    args: &[&str],
    limits: Limits,
    on_line: impl FnMut(&str),
) -> Result<String, String> {
    if job.stopped() {
        return Err(STOPPED.into());
    }
    let mut command = Command::new(ytdlp);
    command.args(args).env("PATH", tool_search_path()).env("TMPDIR", temp);
    let outcome = crate::tool_process::run_lines(&mut command, limits, &job.tools, on_line);
    if job.stopped() {
        return Err(STOPPED.into());
    }
    match outcome {
        Ok(exit) if exit.success => Ok(exit.stdout),
        Ok(exit) => Err(failure_message(&exit.stderr)),
        Err(failure) => Err(tool_failure_message("video downloader", &failure)),
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

/// The launcher of the bundled unpacked `yt-dlp` (SPEC_ONBOARDING.md, О8.1),
/// or in development the one `bun run fetch:ytdlp` staged.
fn bundled_ytdlp(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(crate::tool_process::ytdlp_in(&resources.join("binaries")));
    }
    candidates.push(crate::tool_process::ytdlp_in(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"),
    ));
    candidates.into_iter().find(|path| path.is_file())
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

    fn job() -> Job {
        Job::new(VaultLayout::new(PathBuf::from("/space")), "9KDDhAOyv9k", "Cards/Film", None)
    }

    /// A cancel must end the job's wait well before a 30 second process would.
    const CANCEL_DEADLINE: Duration = Duration::from_secs(5);
    /// Long enough for the waiting thread to be inside its tool.
    const WAITING: Duration = Duration::from_millis(300);

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o755))
            .unwrap();
        path
    }

    #[test]
    fn a_cancel_before_the_tool_starts_still_ends_it() {
        let dir = tempfile::tempdir().unwrap();
        let sleeper = script(dir.path(), "sleeper", "exec /bin/sleep 30");
        let job = job();
        assert!(job.cancel());
        let started = Instant::now();
        let outcome = run_ytdlp(&job, &sleeper, dir.path(), &[], Limits { total: None, idle: None }, |_| {});
        assert_eq!(outcome, Err(STOPPED.to_owned()));
        assert!(started.elapsed() < CANCEL_DEADLINE);
    }

    /// Б3.3: a cancelled join returns at once, not when the joiner is done.
    #[test]
    fn a_cancelled_join_returns_before_the_joiner_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let joiner = script(dir.path(), "joiner", "exec /bin/sleep 30");
        let job = job();
        let started = Instant::now();
        let outcome = std::thread::scope(|scope| {
            let joining = scope.spawn(|| {
                join_streams(&job, &joiner, dir.path(), &[dir.path().join("v.mp4")], &dir.path().join("joined.mp4"), 19.0)
            });
            std::thread::sleep(WAITING);
            job.cancel();
            joining.join().unwrap()
        });
        assert_eq!(outcome, Err(STOPPED.to_owned()));
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
                run_ytdlp(&job, Path::new("/bin/sh"), dir.path(), &["-c", "/bin/sleep 30 & wait"], Limits { total: None, idle: None }, |_| {})
            });
            std::thread::sleep(WAITING);
            job.cancel();
            running.join().unwrap()
        });
        assert_eq!(outcome, Err(STOPPED.to_owned()));
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
                run_ytdlp(&job, Path::new("/bin/sh"), dir.path(), &["-c", "trap '' TERM; /bin/sleep 30 & wait"], Limits { total: None, idle: None }, |_| {})
            });
            std::thread::sleep(WAITING);
            job.cancel();
            running.join().unwrap()
        });
        assert_eq!(outcome, Err(STOPPED.to_owned()));
        assert!(started.elapsed() < CANCEL_DEADLINE, "{:?}", started.elapsed());
    }

    /// Е2.4: a downloader that stops reporting is ended at its limit and says
    /// so, instead of holding the job for good.
    #[test]
    fn a_silent_downloader_is_ended_at_its_limit() {
        let dir = tempfile::tempdir().unwrap();
        let job = job();
        let started = Instant::now();
        let outcome = run_ytdlp(
            &job,
            Path::new("/bin/sh"),
            dir.path(),
            &["-c", "echo MINE-PROGRESS 1 0 10 NA; /bin/sleep 30"],
            Limits { total: None, idle: Some(Duration::from_millis(500)) },
            |_| {},
        );
        assert_eq!(
            outcome,
            Err("The video downloader stopped responding and was ended after 0 s.".to_owned())
        );
        assert!(started.elapsed() < CANCEL_DEADLINE, "{:?}", started.elapsed());
    }

    /// Е2.4: macOS refusing to load the downloader is named as such.
    #[test]
    fn a_downloader_macos_refuses_is_told_apart() {
        let dir = tempfile::tempdir().unwrap();
        let job = job();
        let outcome = run_ytdlp(
            &job,
            Path::new("/bin/sh"),
            dir.path(),
            &["-c", "echo \"[PYI-1:ERROR] Failed to load Python shared library: library load disallowed by system policy\" >&2; exit 1"],
            Limits { total: Some(CANCEL_DEADLINE), idle: None },
            |_| {},
        );
        let message = outcome.unwrap_err();
        assert!(message.starts_with("macOS blocked the bundled video downloader"), "{message}");
    }

    /// The bundled unpacked `yt-dlp` from `binaries/`, stopped while it waits
    /// for input: its whole process group ends, and it unpacked nothing, in
    /// the job's folder or in the system temporary folder (SPEC_ONBOARDING.md,
    /// О8.1). Run by hand with
    /// `cargo test -p mine --lib bundled_downloader -- --ignored`.
    #[test]
    #[ignore = "needs the bundled yt-dlp in binaries/"]
    fn a_stopped_bundled_downloader_ends_whole_and_unpacks_nothing() {
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
        let ytdlp = crate::tool_process::ytdlp_in(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"));
        let job = job();
        let outcome = std::thread::scope(|scope| {
            let running = scope.spawn(|| {
                run_ytdlp(&job, &ytdlp, folder.path(), &["--simulate", "-a", "/dev/stdin"], Limits { total: None, idle: None }, |_| {})
            });
            // Long enough for Python to start.
            std::thread::sleep(CANCEL_DEADLINE / 2);
            assert!(unpacked(folder.path()).is_empty(), "the downloader unpacked into its folder");
            job.cancel();
            running.join().unwrap()
        });
        assert_eq!(outcome, Err(STOPPED.to_owned()));
        assert_eq!(job.tools.count(), 0, "a process of the group survived");
        assert_eq!(unpacked(&std::env::temp_dir()), system_before);
    }

    #[test]
    fn every_download_works_in_its_own_folder() {
        assert_ne!(staging_dir("abc"), staging_dir("abc"));
    }

    fn space_in(dir: &Path) -> VaultLayout {
        VaultLayout::with_derived_root(dir.join("space"), dir.join("derived"))
    }

    /// Б3.4: a space that took the folder of another one is another space,
    /// and so is each card's download there.
    #[test]
    fn two_spaces_at_one_folder_are_two_spaces() {
        let first = VaultLayout::with_derived_root(PathBuf::from("/space"), PathBuf::from("/vaults/a"));
        let second = VaultLayout::with_derived_root(PathBuf::from("/space"), PathBuf::from("/vaults/b"));
        assert!(same_space(&first, &first.clone()));
        assert!(!same_space(&first, &second));
        let downloads = SourceVideoDownloads::default();
        downloads.register(&first, "Film", "9KDDhAOyv9k").unwrap().unwrap();
        assert!(downloads.status(&first, "Film").is_some());
        assert!(downloads.status(&second, "Film").is_none());
    }

    /// Е2.3 (Н4): a card renamed in Mine, or renamed or moved outside it,
    /// keeps its download: progress and Cancel follow the new name.
    #[test]
    fn a_renamed_card_keeps_its_download() {
        let dir = tempfile::tempdir().unwrap();
        let vault = space_in(dir.path());
        std::fs::create_dir_all(vault.root().join("Cards")).unwrap();
        std::fs::write(vault.block_path("Cards/Film"), b"# Film\n").unwrap();
        let downloads = SourceVideoDownloads::default();
        let job = downloads.register(&vault, "Cards/Film", "9KDDhAOyv9k").unwrap().unwrap();
        *lock(&job.state) = DownloadState::Downloading { percent: 40 };

        // Renamed in Mine.
        std::fs::rename(vault.block_path("Cards/Film"), vault.block_path("Cards/Movie")).unwrap();
        downloads.follow_rename(&vault, "Cards/Film", "Cards/Movie");
        assert_eq!(downloads.status(&vault, "Cards/Movie"), Some(DownloadState::Downloading { percent: 40 }));
        assert_eq!(job.slug(), "Cards/Movie");

        // Moved outside Mine: found by its file.
        std::fs::create_dir_all(vault.root().join("Archive")).unwrap();
        std::fs::rename(vault.block_path("Cards/Movie"), vault.block_path("Archive/Movie")).unwrap();
        assert_eq!(downloads.status(&vault, "Archive/Movie"), Some(DownloadState::Downloading { percent: 40 }));
        assert_eq!(job.slug(), "Archive/Movie", "events name the card as it is called now");
        // A new download of the same card is not started beside it.
        assert!(downloads.register(&vault, "Archive/Movie", "9KDDhAOyv9k").unwrap().is_none());
        downloads.cancel(&vault, "Archive/Movie");
        assert_eq!(job.phase(), Phase::Cancelled);
    }

    fn finished_video(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, name.as_bytes()).unwrap();
        path
    }

    /// Е2.6: a Cancel that comes while the video goes into the card does not
    /// stop it, and the job says Done.
    #[test]
    fn a_cancel_during_the_delivery_comes_too_late() {
        let dir = tempfile::tempdir().unwrap();
        let job = job();
        let finished = finished_video(dir.path(), "joined.mp4");
        let outcome = deliver_finished(&job, &finished, |_, _, _| {
            assert!(!job.cancel(), "the Cancel took while the video went in");
            Ok(MediaAssetMutationResult { media_ref: "Film.mp4".into(), new_media_ref: None, affected_slugs: vec![] })
        });
        assert_eq!(final_state(&outcome, job.phase()), DownloadState::Done);
        // A Cancel before the delivery drops the video.
        let cancelled = super::tests::job();
        assert!(cancelled.cancel());
        let outcome = deliver_finished(&cancelled, &finished, |_, _, _| panic!("a cancelled video went in"));
        assert_eq!(final_state(&outcome, cancelled.phase()), DownloadState::Cancelled);
    }

    /// Е2.2 (Н3): quitting stops a running download with its process group
    /// and removes its working folder; a video finished but not yet in its
    /// card is kept for the next launch instead.
    #[test]
    fn quitting_stops_downloads_and_keeps_a_finished_video() {
        let dir = tempfile::tempdir().unwrap();
        let vault = space_in(dir.path());
        let downloads = SourceVideoDownloads::default();
        let running = downloads.register(&vault, "Cards/Film", "9KDDhAOyv9k").unwrap().unwrap();
        let staging_path = dir.path().join("staging");
        let thread = {
            let running = Arc::clone(&running);
            let staging_path = staging_path.clone();
            std::thread::spawn(move || {
                let staging = Staging(staging_path);
                std::fs::create_dir_all(&staging.0).unwrap();
                run_ytdlp(&running, Path::new("/bin/sh"), &staging.0, &["-c", "/bin/sleep 30"], Limits { total: None, idle: None }, |_| {})
            })
        };
        lock(&downloads.threads).push(std::thread::spawn(move || {
            let _ = thread.join();
        }));
        let finishing = downloads.register(&vault, "Cards/Other", "abcdefghijk").unwrap().unwrap();
        std::thread::sleep(WAITING);

        let started = Instant::now();
        assert_eq!(downloads.shutdown(CANCEL_DEADLINE), 0, "a download outlived the exit");
        assert!(started.elapsed() < CANCEL_DEADLINE);
        assert!(!staging_path.exists(), "the working folder stayed");
        assert_eq!(running.tools.count(), 0);

        // The other job had its video when Mine quit: it is kept, not attached.
        let finished = finished_video(dir.path(), "joined.mp4");
        let outcome = deliver_finished(&finishing, &finished, |_, _, _| panic!("attached while quitting"));
        assert!(outcome.is_err());
        let kept = kept_downloads(&vault);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].slug, "Cards/Other");
        assert!(kept_dir(&vault).join(&kept[0].file).is_file());
        // And nothing starts any more.
        assert!(downloads.register(&vault, "Cards/Third", "9KDDhAOyv9k").is_err());
    }

    /// Н4: a card not found keeps its video for the next opening.
    #[test]
    fn a_card_not_found_keeps_the_video() {
        let dir = tempfile::tempdir().unwrap();
        let vault = space_in(dir.path());
        let finished = finished_video(dir.path(), "joined.mp4");
        let outcome = deliver_download(&vault, "Cards/Film", None, "9KDDhAOyv9k", &finished, |_| {
            Err(MediaAssetActionError::Internal { message: "the card of this download was not found".into() })
        });
        assert!(outcome.unwrap_err().contains("The video is kept"));
        let kept = kept_downloads(&vault);
        assert_eq!(kept.len(), 1);
        assert!(kept_dir(&vault).join(&kept[0].file).is_file());
    }

    #[test]
    fn a_kept_download_is_listed_for_its_space() {
        let dir = tempfile::tempdir().unwrap();
        let vault = space_in(dir.path());
        let finished = dir.path().join("joined.mp4");
        std::fs::write(&finished, b"video").unwrap();
        let key = Some(CardKey { device: 1, inode: 2 });
        keep_download(&vault, "Cards/Film", key, "9KDDhAOyv9k", &finished).unwrap();
        let kept = kept_downloads(&vault);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].slug, "Cards/Film");
        assert_eq!(kept[0].card, key);
        assert_eq!(std::fs::read(kept_dir(&vault).join(&kept[0].file)).unwrap(), b"video");
        assert!(!finished.exists());
    }

    /// A list written before cards had keys still reads.
    #[test]
    fn a_kept_list_without_card_keys_reads() {
        let kept: Vec<KeptDownload> =
            serde_json::from_str(r#"[{"slug":"Cards/Film","video_id":"9KDDhAOyv9k","file":"a.mp4"}]"#).unwrap();
        assert_eq!(kept[0].card, None);
    }

    /// Б3.2: downloads that end at once all stay on the list.
    #[test]
    fn downloads_kept_at_the_same_time_are_all_listed() {
        const DOWNLOADS: usize = 16;
        let dir = tempfile::tempdir().unwrap();
        let vault = space_in(dir.path());
        let finished: Vec<PathBuf> =
            (0..DOWNLOADS).map(|index| finished_video(dir.path(), &format!("video-{index}.mp4"))).collect();
        let start = std::sync::Barrier::new(DOWNLOADS);
        std::thread::scope(|scope| {
            for (index, file) in finished.iter().enumerate() {
                let (vault, start) = (&vault, &start);
                scope.spawn(move || {
                    start.wait();
                    keep_download(vault, &format!("Cards/Film {index}"), None, "9KDDhAOyv9k", file).unwrap();
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
        let vault = space_in(dir.path());
        for index in 0..EACH {
            keep_download(&vault, &format!("Cards/Old {index}"), None, "9KDDhAOyv9k", &finished_video(dir.path(), &format!("old-{index}.mp4")))
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
                    keep_download(vault, &format!("Cards/New {index}"), None, "9KDDhAOyv9k", file).unwrap();
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
        let vault = space_in(dir.path());
        keep_download(&vault, "Cards/Film", None, "9KDDhAOyv9k", &finished_video(dir.path(), "joined.mp4")).unwrap();
        let kept = kept_downloads(&vault).remove(0);
        let file = kept_dir(&vault).join(&kept.file);

        for passing in [
            "database is locked",
            "'Cards/Film.md' changed outside Mine; nothing was written",
            "the card of this download was not found",
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
        let tools = Tools { ytdlp: crate::tool_process::ytdlp_in(&binaries), joiner: binaries.join("video-mux-helper") };
        // "Me at the zoo": 19 seconds, small in every format.
        let job = Job::new(VaultLayout::new(PathBuf::from("/space")), "jNQXAC9IVRw", "Cards/Zoo", None);
        let staging = tempfile::tempdir().unwrap();
        let mut states = Vec::new();
        let file = download_to_file(&job, &tools, staging.path(), |state| states.push(state))
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
        // Е2.5: a 403 names the likely cause, an outdated downloader.
        assert_eq!(
            failure_message("WARNING: x\nERROR: unable to download video data: HTTP Error 403: Forbidden\n"),
            "YouTube refused the download (HTTP 403). The bundled video downloader may be out of date."
        );
        assert_eq!(failure_message("ERROR: [youtube] abc: Sign in to confirm you’re not a bot"), "YouTube asked to sign in to confirm this is not a bot.");
        assert_eq!(failure_message("ERROR: Video unavailable"), "Video unavailable");
        assert_eq!(failure_message(""), "The video downloader stopped without a reason.");
    }
}
