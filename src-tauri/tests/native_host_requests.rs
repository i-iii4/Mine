//! The clipper's helper answers its short requests while a Save runs or the
//! folder chooser is open, and a failed folder chooser is told, not taken
//! for a cancel (SPEC_DEEP_AUDIT.md, Н9, Н11, Е4.2, Е4.5).
//!
//! The real helper binary runs with a home of its own and a stand-in
//! `osascript` first on its `PATH`, so nothing of the person's setup is read
//! or written and the real folder chooser never opens. A Save is held at the
//! operation journal by a lock the test takes, as a long download holds it.
//!
//! `MINE_NATIVE_HOST_UNDER_TEST` runs these against another helper binary,
//! one built before the fix among them.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

const SPACE_ID: &str = "0123456789abcdef0123456789abcdef";

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    responses: Receiver<serde_json::Value>,
    _root: tempfile::TempDir,
    root: PathBuf,
}

impl Helper {
    /// Start the helper with `osascript` standing for the folder chooser.
    fn start(osascript: &str) -> Self {
        let root_dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(root_dir.path()).unwrap();
        let host = root.join("native-host");
        let binary = std::env::var_os("MINE_NATIVE_HOST_UNDER_TEST")
            .map_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_native-host")), PathBuf::from);
        std::fs::copy(binary, &host).unwrap();
        let tools = root.join("bin");
        std::fs::create_dir(&tools).unwrap();
        let script = tools.join("osascript");
        std::fs::write(&script, format!("#!/bin/sh\n{osascript}\n")).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let home = root.join("home");
        std::fs::create_dir(&home).unwrap();
        let mut child = Command::new(&host)
            .env_clear()
            .env("HOME", &home)
            // The stand-in first, and no `/usr/bin`, where the real
            // `osascript` lives.
            .env("PATH", format!("{}:/bin", tools.display()))
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

    fn app_data(&self) -> PathBuf {
        self.root.join("home/Library/Application Support/com.mine.app")
    }

    /// A space with the collection `Art`, listed as Mine's current space.
    fn space(&self) -> String {
        let space = self.root.join("Space");
        for folder in [".mine", "Cards", "Media", "Collections"] {
            std::fs::create_dir_all(space.join(folder)).unwrap();
        }
        std::fs::write(space.join(".mine/vault-id"), SPACE_ID).unwrap();
        std::fs::write(
            space.join(".mine/layout.json"),
            r#"{"cards":"Cards","media":"Media","collections":"Collections"}"#,
        )
        .unwrap();
        std::fs::write(space.join("Collections/Art.md"), "---\ntype: channel\n---\n").unwrap();
        let path = space.to_string_lossy().into_owned();
        mine_lib::app_config::AppConfig::in_dir(&self.app_data())
            .update(|cfg| mine_lib::space_registry::record_open(cfg, SPACE_ID, &path, 1))
            .unwrap();
        path
    }

    fn send(&mut self, message: serde_json::Value) {
        let bytes = serde_json::to_vec(&message).unwrap();
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(&u32::try_from(bytes.len()).unwrap().to_le_bytes()).unwrap();
        stdin.write_all(&bytes).unwrap();
        stdin.flush().unwrap();
    }

    /// The answer to request `id`, within `within`. Signs of work for other
    /// requests are passed over.
    fn answer(&self, id: i64, within: Duration) -> serde_json::Value {
        let deadline = Instant::now() + within;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let response = self
                .responses
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("request {id} got no answer within {within:?}"));
            if response["_messageId"] == id && response.get("progress").is_none() {
                return response;
            }
        }
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Hold the operation journal of the space, as a Save that downloads holds it.
fn hold_journal(app_data: &Path) -> std::fs::File {
    use std::os::unix::io::AsRawFd;
    let journal = app_data.join("vaults/operations/v1").join(SPACE_ID);
    std::fs::create_dir_all(&journal).unwrap();
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(journal.join(".lock"))
        .unwrap();
    // SAFETY: the descriptor is open for the call.
    assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) }, 0);
    lock
}

/// Е4.2, Н9: a Save held at the journal does not hold the other requests:
/// the status, the collections, a new collection and a lookup all answer at
/// once, the lookup saying the space is busy. The Save then ends committed.
#[test]
fn short_requests_answer_while_a_save_runs() {
    let mut helper = Helper::start("exit 1");
    let space = helper.space();
    let held = hold_journal(&helper.app_data());

    helper.send(serde_json::json!({
        "action": "save_block", "_messageId": 1, "_progress": true,
        "vault_path": space, "binding_id": SPACE_ID, "operation_id": "held-save",
        "block_type": "link", "title": "Held", "url": "https://example.com", "body": "", "tags": [],
    }));
    std::thread::sleep(Duration::from_millis(300));
    let quick = Duration::from_secs(3);
    helper.send(serde_json::json!({ "action": "get_status", "_messageId": 2, "vault_path": space }));
    let status = helper.answer(2, quick);
    assert_eq!(status["folder_state"], "ready", "{status}");
    helper.send(serde_json::json!({ "action": "list_channels", "_messageId": 3, "vault_path": space }));
    let listed = helper.answer(3, quick);
    assert_eq!(listed["channels"][0]["tag"], "Art", "{listed}");
    helper.send(serde_json::json!({
        "action": "create_channel", "_messageId": 4, "vault_path": space, "tag": "Fresh",
    }));
    let created = helper.answer(4, quick);
    assert_eq!(created["ok"], true, "{created}");
    helper.send(serde_json::json!({
        "action": "get_save_operation", "_messageId": 5, "vault_path": space,
        "binding_id": SPACE_ID, "executor_id": "native", "operation_id": "held-save",
    }));
    let looked_up = helper.answer(5, quick);
    assert_eq!(looked_up["outcome"], "unknown", "{looked_up}");
    assert_eq!(looked_up["code"], "operation_busy", "{looked_up}");

    drop(held);
    let saved = helper.answer(1, Duration::from_secs(20));
    assert_eq!(saved["outcome"], "committed", "{saved}");
    assert!(Path::new(&space).join("Cards/Held.md").is_file());
}

/// Е4.2, Н9: the open folder chooser does not hold the other requests.
#[test]
fn the_status_answers_while_the_folder_chooser_is_open() {
    let mut helper = Helper::start("/bin/sleep 4\necho 'execution error: User canceled. (-128)' >&2\nexit 1");
    let space = helper.space();

    helper.send(serde_json::json!({ "action": "pick_vault_folder", "_messageId": 1 }));
    std::thread::sleep(Duration::from_millis(300));
    let started = Instant::now();
    helper.send(serde_json::json!({ "action": "get_status", "_messageId": 2, "vault_path": space }));
    let status = helper.answer(2, Duration::from_secs(3));
    assert_eq!(status["ok"], true, "{status}");
    assert!(started.elapsed() < Duration::from_secs(3));

    let picked = helper.answer(1, Duration::from_secs(10));
    assert_eq!(picked["cancelled"], true, "{picked}");
}

/// Е4.5, Е4.4: a folder chooser macOS did not let open is told with its
/// reason, not taken for a cancel, and the helper's journal has the line
/// with its time.
#[test]
fn a_failed_folder_chooser_is_told_and_journaled() {
    let mut helper = Helper::start(
        "echo '0:47: execution error: Not authorized to send Apple events to System Events. (-1743)' >&2\nexit 1",
    );
    helper.send(serde_json::json!({ "action": "pick_vault_folder", "_messageId": 1 }));
    let picked = helper.answer(1, Duration::from_secs(10));
    assert_eq!(picked["ok"], false, "{picked}");
    assert_eq!(picked["code"], "folder_chooser_failed", "{picked}");
    assert_eq!(
        picked["error"],
        "The folder chooser did not open: Not authorized to send Apple events to System Events. (-1743)"
    );
    let journal = std::fs::read_to_string(helper.root.join("home/Library/Logs/com.mine.app/native-host.log"))
        .expect("the helper keeps a journal");
    let line = journal
        .lines()
        .find(|line| line.contains("pick_vault_folder") && line.contains("-1743"))
        .unwrap_or_else(|| panic!("no journal line: {journal}"));
    assert_eq!(&line[10..11], "T", "{line}");
    assert_eq!(&line[19..20], ".", "{line}");
}
