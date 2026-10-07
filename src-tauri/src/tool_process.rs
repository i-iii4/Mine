//! External tools: where the shipped `yt-dlp` lives, and how a tool is run so
//! that its failure can never stop whoever started it.
//!
//! The case that shaped this (07.10.2026, SPEC_CLIPPER.md, 3d, «Сбой утилиты
//! видео»): the clipper's helper ran `yt-dlp` inline, with no deadline, while
//! macOS held the tool behind a Gatekeeper dialog. The helper answered
//! nothing else until the dialog went away, and the clipper hung. A tool here
//! runs as the leader of its own process group, under a deadline after which
//! the whole group is killed, and its failure comes back typed, so the caller
//! can say why and go on without it.

use std::collections::HashSet;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

/// The directory of the shipped `yt-dlp`, the vendor's unpacked build
/// (SPEC_ONBOARDING.md, О8.1): in the bundle's `binaries/` resources and in
/// the clipper's package. The same names are in `scripts/ytdlp-layout.mjs`.
pub const YTDLP_DIRECTORY: &str = "yt-dlp-onedir";
/// Its launcher, inside the directory.
pub const YTDLP_EXECUTABLE: &str = "yt-dlp";

/// The launcher of the `yt-dlp` directory that sits in `parent`.
#[must_use]
pub fn ytdlp_in(parent: &Path) -> PathBuf {
    parent.join(YTDLP_DIRECTORY).join(YTDLP_EXECUTABLE)
}

/// Why a tool gave no usable answer. `reason` is the protocol's word for it
/// (SPEC_CLIPPER.md, 3d, В3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolFailure {
    /// The tool is not there to start.
    Missing(String),
    /// macOS refused to load the tool's code.
    Blocked(String),
    /// The tool did not finish within its deadline and was killed.
    Timeout(Duration),
    /// The tool ran and failed: the first line it wrote to stderr.
    Failed(String),
}

impl ToolFailure {
    /// The protocol's `reason` for this failure.
    #[must_use]
    pub fn reason(&self) -> &'static str {
        match self {
            Self::Missing(_) => "missing",
            Self::Blocked(_) => "blocked",
            Self::Timeout(_) => "timeout",
            Self::Failed(_) => "failed",
        }
    }
}

impl std::fmt::Display for ToolFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing(detail) => write!(f, "the tool is not available: {detail}"),
            Self::Blocked(detail) => write!(f, "macOS blocked the tool: {detail}"),
            Self::Timeout(deadline) => {
                write!(f, "the tool did not finish within {} s", deadline.as_secs())
            }
            Self::Failed(detail) => write!(f, "the tool failed: {detail}"),
        }
    }
}

/// What a tool that exited successfully wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutput {
    pub stdout: String,
    pub stderr: String,
}

/// The process groups of tools still running, so whoever started them can end
/// them all when it ends itself: a tool stuck behind a system dialog must not
/// outlive the clipper's helper (SPEC_CLIPPER.md, 3d, В2).
#[derive(Debug, Default)]
pub struct RunningTools {
    groups: Mutex<HashSet<libc::pid_t>>,
}

impl RunningTools {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn add(&self, group: libc::pid_t) {
        self.groups
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(group);
    }

    fn remove(&self, group: libc::pid_t) {
        self.groups
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&group);
    }

    /// Kill every tool still running, with whatever it started.
    pub fn kill_all(&self) {
        let groups: Vec<_> = self
            .groups
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .drain()
            .collect();
        for group in groups {
            kill_group(group);
        }
    }

    /// How many tools are running now.
    #[must_use]
    pub fn count(&self) -> usize {
        self.groups.lock().unwrap_or_else(PoisonError::into_inner).len()
    }
}

/// Kill a process group, or the process alone when it has no group of its own.
fn kill_group(group: libc::pid_t) {
    // SAFETY: `killpg` and `kill` take plain integers and touch no memory. A
    // group is removed from `RunningTools` only after its leader was reaped,
    // so the id still names this tool's group while it is listed.
    unsafe {
        if libc::killpg(group, libc::SIGKILL) != 0 {
            libc::kill(group, libc::SIGKILL);
        }
    }
}

/// How often the deadline is checked while the tool runs.
const POLL: Duration = Duration::from_millis(25);

fn read_all(mut source: impl Read) -> String {
    let mut bytes = Vec::new();
    let _ = source.read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

/// The first non-empty line, cut to a length one status line can carry.
fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no output");
    let mut cut: String = line.chars().take(240).collect();
    if cut.len() < line.len() {
        cut.push('…');
    }
    cut
}

/// Read a failed run's stderr as a failure: a refusal of macOS to load the
/// tool's code is told apart, because it says the tool is unusable here, not
/// that this one request failed.
#[must_use]
pub fn classify_failure(stderr: &str) -> ToolFailure {
    let blocked = stderr.contains("disallowed by system policy")
        || stderr.contains("not valid for use in process");
    if blocked {
        ToolFailure::Blocked(first_line(stderr))
    } else {
        ToolFailure::Failed(first_line(stderr))
    }
}

/// Run `command` to its end within `deadline`.
///
/// The tool leads a process group of its own, listed in `running` while it
/// runs; on the deadline the group is killed. Its output is read on threads of
/// their own, so a full pipe never stalls it, and the reads end when the group
/// is gone, since nothing else holds the pipes.
pub fn run_with_deadline(
    command: &mut Command,
    deadline: Duration,
    running: &RunningTools,
) -> Result<ToolOutput, ToolFailure> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|error| ToolFailure::Missing(error.to_string()))?;
    let Ok(group) = libc::pid_t::try_from(child.id()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(ToolFailure::Failed("process id out of range".into()));
    };
    running.add(group);
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout = std::thread::spawn(move || stdout.map(read_all).unwrap_or_default());
    let stderr = std::thread::spawn(move || stderr.map(read_all).unwrap_or_default());

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() >= deadline => {
                kill_group(group);
                let _ = child.wait();
                break Err(ToolFailure::Timeout(deadline));
            }
            Ok(None) => std::thread::sleep(POLL),
            Err(error) => {
                kill_group(group);
                let _ = child.wait();
                break Err(ToolFailure::Failed(error.to_string()));
            }
        }
    };
    running.remove(group);
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    let status = status?;
    if status.success() {
        Ok(ToolOutput { stdout, stderr })
    } else {
        Err(classify_failure(&stderr))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(script);
        command
    }

    #[test]
    fn a_tool_that_finishes_gives_its_output() {
        let running = RunningTools::new();
        let output = run_with_deadline(&mut shell("echo 2026.08.19"), Duration::from_secs(5), &running)
            .expect("the tool finishes");
        assert_eq!(output.stdout.trim(), "2026.08.19");
        assert_eq!(running.count(), 0);
    }

    #[test]
    fn a_tool_past_its_deadline_is_killed_with_its_group() {
        let running = RunningTools::new();
        let marker = tempfile::NamedTempFile::new().unwrap();
        let script = format!(
            "/bin/sleep 30 & echo $! > '{}'; wait",
            marker.path().display()
        );
        let started = Instant::now();
        let failure = run_with_deadline(&mut shell(&script), Duration::from_millis(400), &running)
            .expect_err("the deadline ends the run");
        assert_eq!(failure, ToolFailure::Timeout(Duration::from_millis(400)));
        assert_eq!(failure.reason(), "timeout");
        assert!(started.elapsed() < Duration::from_secs(5), "the wait outlived the deadline");
        assert_eq!(running.count(), 0);
        // The sleeper the tool started went with it.
        let sleeper: libc::pid_t = std::fs::read_to_string(marker.path())
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        // SAFETY: signal 0 only asks whether the process exists.
        assert_ne!(unsafe { libc::kill(sleeper, 0) }, 0, "the tool's child survived");
    }

    #[test]
    fn a_missing_tool_and_a_refused_load_are_told_apart() {
        let running = RunningTools::new();
        let missing = run_with_deadline(
            &mut Command::new("/nonexistent/yt-dlp"),
            Duration::from_secs(5),
            &running,
        )
        .expect_err("nothing to start");
        assert_eq!(missing.reason(), "missing");

        let refused = run_with_deadline(
            &mut shell("echo \"[PYI-75737:ERROR] Failed to load Python shared library '/tmp/_MEI/Python': library load disallowed by system policy\" >&2; exit 1"),
            Duration::from_secs(5),
            &running,
        )
        .expect_err("the load was refused");
        assert_eq!(refused.reason(), "blocked");

        let failed = run_with_deadline(
            &mut shell("echo 'ERROR: [twitter] 1: No video could be found in this tweet' >&2; exit 1"),
            Duration::from_secs(5),
            &running,
        )
        .expect_err("the tool failed");
        assert_eq!(
            failed,
            ToolFailure::Failed("ERROR: [twitter] 1: No video could be found in this tweet".into())
        );
    }

    #[test]
    fn kill_all_ends_every_running_tool() {
        let running = std::sync::Arc::new(RunningTools::new());
        let worker = {
            let running = running.clone();
            std::thread::spawn(move || {
                run_with_deadline(&mut shell("/bin/sleep 30"), Duration::from_secs(60), &running)
            })
        };
        let started = Instant::now();
        while running.count() == 0 {
            assert!(started.elapsed() < Duration::from_secs(5), "the tool never started");
            std::thread::sleep(Duration::from_millis(10));
        }
        running.kill_all();
        let result = worker.join().unwrap();
        assert!(result.is_err(), "a killed tool is not a success");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn the_shipped_layout_puts_the_launcher_in_its_directory() {
        assert_eq!(
            ytdlp_in(Path::new("/pkg")),
            PathBuf::from("/pkg/yt-dlp-onedir/yt-dlp")
        );
    }
}
