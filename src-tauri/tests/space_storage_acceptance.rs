use std::fs;
use std::path::{Path, PathBuf};

use mine_lib::domain::block::{iter_inline_media_references, parse_block};
use mine_lib::domain::vault::{VaultLayout, VaultWriteLayout};
use mine_lib::storage::{db, files, index, media_refs, reconcile};
use tempfile::TempDir;

struct SpaceFixture {
    _temp: TempDir,
    root: PathBuf,
    derived: PathBuf,
}

impl SpaceFixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().expect("temporary space");
        let root = temp.path().join("space");
        let derived = temp.path().join("derived");
        fs::create_dir(&root).expect("space root");
        Self {
            _temp: temp,
            root,
            derived,
        }
    }

    fn layout(&self) -> VaultLayout {
        VaultLayout::with_derived_root(self.root.clone(), self.derived.clone())
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    fn write(&self, relative: &str, bytes: &[u8]) {
        let path = self.path(relative);
        fs::create_dir_all(path.parent().expect("file parent")).expect("create fixture folder");
        fs::write(path, bytes).expect("write fixture source");
    }

    fn move_file(&self, old: &str, new: &str) {
        let destination = self.path(new);
        fs::create_dir_all(destination.parent().expect("destination parent"))
            .expect("create destination folder");
        fs::rename(self.path(old), destination).expect("external same-volume move");
    }

    fn atomic_editor_save(&self, relative: &str, bytes: &[u8]) {
        let destination = self.path(relative);
        let temporary = destination.with_extension("md.editor-save");
        fs::write(&temporary, bytes).expect("editor writes replacement inode");
        fs::rename(temporary, destination).expect("editor publishes replacement inode");
    }

    fn reconcile(&self) {
        let vault = self.layout();
        let conn = db::open_or_create(&vault.index_db_path()).expect("open derived index");
        let report = reconcile::reconcile_runtime_vault_with_progress(&conn, &vault, &|_, _| {})
            .expect("reconcile runtime source space");
        assert!(report.is_fresh(), "source errors: {:?}", report.errors);
    }
}

fn media_bytes_for_card(vault: &VaultLayout, slug: &str) -> (PathBuf, Vec<u8>) {
    let conn = db::open_or_create(&vault.index_db_path()).expect("open derived index");
    let card = index::get_block(&conn, slug)
        .expect("query card")
        .expect("card survives move");
    let reference = card
        .media_file
        .expect("card keeps original media reference");
    let path = media_refs::resolve_indexed_media(vault, slug, &reference)
        .expect("media reference resolves to an original file");
    let bytes = fs::read(&path).expect("read original media bytes");
    (path, bytes)
}

fn assert_source_path(path: &Path, expected: &Path) {
    assert_eq!(
        path, expected,
        "the original attachment must remain selected"
    );
}

#[test]
fn unique_paths_repair_after_history_and_derived_state_are_deleted_before_move() {
    let space = SpaceFixture::new();
    space.write("Cards/Card.md", b"---\ntype: image\nsaved_at: 2026-09-01T00:00:00Z\nfile: \"[[Media/photo.jpg]]\"\n---\n![[Media/photo.jpg|caption]]");
    space.write("Media/photo.jpg", b"original image");
    space.reconcile();
    fs::remove_file(space.path(".mine/file-identity.json")).expect("delete temporary history");
    fs::remove_dir_all(&space.derived).expect("delete temporary derived state");
    space.move_file("Cards/Card.md", "Card.md");
    space.move_file("Media/photo.jpg", "photo.jpg");
    space.reconcile();

    let source = fs::read_to_string(space.path("Card.md")).expect("repaired source");
    assert!(source.contains("file: \"[[photo.jpg]]\""));
    assert!(source.contains("![[photo.jpg|caption]]"));
    let (path, bytes) = media_bytes_for_card(&space.layout(), "Card");
    assert_source_path(&path, &space.path("photo.jpg"));
    assert_eq!(bytes, b"original image");
}

#[test]
fn corrupt_history_does_not_block_unique_source_repair() {
    let space = SpaceFixture::new();
    space.write(
        "Cards/Card.md",
        b"---\ntype: image\nsaved_at: 2026-09-01T00:00:00Z\nfile: \"[[Media/photo.jpg]]\"\n---\n",
    );
    space.write("Media/photo.jpg", b"original image");
    space.reconcile();
    space.write(".mine/file-identity.json", b"{broken json");
    space.move_file("Media/photo.jpg", "Assets/photo.jpg");
    space.reconcile();
    let source = fs::read_to_string(space.path("Cards/Card.md")).expect("source after repair");
    assert_eq!(
        fs::read(space.path(".mine/file-identity.json")).expect("preserved history"),
        b"{broken json"
    );
    assert!(source.contains("[[photo.jpg]]"));
    assert_source_path(
        &media_bytes_for_card(&space.layout(), "Cards/Card").0,
        &space.path("Assets/photo.jpg"),
    );
}

#[test]
fn edited_valid_link_outvotes_stale_history_after_external_rename() {
    let space = SpaceFixture::new();
    space.write("Old/first.jpg", b"former target");
    space.write("New/second.jpg", b"edited target");
    space.write(
        "Card.md",
        b"---\ntype: image\nsaved_at: 2026-09-01T00:00:00Z\nfile: \"[[Old/first.jpg]]\"\n---\n",
    );
    space.reconcile();
    space.atomic_editor_save(
        "Card.md",
        b"---\ntype: image\nsaved_at: 2026-09-01T00:00:00Z\nfile: \"[[New/second.jpg]]\"\n---\n",
    );
    space.move_file("Old/first.jpg", "Moved/first-renamed.jpg");
    space.reconcile();
    let source = fs::read_to_string(space.path("Card.md")).expect("editor source");
    assert!(source.contains("[[New/second.jpg]]"));
    assert!(!source.contains("first-renamed.jpg"));
    assert_source_path(
        &media_bytes_for_card(&space.layout(), "Card").0,
        &space.path("New/second.jpg"),
    );
}

#[test]
fn current_bare_link_outvotes_history_when_old_name_is_reused() {
    let space = SpaceFixture::new();
    space.write("Old/photo.jpg", b"former target");
    space.write(
        "Card.md",
        b"---\ntype: image\nsaved_at: 2026-09-01T00:00:00Z\nfile: \"[[photo.jpg]]\"\n---\n",
    );
    space.reconcile();
    space.move_file("Old/photo.jpg", "Moved/renamed.jpg");
    space.write("Other/photo.jpg", b"current target");
    space.reconcile();
    let source = fs::read_to_string(space.path("Card.md")).expect("source");
    assert!(source.contains("[[photo.jpg]]"));
    assert_source_path(
        &media_bytes_for_card(&space.layout(), "Card").0,
        &space.path("Other/photo.jpg"),
    );
}

#[test]
fn known_bare_binding_is_written_as_explicit_link_when_duplicate_appears() {
    let space = SpaceFixture::new();
    space.write("Media/photo.jpg", b"original target");
    space.write(
        "Card.md",
        b"---\ntype: image\nsaved_at: 2026-09-01T00:00:00Z\nfile: \"[[photo.jpg]]\"\n---\n",
    );
    space.reconcile();
    space.write("Other/photo.jpg", b"other target");
    space.reconcile();
    let source = fs::read_to_string(space.path("Card.md")).expect("disambiguated source");
    assert!(source.contains("[[Media/photo.jpg]]"));
    fs::remove_file(space.path(".mine/file-identity.json")).expect("delete temporary history");
    fs::remove_dir_all(&space.derived).expect("delete temporary derived state");
    space.reconcile();
    assert_source_path(
        &media_bytes_for_card(&space.layout(), "Card").0,
        &space.path("Media/photo.jpg"),
    );
}

#[test]
fn external_note_rename_repairs_custom_property_without_touching_prose() {
    let space = SpaceFixture::new();
    space.write(
        "Old/Peer.md",
        b"---\ntype: article\nsaved_at: 2026-09-01T00:00:00Z\n---\npeer",
    );
    space.write("Card.md", b"---\ntype: article\nsaved_at: 2026-09-01T00:00:00Z\nrelated: \"[[Old/Peer#part|label]]\"\nsummary: \"Read [[Old/Peer]] later\"\n---\n`[[Old/Peer]]`");
    space.reconcile();
    space.move_file("Old/Peer.md", "New/Renamed.md");
    space.reconcile();
    let source = fs::read_to_string(space.path("Card.md")).expect("repaired source");
    assert!(source.contains("related: \"[[Renamed#part|label]]\""));
    assert!(source.contains("summary: \"Read [[Old/Peer]] later\""));
    assert!(source.contains("`[[Old/Peer]]`"));
}

#[test]
fn missing_history_never_guesses_between_duplicate_basenames() {
    let space = SpaceFixture::new();
    space.write("Old/photo.jpg", b"former target");
    space.write(
        "Card.md",
        b"---\ntype: image\nsaved_at: 2026-09-01T00:00:00Z\nfile: \"[[Old/photo.jpg]]\"\n---\n",
    );
    space.reconcile();
    fs::remove_file(space.path(".mine/file-identity.json")).expect("delete temporary history");
    space.move_file("Old/photo.jpg", "A/photo.jpg");
    space.write("B/photo.jpg", b"other target");
    space.reconcile();
    let source = fs::read_to_string(space.path("Card.md")).expect("unmodified ambiguous source");
    assert!(source.contains("[[Old/photo.jpg]]"));
    assert_eq!(media_bytes_for_card_opt(&space.layout(), "Card"), None);
}

fn media_bytes_for_card_opt(vault: &VaultLayout, slug: &str) -> Option<Vec<u8>> {
    let conn = db::open_or_create(&vault.index_db_path()).ok()?;
    let card = index::get_block(&conn, slug).ok()??;
    let path = media_refs::resolve_indexed_media(vault, slug, card.media_file.as_deref()?)?;
    fs::read(path).ok()
}

#[test]
fn closed_space_moves_keep_the_same_media_and_source_links_after_index_loss() {
    let space = SpaceFixture::new();
    let image = b"first-original-image-bytes";
    let distractor = b"second-image-with-the-same-name";
    space.write("Old/Media/photo.jpg", image);
    space.write(
        "Old/Cards/First.md",
        b"---\ntype: image\nsaved_at: 2026-09-01T00:00:00Z\nfile: \"[[Old/Media/photo.jpg]]\"\nMine Related Notes:\n  - \"[[Old/Cards/Peer]]\"\n---\n![[Old/Media/photo.jpg]]",
    );
    space.write(
        "Old/Cards/Peer.md",
        b"---\ntype: article\nsaved_at: 2026-09-01T00:00:00Z\n---\nidentical text",
    );
    space.write(
        "Old/Cards/Twin.md",
        b"---\ntype: article\nsaved_at: 2026-09-01T00:00:00Z\n---\nidentical text",
    );
    space.reconcile();
    assert!(space.path(".mine/file-identity.json").is_file());

    // These moves happen with no SQLite connection or application process open.
    space.write("Other/photo.jpg", distractor);
    space.move_file("Old/Cards/First.md", "Cards/First.md");
    space.move_file("Old/Cards/Peer.md", "Peer.md");
    space.move_file("Old/Cards/Twin.md", "Cards/Twin.md");
    space.move_file("Old/Media/photo.jpg", "Assets/renamed.jpg");

    for reset_index in [false, true] {
        if reset_index {
            fs::remove_dir_all(&space.derived).expect("delete only temporary derived state");
        }
        space.reconcile();
        let vault = space.layout();
        let (path, bytes) = media_bytes_for_card(&vault, "Cards/First");
        assert_source_path(&path, &space.path("Assets/renamed.jpg"));
        assert_eq!(bytes, image);
        assert_eq!(
            fs::read(space.path("Other/photo.jpg")).expect("distractor"),
            distractor
        );
        let source = fs::read_to_string(space.path("Cards/First.md")).expect("moved source");
        let source_card = parse_block("Cards/First", &source).expect("parse moved source");
        let source_media = source_card
            .frontmatter
            .file
            .as_deref()
            .and_then(|reference| {
                media_refs::resolve_indexed_media(&vault, "Cards/First", reference)
            })
            .expect("frontmatter keeps its original attachment");
        assert_source_path(&source_media, &space.path("Assets/renamed.jpg"));
        let inline_refs = iter_inline_media_references(&source_card.body);
        assert_eq!(inline_refs.len(), 1);
        let inline_media = media_refs::resolve_inline_media(&vault, "Cards/First", &inline_refs[0])
            .expect("inline source embed resolves");
        assert_source_path(&inline_media, &space.path("Assets/renamed.jpg"));
        assert_eq!(source_card.frontmatter.related_notes.len(), 1);
        assert_source_path(
            &vault.block_path(&source_card.frontmatter.related_notes[0]),
            &space.path("Peer.md"),
        );
        let conn = db::open_or_create(&vault.index_db_path()).expect("open derived index");
        let shown_card = index::get_block(&conn, "Cards/First")
            .expect("query displayed card")
            .expect("displayed card exists");
        assert!(shown_card
            .related_notes
            .iter()
            .any(|reference| vault.block_path(reference) == space.path("Peer.md")));
        assert!(index::get_block(&conn, "Peer")
            .expect("query peer")
            .is_some());
        assert!(index::get_block(&conn, "Cards/Twin")
            .expect("query twin")
            .is_some());
        assert!(index::get_block(&conn, "Old/Cards/Peer")
            .expect("query old peer")
            .is_none());
    }
}

#[test]
fn same_named_originals_remain_distinct_after_both_are_moved() {
    let space = SpaceFixture::new();
    let first = b"image-owned-by-first-card";
    let second = b"image-owned-by-second-card";
    space.write("A/photo.jpg", first);
    space.write("B/photo.jpg", second);
    space.write(
        "First.md",
        b"---\ntype: image\nsaved_at: 2026-09-01T00:00:00Z\nfile: \"[[A/photo.jpg]]\"\n---\n",
    );
    space.write(
        "Second.md",
        b"---\ntype: image\nsaved_at: 2026-09-01T00:00:00Z\nfile: \"[[B/photo.jpg]]\"\n---\n",
    );
    space.reconcile();
    space.move_file("A/photo.jpg", "Archive/photo 2.jpg");
    space.move_file("B/photo.jpg", "Archive/photo.jpg");

    for reset_index in [false, true] {
        if reset_index {
            fs::remove_dir_all(&space.derived).expect("delete only temporary derived state");
        }
        space.reconcile();
        let vault = space.layout();
        let (first_path, first_bytes) = media_bytes_for_card(&vault, "First");
        let (second_path, second_bytes) = media_bytes_for_card(&vault, "Second");
        assert_source_path(&first_path, &space.path("Archive/photo 2.jpg"));
        assert_source_path(&second_path, &space.path("Archive/photo.jpg"));
        assert_eq!(first_bytes, first);
        assert_eq!(second_bytes, second);
    }
}

#[test]
fn identical_media_bytes_do_not_merge_two_established_targets() {
    let space = SpaceFixture::new();
    let identical = b"the same bytes in two separate files";
    space.write("A/same.jpg", identical);
    space.write("B/same.jpg", identical);
    space.write(
        "First.md",
        b"---\ntype: image\nsaved_at: 2026-09-01T00:00:00Z\nfile: \"[[A/same.jpg]]\"\n---\n",
    );
    space.write(
        "Second.md",
        b"---\ntype: image\nsaved_at: 2026-09-01T00:00:00Z\nfile: \"[[B/same.jpg]]\"\n---\n",
    );
    space.reconcile();
    space.move_file("A/same.jpg", "Moved/first.jpg");
    space.move_file("B/same.jpg", "Moved/second.jpg");

    for reset_index in [false, true] {
        if reset_index {
            fs::remove_dir_all(&space.derived).expect("delete only temporary derived state");
        }
        space.reconcile();
        let vault = space.layout();
        let (first_path, first_bytes) = media_bytes_for_card(&vault, "First");
        let (second_path, second_bytes) = media_bytes_for_card(&vault, "Second");
        assert_source_path(&first_path, &space.path("Moved/first.jpg"));
        assert_source_path(&second_path, &space.path("Moved/second.jpg"));
        assert_eq!(first_bytes, identical);
        assert_eq!(second_bytes, identical);
    }
}

#[test]
fn changing_destinations_writes_only_new_files_and_preserves_old_sources() {
    let space = SpaceFixture::new();
    space.write(
        "Cards/Existing.md",
        b"---\ntype: article\nsaved_at: 2026-09-01T00:00:00Z\n---\noriginal card",
    );
    space.write("Media/existing.jpg", b"original attachment");
    space.write(
        "Collections/Existing.md",
        b"---\ntype: channel\nsaved_at: 2026-09-01T00:00:00Z\n---\noriginal collection",
    );
    let before = [
        (
            "Cards/Existing.md",
            fs::read(space.path("Cards/Existing.md")).expect("old card"),
        ),
        (
            "Media/existing.jpg",
            fs::read(space.path("Media/existing.jpg")).expect("old media"),
        ),
        (
            "Collections/Existing.md",
            fs::read(space.path("Collections/Existing.md")).expect("old collection"),
        ),
    ];

    let new_layout = VaultWriteLayout {
        cards: "Nested/Notes".into(),
        media: "Nested/Assets".into(),
        collections: "Nested/Groups".into(),
    };
    let vault = space.layout();
    files::write_atomically(
        &vault.write_layout_path(),
        &serde_json::to_vec(&new_layout).expect("encode layout"),
    )
    .expect("save changed destinations");
    let configured = files::load_vault_write_layout(&vault).expect("read saved destinations");
    assert_eq!(configured, new_layout);
    let configured_vault = vault.with_write_layout(configured);
    assert!(
        !space.path("Nested").exists(),
        "changing the setting creates no folder"
    );

    let card_slug = configured_vault.new_card_slug("Fresh");
    let card = parse_block(
        &card_slug,
        "---\ntype: article\nsaved_at: 2026-09-01T00:00:00Z\n---\nfresh card",
    )
    .expect("new card source");
    files::write_new_block_file(&configured_vault, &card).expect("create new card");
    let source = space.path("Media/existing.jpg");
    let media =
        files::copy_new_media_file(&source, &configured_vault, "Fresh").expect("create new media");
    let collection_slug = configured_vault.new_collection_slug("Fresh");
    let collection = parse_block(
        &collection_slug,
        "---\ntype: channel\nsaved_at: 2026-09-01T00:00:00Z\n---\nfresh collection",
    )
    .expect("new collection source");
    files::write_new_block_file(&configured_vault, &collection).expect("create new collection");

    assert_eq!(
        configured_vault.block_path(&card_slug),
        space.path("Nested/Notes/Fresh.md")
    );
    assert_eq!(media, space.path("Nested/Assets/Fresh.jpg"));
    assert_eq!(
        configured_vault.block_path(&collection_slug),
        space.path("Nested/Groups/Fresh.md")
    );
    for (relative, bytes) in before {
        assert_eq!(
            fs::read(space.path(relative)).expect("old source remains"),
            bytes
        );
    }
    space.reconcile();
    let conn = db::open_or_create(&configured_vault.index_db_path()).expect("open derived index");
    assert!(index::get_block(&conn, "Cards/Existing")
        .expect("old card query")
        .is_some());
    assert!(index::get_block(&conn, &card_slug)
        .expect("new card query")
        .is_some());
}

#[test]
fn same_named_collections_keep_separate_members_and_descriptions_after_moves() {
    let space = SpaceFixture::new();
    space.write(
        "One/Research.md",
        b"---\ntype: channel\nsaved_at: 2026-09-01T00:00:00Z\ndescription: first collection\n---\n",
    );
    space.write(
        "Two/Research.md",
        b"---\ntype: channel\nsaved_at: 2026-09-01T00:00:00Z\ndescription: second collection\n---\n",
    );
    space.write(
        "First.md",
        b"---\ntype: article\nsaved_at: 2026-09-01T00:00:00Z\nMine Collections:\n  - \"[[One/Research]]\"\n---\nfirst member",
    );
    space.write(
        "Second.md",
        b"---\ntype: article\nsaved_at: 2026-09-01T00:00:00Z\nMine Collections:\n  - \"[[Two/Research]]\"\n---\nsecond member",
    );
    space.reconcile();
    space.move_file("One/Research.md", "Archive/One/Research.md");
    space.move_file("Two/Research.md", "Archive/Two/Research.md");

    for reset_index in [false, true] {
        if reset_index {
            fs::remove_dir_all(&space.derived).expect("delete only temporary derived state");
        }
        space.reconcile();
        let vault = space.layout();
        let conn = db::open_or_create(&vault.index_db_path()).expect("open derived index");
        let channels = index::list_channels(&conn).expect("list collections");
        assert_eq!(
            channels.len(),
            2,
            "two source documents remain two collections"
        );
        let first = channels
            .iter()
            .find(|channel| channel.description.as_deref() == Some("first collection"))
            .expect("first collection remains distinct");
        let second = channels
            .iter()
            .find(|channel| channel.description.as_deref() == Some("second collection"))
            .expect("second collection remains distinct");
        assert_ne!(first.tag, second.tag);
        let first_members =
            index::list_blocks_by_tag(&conn, &first.tag).expect("first collection membership");
        let second_members =
            index::list_blocks_by_tag(&conn, &second.tag).expect("second collection membership");
        assert_eq!(
            first_members
                .iter()
                .map(|card| card.slug.as_str())
                .collect::<Vec<_>>(),
            vec!["First"]
        );
        assert_eq!(
            second_members
                .iter()
                .map(|card| card.slug.as_str())
                .collect::<Vec<_>>(),
            vec!["Second"]
        );
    }
}

#[test]
fn current_unique_note_target_outvotes_deleted_target_history() {
    let space = SpaceFixture::new();
    let identical = b"---\ntype: article\nsaved_at: 2026-09-01T00:00:00Z\n---\nidentical text";
    space.write("Old/Peer.md", identical);
    space.write(
        "Source.md",
        b"---\ntype: article\nsaved_at: 2026-09-01T00:00:00Z\nMine Related Notes:\n  - \"[[Old/Peer]]\"\n---\nsource body",
    );
    space.reconcile();
    fs::remove_file(space.path("Old/Peer.md")).expect("delete temporary original");
    space.write("New/Peer.md", identical);

    for reset_index in [false, true] {
        if reset_index {
            fs::remove_dir_all(&space.derived).expect("delete only temporary derived state");
        }
        space.reconcile();
        let source = fs::read_to_string(space.path("Source.md")).expect("read source note");
        assert!(source.contains("[[Peer]]"));
        assert!(!source.contains("[[Old/Peer]]"));
        let vault = space.layout();
        let conn = db::open_or_create(&vault.index_db_path()).expect("open derived index");
        let card = index::get_block(&conn, "Source")
            .expect("query source")
            .expect("source still exists");
        assert!(
            card.related_notes
                .iter()
                .any(|reference| reference == "Peer" || reference == "New/Peer"),
            "related notes: {:?}",
            card.related_notes
        );
    }
}

#[test]
fn atomic_editor_save_keeps_binding_when_original_media_moves_later() {
    let space = SpaceFixture::new();
    let original = b"original target bytes";
    let distractor = b"same name but different target";
    space.write("Media/target.jpg", original);
    space.write(
        "Card.md",
        b"---\ntype: image\nsaved_at: 2026-09-01T00:00:00Z\nfile: \"[[Media/target.jpg]]\"\n---\nfirst body",
    );
    space.reconcile();
    space.write("Other/target.jpg", distractor);
    space.atomic_editor_save(
        "Card.md",
        b"---\ntype: image\nsaved_at: 2026-09-01T00:00:00Z\nfile: \"[[Media/target.jpg]]\"\n---\nbody edited by another app",
    );
    space.reconcile();
    space.move_file("Media/target.jpg", "Moved/original.jpg");

    for reset_index in [false, true] {
        if reset_index {
            fs::remove_dir_all(&space.derived).expect("delete only temporary derived state");
        }
        space.reconcile();
        let vault = space.layout();
        let (path, bytes) = media_bytes_for_card(&vault, "Card");
        assert_source_path(&path, &space.path("Moved/original.jpg"));
        assert_eq!(bytes, original);
        let source = fs::read_to_string(space.path("Card.md")).expect("edited card source");
        let parsed = parse_block("Card", &source).expect("parse edited card");
        let source_target = parsed
            .frontmatter
            .file
            .as_deref()
            .and_then(|reference| media_refs::resolve_indexed_media(&vault, "Card", reference))
            .expect("edited source retains original target");
        assert_source_path(&source_target, &space.path("Moved/original.jpg"));
        assert_eq!(
            fs::read(space.path("Other/target.jpg")).expect("distractor"),
            distractor
        );
    }
}

#[test]
fn current_exact_media_path_outvotes_deleted_target_history() {
    let space = SpaceFixture::new();
    let original = b"original target bytes";
    let replacement = b"replacement from a different file";
    space.write("Media/target.jpg", original);
    space.write(
        "Card.md",
        b"---\ntype: image\nsaved_at: 2026-09-01T00:00:00Z\nfile: \"[[Media/target.jpg]]\"\n---\n",
    );
    space.reconcile();
    fs::remove_file(space.path("Media/target.jpg")).expect("delete temporary original");
    space.write("Media/target.jpg", replacement);

    for reset_index in [false, true] {
        if reset_index {
            fs::remove_dir_all(&space.derived).expect("delete only temporary derived state");
        }
        space.reconcile();
        let vault = space.layout();
        let conn = db::open_or_create(&vault.index_db_path()).expect("open derived index");
        let shown = index::get_block(&conn, "Card")
            .expect("query card")
            .expect("card exists");
        let shown_reference = shown
            .media_file
            .expect("indexed reference remains available");
        assert_eq!(
            media_refs::resolve_indexed_media(&vault, "Card", &shown_reference),
            Some(space.path("Media/target.jpg")),
            "the source link names the current exact file"
        );
        let source = fs::read_to_string(space.path("Card.md")).expect("source card");
        let parsed = parse_block("Card", &source).expect("parse source card");
        assert_eq!(
            media_refs::resolve_indexed_media(
                &vault,
                "Card",
                parsed
                    .frontmatter
                    .file
                    .as_deref()
                    .expect("source reference"),
            ),
            Some(space.path("Media/target.jpg")),
            "the current exact source link is authoritative"
        );
        assert_eq!(
            fs::read(space.path("Media/target.jpg")).expect("replacement"),
            replacement
        );
    }
}

#[test]
fn intentional_source_link_edit_binds_the_new_target_and_follows_its_move() {
    let space = SpaceFixture::new();
    let old_bytes = b"old target";
    let new_bytes = b"new intended target";
    space.write("Old/first.jpg", old_bytes);
    space.write("New/second.jpg", new_bytes);
    space.write(
        "Card.md",
        b"---\ntype: image\nsaved_at: 2026-09-01T00:00:00Z\nfile: \"[[Old/first.jpg]]\"\n---\n",
    );
    space.reconcile();
    space.atomic_editor_save(
        "Card.md",
        b"---\ntype: image\nsaved_at: 2026-09-01T00:00:00Z\nfile: \"[[New/second.jpg]]\"\n---\n",
    );
    space.reconcile();
    space.move_file("New/second.jpg", "New/renamed.jpg");

    for reset_index in [false, true] {
        if reset_index {
            fs::remove_dir_all(&space.derived).expect("delete only temporary derived state");
        }
        space.reconcile();
        let vault = space.layout();
        let (path, bytes) = media_bytes_for_card(&vault, "Card");
        assert_source_path(&path, &space.path("New/renamed.jpg"));
        assert_eq!(bytes, new_bytes);
        assert_eq!(
            fs::read(space.path("Old/first.jpg")).expect("old target"),
            old_bytes
        );
    }
}

#[test]
fn unrelated_file_addition_does_not_rewrite_existing_markdown() {
    let space = SpaceFixture::new();
    space.write("Media/target.jpg", b"target bytes");
    space.write(
        "Card.md",
        b"---\ntype: image\nsaved_at: 2026-09-01T00:00:00Z\nfile: \"[[target.jpg]]\"\n---\nunchanged body",
    );
    space.reconcile();
    let path = space.path("Card.md");
    let before_bytes = fs::read(&path).expect("source bytes before unrelated addition");
    let before_modified = fs::metadata(&path)
        .expect("source metadata before unrelated addition")
        .modified()
        .expect("source modification time before unrelated addition");
    space.write("Other/unrelated.jpg", b"unrelated bytes");
    space.reconcile();
    assert_eq!(
        fs::read(&path).expect("source bytes after addition"),
        before_bytes
    );
    assert_eq!(
        fs::metadata(&path)
            .expect("source metadata after unrelated addition")
            .modified()
            .expect("source modification time after unrelated addition"),
        before_modified,
    );
}
