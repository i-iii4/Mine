//! The clipper's helper keeps answering while an external tool runs, says
//! why a tool failed, and does not leave a stuck tool behind
//! (SPEC_CLIPPER.md, 3d, «Сбой утилиты видео», В1–В5).
//!
//! The real helper binary runs from a folder of its own, beside a stand-in
//! `yt-dlp-onedir/yt-dlp` script, with a home of its own, so nothing of the
//! person's setup is read or written.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    responses: Receiver<serde_json::Value>,
    _root: tempfile::TempDir,
    root: PathBuf,
}

impl Helper {
    /// Start the helper with `tool` as the body of its `yt-dlp`.
    fn start(tool: &str) -> Self {
        let root_dir = tempfile::tempdir().unwrap();
        let root = root_dir.path().to_path_buf();
        let host = root.join("native-host");
        std::fs::copy(env!("CARGO_BIN_EXE_native-host"), &host).unwrap();
        let ytdlp = root.join("yt-dlp-onedir");
        std::fs::create_dir(&ytdlp).unwrap();
        let script = ytdlp.join("yt-dlp");
        std::fs::write(&script, format!("#!/bin/sh\n{tool}\n")).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let home = root.join("home");
        std::fs::create_dir(&home).unwrap();
        let mut child = Command::new(&host)
            .env_clear()
            .env("HOME", &home)
            // The browser's minimal PATH: no yt-dlp on it.
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("TMPDIR", &root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let (sender, responses) = channel();
        std::thread::spawn(move || loop {
            let mut length = [0u8; 4];
            if stdout.read_exact(&mut length).is_err() {
                break;
            }
            let mut bytes = vec![0u8; u32::from_le_bytes(length) as usize];
            if stdout.read_exact(&mut bytes).is_err() {
                break;
            }
            if sender.send(serde_json::from_slice(&bytes).unwrap()).is_err() {
                break;
            }
        });
        let stdin = child.stdin.take();
        Self { child, stdin, responses, _root: root_dir, root }
    }

    fn send(&mut self, message: serde_json::Value) {
        let bytes = serde_json::to_vec(&message).unwrap();
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(&u32::try_from(bytes.len()).unwrap().to_le_bytes()).unwrap();
        stdin.write_all(&bytes).unwrap();
        stdin.flush().unwrap();
    }

    fn next(&self, within: Duration) -> serde_json::Value {
        self.responses.recv_timeout(within).expect("the helper answered in time")
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn wait_for(path: &Path, within: Duration) {
    let started = Instant::now();
    while !path.exists() {
        assert!(started.elapsed() < within, "{} never appeared", path.display());
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn the_helper_answers_other_requests_while_the_tool_runs() {
    let mut helper = Helper::start("/bin/sleep 2\necho 2026.08.19");
    helper.send(serde_json::json!({ "action": "video_tool_status", "_messageId": 1 }));
    helper.send(serde_json::json!({ "action": "list_known_vaults", "_messageId": 2 }));

    let started = Instant::now();
    let first = helper.next(Duration::from_secs(10));
    assert_eq!(first["_messageId"], 2, "the loop answered the second request first: {first}");
    assert!(started.elapsed() < Duration::from_millis(1500), "the second request waited for the tool");

    let second = helper.next(Duration::from_secs(10));
    assert_eq!(second["_messageId"], 1, "{second}");
    assert_eq!(second["ok"], true);
    assert_eq!(second["video_tool"]["state"], "ready");
    assert_eq!(second["video_tool"]["version"], "2026.08.19");

    // Remembered for the life of the helper: the second check answers at once.
    helper.send(serde_json::json!({ "action": "video_tool_status", "_messageId": 3 }));
    let started = Instant::now();
    let third = helper.next(Duration::from_secs(10));
    assert_eq!(third["_messageId"], 3);
    assert_eq!(third["video_tool"]["state"], "ready");
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn a_tool_macos_refuses_to_load_is_reported_as_blocked() {
    let mut helper = Helper::start(
        "echo \"[PYI-75737:ERROR] Failed to load Python shared library '/tmp/_MEI1/Python': library load disallowed by system policy\" >&2\nexit 1",
    );
    helper.send(serde_json::json!({ "action": "video_tool_status", "_messageId": 7 }));
    let response = helper.next(Duration::from_secs(15));
    assert_eq!(response["_messageId"], 7);
    assert_eq!(response["video_tool"]["state"], "unavailable");
    assert_eq!(response["video_tool"]["reason"], "blocked");
}

#[test]
fn a_tool_still_running_ends_with_the_helper() {
    let mut helper = Helper::start("echo $$ > \"$TMPDIR/tool.pid\"\nexec /bin/sleep 60");
    helper.send(serde_json::json!({ "action": "video_tool_status", "_messageId": 1 }));
    let pid_file = helper.path("tool.pid");
    wait_for(&pid_file, Duration::from_secs(10));
    let pid: libc::pid_t = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();

    // The browser closes the connection.
    drop(helper.stdin.take());
    let started = Instant::now();
    loop {
        if helper.child.try_wait().unwrap().is_some() {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(10), "the helper did not end");
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(100));
    // SAFETY: signal 0 only asks whether the process exists.
    assert_ne!(unsafe { libc::kill(pid, 0) }, 0, "the tool outlived the helper");
}
