//! ВК13: the check pass, the list and the resolution against a stand-in
//! helper, a script that answers set JSON. A real conflict cannot be made
//! outside a live iCloud.

use std::collections::BTreeSet;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde_json::json;

use super::*;
use crate::storage::{db, index, vault_conflicts};

const NOTE: &str = "---\nsaved_at: 2026-10-01T00:00:00Z\n---\n# Note\n\nIn the folder\n";
const VERSION_A: &str = "---\nsaved_at: 2026-10-01T00:00:00Z\n---\n# Note\n\nFrom the laptop\n";
const VERSION_B: &str = "---\nsaved_at: 2026-10-01T00:00:00Z\n---\n# Note\n\nFrom the phone\n";

const SCRIPT: &str = r#"#!/bin/sh
dir='@DIR@'
case "$1" in
scan)
  cat > "$dir/scan-input"
  cat "$dir/scan.jsonl"
  ;;
read)
  if [ -f "$dir/edit-on-read" ]; then printf ' edited meanwhile' >> "$2"; fi
  if [ -f "$dir/versions/$3" ]; then
    cp "$dir/versions/$3" "$4"
    printf '{"sha256":"%s"}\n' "$(cat "$dir/versions/$3.sha")"
  else
    echo '{"error":"version_missing","message":"the version is gone"}'
    exit 1
  fi
  ;;
settle)
  if [ -f "$dir/settle-fails" ]; then
    rm "$dir/settle-fails"
    echo '{"error":"remove_failed","message":"refused"}'
    exit 1
  fi
  shift
  echo "$*" >> "$dir/settled.log"
  echo '{"settled":[],"missing":[]}'
  ;;
*)
  exit 2
  ;;
esac
"#;

/// A space, its index and a stand-in helper.
struct Fixture {
    _dir: tempfile::TempDir,
    helper_dir: PathBuf,
    vault: VaultLayout,
    conn: Connection,
    helper: ConflictsHelper,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let helper_dir = dir.path().join("helper");
        std::fs::create_dir_all(helper_dir.join("versions")).unwrap();
        let script = helper_dir.join("icloud-conflicts-helper");
        std::fs::write(&script, SCRIPT.replace("@DIR@", &helper_dir.to_string_lossy())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let vault = VaultLayout::with_derived_root(dir.path().join("space"), dir.path().join("derived"));
        std::fs::create_dir_all(vault.root()).unwrap();
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        std::fs::write(helper_dir.join("scan.jsonl"), done_line(&[])).unwrap();
        Self {
            _dir: dir,
            helper_dir,
            vault,
            conn,
            helper: ConflictsHelper::new(script),
        }
    }

    fn note(&self, relative: &str, text: &str) -> PathBuf {
        let path = self.vault.root().join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        path
    }

    /// The helper's answer to the next scans.
    fn answer_scan(&self, lines: &[serde_json::Value], failed: &[&Path]) {
        let mut text: String = lines.iter().map(|line| format!("{line}\n")).collect();
        text.push_str(&done_line(failed));
        std::fs::write(self.helper_dir.join("scan.jsonl"), text).unwrap();
    }

    fn version(&self, token: &str, bytes: &str) {
        let versions = self.helper_dir.join("versions");
        std::fs::write(versions.join(token), bytes).unwrap();
        std::fs::write(versions.join(format!("{token}.sha")), sha256_hex(bytes.as_bytes())).unwrap();
    }

    fn fail_next_settle(&self) {
        std::fs::write(self.helper_dir.join("settle-fails"), "").unwrap();
    }

    fn edit_on_read(&self) {
        std::fs::write(self.helper_dir.join("edit-on-read"), "").unwrap();
    }

    fn settled(&self) -> Vec<String> {
        std::fs::read_to_string(self.helper_dir.join("settled.log"))
            .map(|text| text.lines().map(str::to_string).collect())
            .unwrap_or_default()
    }

    fn scan_input(&self) -> Vec<String> {
        std::fs::read_to_string(self.helper_dir.join("scan-input"))
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn record(&self, paths: &[&str]) {
        let set: BTreeSet<String> = paths.iter().map(|path| (*path).to_string()).collect();
        vault_conflicts::apply_check(
            &self.conn,
            CheckResult {
                checked: &set,
                found: &set,
                inventory: None,
            },
            "2026-10-11T09:00:00Z",
        )
        .unwrap();
    }

    /// Every file of the space, from its root, sorted.
    fn files(&self) -> Vec<String> {
        files::scan_vault_file_paths(&self.vault).unwrap()
    }

    fn read(&self, relative: &str) -> String {
        std::fs::read_to_string(self.vault.root().join(relative)).unwrap()
    }

    fn resolve(&self, path: &str, choice: ConflictChoice, tokens: &[&str]) -> Result<Resolution, VaultConflictError> {
        let tokens: Vec<String> = tokens.iter().map(|token| (*token).to_string()).collect();
        resolve_conflict(
            &self.conn,
            &self.vault,
            &self.helper,
            ResolveRequest {
                path,
                choice: &choice,
                expected_tokens: &tokens,
            },
            &|_| {},
        )
    }

    /// A conflict of `relative` with the versions `tok-a` (laptop) and
    /// `tok-b` (no device), recorded and answered by the helper.
    fn conflict(&self, relative: &str) -> PathBuf {
        let path = self.note(relative, NOTE);
        self.version("tok-a", VERSION_A);
        self.version("tok-b", VERSION_B);
        self.answer_scan(&[conflict_line(&path)], &[]);
        self.record(&[relative]);
        path
    }
}

fn done_line(failed: &[&Path]) -> String {
    let failed: Vec<String> = failed.iter().map(|path| path.to_string_lossy().into_owned()).collect();
    format!("{}\n", json!({ "done": true, "checked": 0, "failed": failed }))
}

fn conflict_line(path: &Path) -> serde_json::Value {
    json!({
        "path": path.to_string_lossy(),
        "current": { "modified": "2026-10-11T08:00:00Z", "device": null },
        "versions": [
            { "token": "tok-a", "modified": "2026-10-10T12:54:00Z", "device": "i_iii’s MacBook Pro" },
            { "token": "tok-b", "modified": "2026-10-09T07:05:00Z", "device": null },
        ],
    })
}

/// The stem ВК9 gives a version, by the same local time rule.
fn separate_name(name: &str, device: &str, modified: &str) -> String {
    let minute = local_minute(modified).unwrap();
    format!("{name} ({device} {minute}).md")
}

// ─── Signals and protocol ───────────────────────────────────────────────────

#[test]
fn a_space_in_icloud_drive_is_told_by_its_path() {
    assert!(is_icloud_space(Path::new(
        "/Users/someone/Library/Mobile Documents/iCloud~md~obsidian/Documents/Space"
    )));
    assert!(!is_icloud_space(Path::new("/tmp/mine-space-outside-icloud")));
}

#[test]
fn scopes_merge_into_one_pass() {
    let a = CheckScope::Paths(BTreeSet::from([PathBuf::from("/s/A.md")]));
    let b = CheckScope::Paths(BTreeSet::from([PathBuf::from("/s/B.md")]));
    assert_eq!(
        a.clone().merge(b),
        CheckScope::Paths(BTreeSet::from([PathBuf::from("/s/A.md"), PathBuf::from("/s/B.md")]))
    );
    assert_eq!(a.merge(CheckScope::Full), CheckScope::Full);
}

#[test]
fn a_scan_without_its_last_line_is_refused_and_a_told_failure_is_kept() {
    let fixture = Fixture::new();
    let path = fixture.note("Note.md", NOTE);
    std::fs::write(fixture.helper_dir.join("scan.jsonl"), "").unwrap();
    assert!(matches!(
        fixture.helper.scan(std::slice::from_ref(&path)),
        Err(HelperError::Protocol(_))
    ));

    let refused = fixture.helper.read(&path, "tok-gone", &fixture.helper_dir.join("copy.md"));
    assert!(
        matches!(&refused, Err(HelperError::Answered { kind, .. }) if kind == VERSION_MISSING),
        "{refused:?}"
    );
}

// ─── The check pass (ВК4, ВК6) ──────────────────────────────────────────────

#[test]
fn a_full_pass_records_what_the_helper_found_and_forgets_the_rest() {
    let fixture = Fixture::new();
    let conflicted = fixture.note("Cards/Note.md", NOTE);
    let unanswered = fixture.note("Cards/Busy.md", NOTE);
    fixture.note("Plain.md", NOTE);
    fixture.record(&["Gone.md", "Plain.md", "Cards/Busy.md"]);
    fixture.answer_scan(&[conflict_line(&conflicted)], &[&unanswered]);

    let outcome = run_check(
        &fixture.conn,
        &fixture.vault,
        &fixture.helper,
        &CheckScope::Full,
        "2026-10-11T10:00:00Z",
    )
    .unwrap();

    assert_eq!(outcome, CheckOutcome { changed: true, count: 2 });
    let mut asked = fixture.scan_input();
    asked.sort();
    let mut expected: Vec<String> = ["Cards/Busy.md", "Cards/Note.md", "Plain.md"]
        .iter()
        .map(|relative| fixture.vault.root().join(relative).to_string_lossy().into_owned())
        .collect();
    expected.sort();
    assert_eq!(asked, expected);
    assert_eq!(
        vault_conflicts::list_conflict_paths(&fixture.conn).unwrap(),
        vec!["Cards/Note.md", "Cards/Busy.md"]
    );
}

#[test]
fn a_watcher_batch_checks_only_its_notes() {
    let fixture = Fixture::new();
    let changed = fixture.note("Cards/Note.md", NOTE);
    fixture.record(&["Other.md"]);
    fixture.answer_scan(&[conflict_line(&changed)], &[]);
    let media = fixture.vault.root().join("Media/photo.jpg");

    let outcome = run_check(
        &fixture.conn,
        &fixture.vault,
        &fixture.helper,
        &CheckScope::Paths(BTreeSet::from([changed.clone(), media])),
        "2026-10-11T10:00:00Z",
    )
    .unwrap();

    assert_eq!(outcome, CheckOutcome { changed: true, count: 2 });
    assert_eq!(fixture.scan_input(), vec![changed.to_string_lossy().into_owned()]);
}

// ─── The list (ВК7) ─────────────────────────────────────────────────────────

#[test]
fn the_list_reads_versions_again_and_drops_conflicts_resolved_elsewhere() {
    let fixture = Fixture::new();
    let conflicted = fixture.note("Cards/Note.md", NOTE);
    let unanswered = fixture.note("Busy.md", NOTE);
    fixture.note("Resolved.md", NOTE);
    fixture.record(&["Cards/Note.md", "Busy.md", "Resolved.md"]);
    fixture.answer_scan(&[conflict_line(&conflicted)], &[&unanswered]);

    let list = list_conflicts(&fixture.conn, &fixture.vault, &fixture.helper).unwrap();

    assert_eq!(list.removed, vec!["Resolved.md"]);
    assert_eq!(list.conflicts.len(), 1);
    let conflict = &list.conflicts[0];
    assert_eq!((conflict.path.as_str(), conflict.name.as_str()), ("Cards/Note.md", "Note"));
    assert_eq!(conflict.current.token, None);
    assert_eq!(conflict.current.modified.as_deref(), Some("2026-10-11T08:00:00Z"));
    assert_eq!(conflict.versions.len(), 2);
    assert_eq!(
        vault_conflicts::list_conflict_paths(&fixture.conn).unwrap(),
        vec!["Busy.md", "Cards/Note.md"]
    );
}

// ─── The resolution (ВК8, ВК9) ──────────────────────────────────────────────

#[test]
fn keeping_the_version_in_the_folder_trashes_the_others_in_both_layouts() {
    for relative in ["Note.md", "Cards/Note.md"] {
        let fixture = Fixture::new();
        fixture.conflict(relative);
        let folder = relative.strip_suffix("Note.md").unwrap();

        let resolution = fixture
            .resolve(relative, ConflictChoice::KeepVersion { token: None }, &["tok-a", "tok-b"])
            .unwrap();

        assert_eq!(fixture.read(relative), NOTE);
        assert_eq!(fixture.files(), vec![relative.to_string()], "{relative}");
        assert_eq!(
            resolution.trashed,
            vec![
                format!("{folder}{}", separate_name("Note", "i_iii’s MacBook Pro", "2026-10-10T12:54:00Z")),
                format!("{folder}{}", separate_name("Note", "another device", "2026-10-09T07:05:00Z")),
            ]
        );
        assert!(resolution.kept_separately.is_empty());
        assert_eq!(fixture.settled(), vec![format!("{} tok-a tok-b", fixture.vault.root().join(relative).display())]);
        assert!(vault_conflicts::list_conflict_paths(&fixture.conn).unwrap().is_empty());
    }
}

#[test]
fn keeping_a_hidden_version_puts_it_in_the_note_in_both_layouts() {
    for relative in ["Note.md", "Cards/Note.md"] {
        let fixture = Fixture::new();
        fixture.conflict(relative);
        let folder = relative.strip_suffix("Note.md").unwrap();

        let resolution = fixture
            .resolve(
                relative,
                ConflictChoice::KeepVersion { token: Some("tok-a".into()) },
                &["tok-b", "tok-a"],
            )
            .unwrap();

        assert_eq!(fixture.read(relative), VERSION_A);
        assert_eq!(fixture.files(), vec![relative.to_string()], "{relative}");
        // The note's former bytes are named by the version in the folder,
        // and go to the Trash with the version not kept.
        assert_eq!(
            resolution.trashed,
            vec![
                format!("{folder}{}", separate_name("Note", "another device", "2026-10-11T08:00:00Z")),
                format!("{folder}{}", separate_name("Note", "another device", "2026-10-09T07:05:00Z")),
            ]
        );
        let slug = relative.strip_suffix(".md").unwrap();
        let indexed = index::get_block(&fixture.conn, slug).unwrap().expect("the note is indexed");
        assert!(indexed.body.contains("From the laptop"), "{}", indexed.body);
        assert!(vault_conflicts::list_conflict_paths(&fixture.conn).unwrap().is_empty());
    }
}

#[test]
fn keeping_all_puts_every_version_next_to_the_note_in_both_layouts() {
    for relative in ["Note.md", "Cards/Note.md"] {
        let fixture = Fixture::new();
        fixture.conflict(relative);
        let folder = relative.strip_suffix("Note.md").unwrap();

        let resolution = fixture
            .resolve(relative, ConflictChoice::KeepAll, &["tok-a", "tok-b"])
            .unwrap();

        let laptop = format!("{folder}{}", separate_name("Note", "i_iii’s MacBook Pro", "2026-10-10T12:54:00Z"));
        let unknown = format!("{folder}{}", separate_name("Note", "another device", "2026-10-09T07:05:00Z"));
        assert_eq!(fixture.read(relative), NOTE);
        assert_eq!(fixture.read(&laptop), VERSION_A);
        assert_eq!(fixture.read(&unknown), VERSION_B);
        assert_eq!(resolution.kept_separately, vec![laptop.clone(), unknown.clone()]);
        assert!(resolution.trashed.is_empty());
        for separate in [&laptop, &unknown] {
            let slug = separate.strip_suffix(".md").unwrap();
            assert!(index::get_block(&fixture.conn, slug).unwrap().is_some(), "{slug}");
        }
        assert!(vault_conflicts::list_conflict_paths(&fixture.conn).unwrap().is_empty());
    }
}

#[test]
fn a_taken_name_gives_the_separate_note_a_free_one() {
    let fixture = Fixture::new();
    fixture.conflict("Cards/Note.md");
    let laptop = separate_name("Note", "i_iii’s MacBook Pro", "2026-10-10T12:54:00Z");
    // The same name elsewhere in the space takes it too: names are unique
    // in the whole space.
    fixture.note(&format!("Archive/{laptop}"), "someone's note");

    let resolution = fixture.resolve("Cards/Note.md", ConflictChoice::KeepAll, &["tok-a", "tok-b"]).unwrap();

    let expected = format!("Cards/{} (2).md", laptop.strip_suffix(".md").unwrap());
    assert_eq!(resolution.kept_separately[0], expected);
    assert_eq!(fixture.read(&expected), VERSION_A);
    assert_eq!(fixture.read(&format!("Archive/{laptop}")), "someone's note");
}

#[test]
fn a_note_edited_after_it_was_read_refuses_and_changes_nothing() {
    let fixture = Fixture::new();
    fixture.conflict("Cards/Note.md");
    fixture.edit_on_read();

    let refused = fixture.resolve(
        "Cards/Note.md",
        ConflictChoice::KeepVersion { token: Some("tok-a".into()) },
        &["tok-a", "tok-b"],
    );

    assert!(matches!(refused, Err(VaultConflictError::SourceChanged { .. })), "{refused:?}");
    assert!(fixture.read("Cards/Note.md").ends_with(" edited meanwhile"));
    assert_eq!(fixture.files(), vec!["Cards/Note.md"]);
    assert!(fixture.settled().is_empty());
    assert_eq!(vault_conflicts::list_conflict_paths(&fixture.conn).unwrap(), vec!["Cards/Note.md"]);
}

#[test]
fn other_versions_than_the_window_showed_refuse_and_change_nothing() {
    let fixture = Fixture::new();
    fixture.conflict("Cards/Note.md");

    for shown in [&["tok-a"][..], &["tok-a", "tok-b", "tok-c"][..]] {
        let refused = fixture.resolve("Cards/Note.md", ConflictChoice::KeepAll, shown);
        assert!(matches!(refused, Err(VaultConflictError::VersionsChanged { .. })), "{refused:?}");
    }
    let refused = fixture.resolve(
        "Cards/Note.md",
        ConflictChoice::KeepVersion { token: Some("tok-c".into()) },
        &["tok-a", "tok-b"],
    );
    assert!(matches!(refused, Err(VaultConflictError::VersionsChanged { .. })), "{refused:?}");

    assert_eq!(fixture.read("Cards/Note.md"), NOTE);
    assert_eq!(fixture.files(), vec!["Cards/Note.md"]);
    assert!(fixture.settled().is_empty());
    assert_eq!(vault_conflicts::list_conflict_paths(&fixture.conn).unwrap(), vec!["Cards/Note.md"]);
}

#[test]
fn a_failed_settle_keeps_the_conflict_and_the_retry_passes() {
    let fixture = Fixture::new();
    fixture.conflict("Cards/Note.md");
    fixture.fail_next_settle();
    let keep_laptop = || ConflictChoice::KeepVersion { token: Some("tok-a".into()) };

    let failed = fixture.resolve("Cards/Note.md", keep_laptop(), &["tok-a", "tok-b"]);

    assert!(matches!(failed, Err(VaultConflictError::HelperFailed { .. })), "{failed:?}");
    assert_eq!(fixture.read("Cards/Note.md"), VERSION_A);
    assert_eq!(vault_conflicts::list_conflict_paths(&fixture.conn).unwrap(), vec!["Cards/Note.md"]);

    fixture.resolve("Cards/Note.md", keep_laptop(), &["tok-a", "tok-b"]).unwrap();

    assert_eq!(fixture.read("Cards/Note.md"), VERSION_A);
    assert_eq!(fixture.files(), vec!["Cards/Note.md"]);
    assert_eq!(fixture.settled().len(), 1);
    assert!(vault_conflicts::list_conflict_paths(&fixture.conn).unwrap().is_empty());
}

#[test]
fn only_a_recorded_note_of_the_space_is_resolved() {
    let fixture = Fixture::new();
    fixture.conflict("Cards/Note.md");
    fixture.note("Other.md", NOTE);

    for path in ["", "/etc/hosts.md", "../Note.md", "Cards/../Note.md", "Cards/Note.txt"] {
        let refused = fixture.resolve(path, ConflictChoice::KeepAll, &["tok-a", "tok-b"]);
        assert!(matches!(refused, Err(VaultConflictError::InvalidPath { .. })), "{path}: {refused:?}");
    }
    let refused = fixture.resolve("Other.md", ConflictChoice::KeepAll, &["tok-a", "tok-b"]);
    assert!(matches!(refused, Err(VaultConflictError::NotPending { .. })), "{refused:?}");
}

#[test]
fn a_separate_note_is_named_by_device_and_local_minute() {
    let laptop = ConflictVersion {
        token: Some("t".into()),
        modified: Some("2026-10-10T12:54:30Z".into()),
        device: Some("Mac: Studio".into()),
    };
    let stem = separate_stem("Note", &laptop);
    let minute = local_minute("2026-10-10T12:54:30Z").unwrap();
    assert_eq!(stem, format!("Note (Mac Studio {minute})"));
    assert_eq!(minute.len(), "2026-10-10 12-54".len());
    assert_eq!(&minute[10..11], " ");
    assert_eq!(&minute[13..14], "-");

    let unknown = ConflictVersion {
        token: Some("t".into()),
        modified: None,
        device: None,
    };
    assert_eq!(separate_stem("Note", &unknown), "Note (another device)");
}
