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
  path="$1"
  shift
  echo "$path $*" >> "$dir/settled.log"
  if [ -f "$dir/settle-partial" ]; then
    printf '{"settled":["%s"],"missing":[]}\n' "$1"
  else
    printf '{"settled":['
    sep=''
    for token in "$@"; do printf '%s"%s"' "$sep" "$token"; sep=','; done
    printf '],"missing":[]}\n'
  fi
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

    /// The next settles report the first version settled and say nothing
    /// of the others.
    fn settle_partly(&self) {
        std::fs::write(self.helper_dir.join("settle-partial"), "").unwrap();
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
fn a_folder_outside_icloud_is_no_icloud_space() {
    assert!(!is_icloud_space(Path::new("/tmp/mine-space-outside-icloud")));
}

/// Н7, Е5.2: a folder whose path merely holds `Mobile Documents` is not in
/// iCloud; the system says which folders are.
#[test]
fn a_folder_merely_named_mobile_documents_is_no_icloud_space() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("Mobile Documents").join("Space");
    std::fs::create_dir_all(&folder).unwrap();
    assert!(!is_icloud_space(&folder));
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
    assert_eq!(list.conflicts.len(), 2);
    let conflict = list
        .conflicts
        .iter()
        .find(|conflict| conflict.path == "Cards/Note.md")
        .unwrap();
    assert_eq!(conflict.name, "Note");
    assert!(!conflict.unanswered);
    assert_eq!(conflict.current.token, None);
    assert_eq!(conflict.current.modified.as_deref(), Some("2026-10-11T08:00:00Z"));
    assert_eq!(conflict.versions.len(), 2);
    // Е5.12: the note iCloud did not answer about is listed without versions.
    let busy = list.conflicts.iter().find(|conflict| conflict.path == "Busy.md").unwrap();
    assert!(busy.unanswered);
    assert!(busy.versions.is_empty());
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

// ─── Е5.10 by Е5.12 ─────────────────────────────────────────────────────────

/// Е5.10: `Keep all` writes the separate notes before the settle; a settle
/// that fails and the retry that follows leave one set of them, not two.
#[test]
fn keeping_all_again_after_a_failed_settle_makes_one_set_of_separate_notes() {
    let fixture = Fixture::new();
    fixture.conflict("Cards/Note.md");
    fixture.fail_next_settle();

    let failed = fixture.resolve("Cards/Note.md", ConflictChoice::KeepAll, &["tok-a", "tok-b"]);
    assert!(matches!(failed, Err(VaultConflictError::HelperFailed { .. })), "{failed:?}");

    let resolution = fixture
        .resolve("Cards/Note.md", ConflictChoice::KeepAll, &["tok-a", "tok-b"])
        .unwrap();

    let laptop = format!("Cards/{}", separate_name("Note", "i_iii’s MacBook Pro", "2026-10-10T12:54:00Z"));
    let unknown = format!("Cards/{}", separate_name("Note", "another device", "2026-10-09T07:05:00Z"));
    let mut expected = vec!["Cards/Note.md".to_string(), laptop.clone(), unknown.clone()];
    expected.sort();
    assert_eq!(fixture.files(), expected);
    assert_eq!(resolution.kept_separately, vec![laptop, unknown]);
    assert!(vault_conflicts::list_conflict_paths(&fixture.conn).unwrap().is_empty());
}

/// Е5.11: one line of the helper's answer Mine cannot read does not fail the
/// pass. The conflicts it read are recorded; a note the answer may have been
/// about keeps what Mine knew of it.
#[test]
fn a_line_mine_cannot_read_does_not_fail_the_pass() {
    let fixture = Fixture::new();
    let conflicted = fixture.note("Cards/Note.md", NOTE);
    fixture.note("Busy.md", NOTE);
    fixture.record(&["Busy.md"]);
    let mut text = format!("{}\n", conflict_line(&conflicted));
    text.push_str("{\"path\": \"half a line\n");
    text.push_str(&done_line(&[]));
    std::fs::write(fixture.helper_dir.join("scan.jsonl"), text).unwrap();

    let outcome = run_check(
        &fixture.conn,
        &fixture.vault,
        &fixture.helper,
        &CheckScope::Full,
        "2026-10-11T10:00:00Z",
    )
    .unwrap();

    assert_eq!(outcome.count, 2);
    assert_eq!(
        vault_conflicts::list_conflict_paths(&fixture.conn).unwrap(),
        vec!["Cards/Note.md", "Busy.md"]
    );
}

/// Е5.11: the settle's report is read. Versions it neither settled nor
/// found gone are still conflict versions: the conflict stays recorded and
/// the resolution says iCloud did not settle them.
#[test]
fn a_settle_that_leaves_versions_keeps_the_conflict() {
    let fixture = Fixture::new();
    fixture.conflict("Cards/Note.md");
    fixture.settle_partly();

    let refused = fixture.resolve(
        "Cards/Note.md",
        ConflictChoice::KeepVersion { token: None },
        &["tok-a", "tok-b"],
    );

    assert!(matches!(refused, Err(VaultConflictError::HelperFailed { .. })), "{refused:?}");
    assert_eq!(vault_conflicts::list_conflict_paths(&fixture.conn).unwrap(), vec!["Cards/Note.md"]);
}

/// Е5.12: a recorded conflict the helper cannot answer for is in the list:
/// the notice counts it, so the window shows it, with no versions to keep.
#[test]
fn a_conflict_the_helper_cannot_answer_for_is_listed() {
    let fixture = Fixture::new();
    let conflicted = fixture.note("Cards/Note.md", NOTE);
    let unanswered = fixture.note("Busy.md", NOTE);
    fixture.record(&["Cards/Note.md", "Busy.md"]);
    fixture.answer_scan(&[conflict_line(&conflicted)], &[&unanswered]);

    let list = list_conflicts(&fixture.conn, &fixture.vault, &fixture.helper).unwrap();

    let paths: Vec<&str> = list.conflicts.iter().map(|conflict| conflict.path.as_str()).collect();
    assert_eq!(paths.len(), vault_conflicts::list_conflict_paths(&fixture.conn).unwrap().len());
    assert!(paths.contains(&"Busy.md"), "{paths:?}");
}

// ─── The real helper (Е7.3) ─────────────────────────────────────────────────
//
// The tests above run a stand-in script. These run the Swift helper the build
// compiles, on temporary files outside iCloud: what it can show without a
// second device is its protocol, its answer for notes without conflicts, its
// refusal of a version it does not have and a helper that cannot start.

/// The helper the build compiled for the app's bundle.
#[cfg(target_os = "macos")]
fn real_helper() -> ConflictsHelper {
    let executable = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join(HELPER_NAME);
    assert!(executable.is_file(), "the build left no helper at {}", executable.display());
    ConflictsHelper::new(executable)
}

/// A space of plain local notes, among them a name the system may store
/// decomposed, and its index.
#[cfg(target_os = "macos")]
fn local_space() -> (tempfile::TempDir, VaultLayout, Connection, Vec<PathBuf>) {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let vault = VaultLayout::with_derived_root(root.join("space"), root.join("derived"));
    let notes: Vec<PathBuf> = ["Cards/Note.md", "Cards/Café ü.md", "Plain note.md"]
        .iter()
        .map(|relative| {
            let path = vault.root().join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, NOTE).unwrap();
            path
        })
        .collect();
    let conn = db::open_or_create(&vault.index_db_path()).unwrap();
    (dir, vault, conn, notes)
}

#[cfg(target_os = "macos")]
#[test]
fn the_real_helper_finds_no_conflict_in_local_notes() {
    let (_dir, vault, conn, notes) = local_space();
    let mut asked = notes.clone();
    // A note gone since it was listed has no conflict either.
    asked.push(vault.root().join("Gone.md"));

    let report = real_helper().scan(&asked).unwrap();

    assert_eq!(report, ScanReport::default());
    let outcome = run_check(&conn, &vault, &real_helper(), &CheckScope::Full, "2026-10-13T00:00:00Z")
        .unwrap();
    assert!(!outcome.changed);
    assert_eq!(outcome.count, 0);
}

/// A conflict Mine recorded whose versions are gone, as after a resolution
/// on another device, leaves the table when the real helper finds none.
#[cfg(target_os = "macos")]
#[test]
fn the_real_helper_clears_a_conflict_that_has_no_versions_any_more() {
    let (_dir, vault, conn, _notes) = local_space();
    let set: BTreeSet<String> = ["Cards/Note.md".to_string()].into();
    vault_conflicts::apply_check(
        &conn,
        CheckResult { checked: &set, found: &set, inventory: None },
        "2026-10-12T00:00:00Z",
    )
    .unwrap();

    let list = list_conflicts(&conn, &vault, &real_helper()).unwrap();

    assert!(list.conflicts.is_empty(), "{list:?}");
    assert_eq!(list.removed, vec!["Cards/Note.md".to_string()]);
    assert!(vault_conflicts::list_conflict_paths(&conn).unwrap().is_empty());
}

/// A token that is no conflict version of the file is refused by `read` with
/// the kind Mine turns into «the versions changed», and is reported missing
/// by `settle`, which removes nothing.
#[cfg(target_os = "macos")]
#[test]
fn the_real_helper_refuses_a_version_it_does_not_have() {
    let (dir, _vault, _conn, notes) = local_space();
    let note = &notes[0];
    let token = "bm90IGEgdmVyc2lvbg==";
    let destination = dir.path().join("copy.md");

    let read = real_helper().read(note, token, &destination);

    match read {
        Err(HelperError::Answered { kind, .. }) => assert_eq!(kind, VERSION_MISSING),
        other => panic!("expected the helper's own refusal, got {other:?}"),
    }
    assert!(!destination.exists(), "a refused read wrote a file");
    let settled = real_helper().settle(note, &[token.to_string()]).unwrap();
    assert_eq!(settled, SettleReport { settled: Vec::new(), missing: vec![token.to_string()] });
    assert_eq!(std::fs::read_to_string(note).unwrap(), NOTE);
}

/// A helper that cannot start is the tool's failure, told as such, not an
/// answer about the notes.
#[test]
fn a_helper_that_cannot_start_is_a_tool_failure() {
    let dir = tempfile::tempdir().unwrap();
    let note = dir.path().join("Note.md");
    std::fs::write(&note, NOTE).unwrap();
    let not_executable = dir.path().join(HELPER_NAME);
    std::fs::write(&not_executable, "#!/bin/sh\necho '{\"done\":true}'\n").unwrap();
    std::fs::set_permissions(&not_executable, std::fs::Permissions::from_mode(0o644)).unwrap();

    for helper in [
        ConflictsHelper::new(dir.path().join("missing").join(HELPER_NAME)),
        ConflictsHelper::new(not_executable.clone()),
    ] {
        let scanned = helper.scan(std::slice::from_ref(&note));
        assert!(
            matches!(scanned, Err(HelperError::Tool(ToolFailure::Missing(_)))),
            "{scanned:?}"
        );
    }
}
