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
    groups: Mutex<Groups>,
}

#[derive(Debug, Default)]
struct Groups {
    running: HashSet<libc::pid_t>,
    /// Whoever owns these tools stopped them for good: a tool that starts
    /// after that is killed as soon as it is listed (a Download Media cancel
    /// or the app quitting between a check and the start, Н3).
    closed: bool,
}

impl RunningTools {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn add(&self, group: libc::pid_t) {
        let mut groups = self.groups.lock().unwrap_or_else(PoisonError::into_inner);
        if groups.closed {
            drop(groups);
            kill_group(group);
            return;
        }
        groups.running.insert(group);
    }

    fn remove(&self, group: libc::pid_t) {
        self.groups
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .running
            .remove(&group);
    }

    /// Kill every tool still running, with whatever it started.
    pub fn kill_all(&self) {
        let groups: Vec<_> = self
            .groups
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .running
            .drain()
            .collect();
        for group in groups {
            kill_group(group);
        }
    }

    /// Kill every tool still running and every tool started from now on.
    pub fn close(&self) {
        self.groups.lock().unwrap_or_else(PoisonError::into_inner).closed = true;
        self.kill_all();
    }

    /// Whether [`RunningTools::close`] was called.
    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.groups.lock().unwrap_or_else(PoisonError::into_inner).closed
    }

    /// How many tools are running now.
    #[must_use]
    pub fn count(&self) -> usize {
        self.groups.lock().unwrap_or_else(PoisonError::into_inner).running.len()
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

/// How a tool that ran to its end ended: whether it succeeded, and what it
/// wrote. A tool that tells its own failures on stdout, in its own protocol,
/// is read here rather than through [`run_with_deadline`], which keeps only
/// stderr of a failed run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolExit {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
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
    let exit = run_to_exit(command, None, deadline, running)?;
    if exit.success {
        Ok(ToolOutput {
            stdout: exit.stdout,
            stderr: exit.stderr,
        })
    } else {
        Err(classify_failure(&exit.stderr))
    }
}

/// Run `command` to its end within `deadline`, as [`run_with_deadline`]
/// does, with `input` written to its stdin (none: an empty stdin), and tell
/// how it ended. Only a tool that did not run to its end is a failure here:
/// missing, killed on the deadline, or lost while waited on.
pub fn run_to_exit(
    command: &mut Command,
    input: Option<Vec<u8>>,
    deadline: Duration,
    running: &RunningTools,
) -> Result<ToolExit, ToolFailure> {
    let stdin = if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    };
    let mut child = command
        .stdin(stdin)
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
    // The input is written on a thread of its own: a tool that answers while
    // it reads would otherwise fill its stdout pipe and wait on us forever.
    // The writer ends when the input is written or the tool is gone.
    if let (Some(input), Some(mut pipe)) = (input, child.stdin.take()) {
        std::thread::spawn(move || {
            use std::io::Write;
            let _ = pipe.write_all(&input);
        });
    }
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
    Ok(ToolExit {
        success: status.success(),
        stdout,
        stderr,
    })
}

/// How long a tool run by [`run_lines`] may take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// The whole run, from the start.
    pub total: Option<Duration>,
    /// The longest silence: no line on stdout or stderr for this long ends
    /// the run. A long download keeps going while it reports progress.
    pub idle: Option<Duration>,
}

/// Run `command` to its end, handing every line it writes to stdout to
/// `on_line` as it comes, under `limits`: past either limit the whole group
/// is killed and the run is a [`ToolFailure::Timeout`] of the limit that
/// ended it. As [`run_to_exit`] does, the tool leads a process group of its
/// own, listed in `running`, so whoever owns `running` can end it at any
/// moment (`RunningTools::close`); a run ended that way reports how the
/// killed tool exited, and the owner, who knows it stopped the tool, says
/// what that means.
pub fn run_lines(
    command: &mut Command,
    limits: Limits,
    running: &RunningTools,
    mut on_line: impl FnMut(&str),
) -> Result<ToolExit, ToolFailure> {
    use std::io::BufRead;
    use std::sync::mpsc;

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
    // Lines of both pipes reach this thread; stderr is kept whole for the
    // failure, stdout goes to `on_line`. Either is a sign of life.
    enum Line {
        Out(String),
        Err(String),
    }
    let (lines, received) = mpsc::channel::<Line>();
    let readers: Vec<_> = [
        child.stdout.take().map(|pipe| (Box::new(pipe) as Box<dyn Read + Send>, true)),
        child.stderr.take().map(|pipe| (Box::new(pipe) as Box<dyn Read + Send>, false)),
    ]
    .into_iter()
    .flatten()
    .map(|(pipe, out)| {
        let lines = lines.clone();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(pipe).lines().map_while(Result::ok) {
                let sent = lines.send(if out { Line::Out(line) } else { Line::Err(line) });
                if sent.is_err() {
                    break;
                }
            }
        })
    })
    .collect();
    drop(lines);

    let mut stdout = String::new();
    let mut stderr = String::new();
    let started = Instant::now();
    let mut last_sign = Instant::now();
    let mut take = |line: Line, stdout: &mut String, stderr: &mut String| match line {
        Line::Out(line) => {
            on_line(&line);
            stdout.push_str(&line);
            stdout.push('\n');
        }
        Line::Err(line) => {
            stderr.push_str(&line);
            stderr.push('\n');
        }
    };
    let status = loop {
        let pipes_closed = match received.recv_timeout(POLL) {
            Ok(line) => {
                last_sign = Instant::now();
                take(line, &mut stdout, &mut stderr);
                continue;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => false,
            Err(mpsc::RecvTimeoutError::Disconnected) => true,
        };
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {
                let over = limits
                    .total
                    .filter(|total| started.elapsed() >= *total)
                    .or_else(|| limits.idle.filter(|idle| last_sign.elapsed() >= *idle));
                if let Some(limit) = over {
                    kill_group(group);
                    let _ = child.wait();
                    break Err(ToolFailure::Timeout(limit));
                }
                // Both pipes closed with the tool alive: wait without spinning.
                if pipes_closed {
                    std::thread::sleep(POLL);
                }
            }
            Err(error) => {
                kill_group(group);
                let _ = child.wait();
                break Err(ToolFailure::Failed(error.to_string()));
            }
        }
    };
    running.remove(group);
    // The group is gone: the readers reach the end of the pipes.
    for reader in readers {
        let _ = reader.join();
    }
    for line in received.try_iter() {
        take(line, &mut stdout, &mut stderr);
    }
    let status = status?;
    Ok(ToolExit {
        success: status.success(),
        stdout,
        stderr,
    })
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
        // The killed child is gone once the system has ended it; the deadline
        // only ends a test that would hang.
        let deadline = Instant::now() + Duration::from_secs(30);
        // SAFETY: signal 0 only asks whether the process exists.
        while unsafe { libc::kill(sleeper, 0) } == 0 {
            assert!(Instant::now() < deadline, "the tool's child survived");
            std::thread::sleep(Duration::from_millis(5));
        }
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
    fn a_tool_reads_its_input_and_tells_a_failure_on_stdout() {
        let running = RunningTools::new();
        // More input than a pipe holds, answered line by line while read.
        let input: String = (0..20_000).map(|n| format!("/space/Note {n}.md\n")).collect();
        let exit = run_to_exit(
            &mut shell("while read -r line; do echo \"$line\"; done; echo '{\"error\":\"x\"}'; exit 3"),
            Some(input.clone().into_bytes()),
            Duration::from_secs(20),
            &running,
        )
        .expect("the tool runs to its end");
        assert!(!exit.success);
        let mut lines: Vec<&str> = exit.stdout.lines().collect();
        assert_eq!(lines.pop(), Some("{\"error\":\"x\"}"));
        assert_eq!(lines.len(), 20_000);
        assert_eq!(lines[19_999], "/space/Note 19999.md");
        assert_eq!(running.count(), 0);
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
    fn run_lines_hands_every_line_over_as_it_comes() {
        let running = RunningTools::new();
        let mut seen = Vec::new();
        let exit = run_lines(
            &mut shell("echo one; echo warn >&2; echo two"),
            Limits { total: Some(Duration::from_secs(10)), idle: None },
            &running,
            |line| seen.push(line.to_owned()),
        )
        .expect("the tool runs to its end");
        assert!(exit.success);
        assert_eq!(seen, vec!["one", "two"]);
        assert_eq!(exit.stderr.trim(), "warn");
        assert_eq!(running.count(), 0);
    }

    /// Е2.4: a tool that stops saying anything is ended at its idle limit,
    /// while one that keeps talking runs past it.
    #[test]
    fn run_lines_ends_a_silent_tool_and_keeps_a_talking_one() {
        let running = RunningTools::new();
        let idle = Duration::from_millis(600);
        let limits = Limits { total: Some(Duration::from_secs(20)), idle: Some(idle) };
        let started = Instant::now();
        let silent = run_lines(&mut shell("echo start; /bin/sleep 30"), limits, &running, |_| {});
        assert_eq!(silent, Err(ToolFailure::Timeout(idle)));
        assert!(started.elapsed() < Duration::from_secs(10));
        let talking = run_lines(
            &mut shell("for n in 1 2 3 4 5; do echo $n; /bin/sleep 0.3; done"),
            limits,
            &running,
            |_| {},
        )
        .expect("a talking tool is not cut off");
        assert!(talking.success);
        assert_eq!(running.count(), 0);
    }

    /// Н3: tools closed for good are killed, and so is a tool listed after.
    #[test]
    fn closed_tools_kill_a_tool_that_starts_later() {
        let running = std::sync::Arc::new(RunningTools::new());
        running.close();
        let started = Instant::now();
        let exit = run_lines(
            &mut shell("/bin/sleep 30"),
            Limits { total: Some(Duration::from_secs(60)), idle: None },
            &running,
            |_| {},
        )
        .expect("the killed tool is reaped");
        assert!(!exit.success);
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(running.is_closed());
    }

    #[test]
    fn the_shipped_layout_puts_the_launcher_in_its_directory() {
        assert_eq!(
            ytdlp_in(Path::new("/pkg")),
            PathBuf::from("/pkg/yt-dlp-onedir/yt-dlp")
        );
    }
}
