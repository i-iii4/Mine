//! Cases verified with Obsidian's real metadata cache on an isolated vault.
//! No test opens or changes the user's vaults.

use mine_core::links::{LinkIndex, LinkResolution, LinkSyntax};
use mine_lib::domain::vault::VaultLayout;
use mine_lib::storage::media_refs;
use std::path::Path;

const PATHS: &[&str] = &[
    "Cards/Example.md",
    "Collections/Collection.md",
    "Notes/Related.md",
    "Media/unique.svg",
    "Archive/A/same.svg",
    "Archive/B/same.svg",
    "Design.md",
    "Nested/Design.md",
];

const OBSIDIAN_TARGETS: &[(&str, &str)] = &[
    ("Collection", "Collections/Collection.md"),
    ("Related#Heading|Related label", "Notes/Related.md"),
    ("unique.svg", "Media/unique.svg"),
    ("A/same.svg", "Archive/A/same.svg"),
    ("B/same.svg", "Archive/B/same.svg"),
    ("Design", "Design.md"),
    ("/Design", "Design.md"),
    ("Nested/Design", "Nested/Design.md"),
];

fn assert_obsidian_targets(index: &LinkIndex) {
    for source in ["Cards/Example.md", "Nested/Other.md", "Other.md"] {
        for (reference, expected) in OBSIDIAN_TARGETS {
            assert_eq!(
                index.resolve(source, reference, LinkSyntax::Obsidian),
                LinkResolution::Resolved((*expected).to_string()),
                "Obsidian target differs for {source}: {reference}",
            );
        }
    }
}

#[test]
fn native_core_matches_observed_obsidian_link_targets() {
    assert_obsidian_targets(&LinkIndex::new(PATHS.iter().copied()));
}

#[test]
fn shortest_suffix_roundtrips_without_history() {
    let index = LinkIndex::new(PATHS.iter().copied());
    for path in PATHS {
        let link = index.shortest_link(path, true).expect("unique link");
        assert_eq!(
            index.resolve("Cards/Example.md", &link, LinkSyntax::Obsidian),
            LinkResolution::Resolved((*path).to_string()),
            "generated link: {link}",
        );
    }
    assert_eq!(
        index.shortest_link("Archive/A/same.svg", false).as_deref(),
        Some("A/same.svg")
    );
}

#[test]
#[ignore = "requires an explicitly supplied isolated Obsidian oracle vault"]
fn native_adapter_matches_live_obsidian_fixture() {
    let root = std::env::var("MINE_OBSIDIAN_ORACLE_ROOT").expect("explicit oracle root");
    let root = Path::new(&root);
    assert!(
        root.starts_with("/private/tmp"),
        "only isolated temporary fixtures"
    );
    let index = media_refs::build_link_index(root);
    let shuffled = std::env::var_os("MINE_OBSIDIAN_ORACLE_SHUFFLED").is_some();
    let physical = |path: &str| -> String {
        if !shuffled {
            return path.to_string();
        }
        match path {
            "Cards/Example.md" => "Example.md".to_string(),
            "Collections/Collection.md" => "Shuffled/Deep/Collection.md".to_string(),
            "Notes/Related.md" => "Shuffled/Deep/Notes/Related.md".to_string(),
            "Media/unique.svg" => "Shuffled/Assets/unique.svg".to_string(),
            path if path.starts_with("Archive/") => path.replacen("Archive/", "Shuffled/", 1),
            path => path.to_string(),
        }
    };
    for (reference, expected) in OBSIDIAN_TARGETS {
        assert_eq!(
            index.resolve(
                &physical("Cards/Example.md"),
                reference,
                LinkSyntax::Obsidian
            ),
            LinkResolution::Resolved(physical(expected)),
        );
    }
    let layout = VaultLayout::with_derived_root(root.to_path_buf(), root.join(".oracle-derived"));
    assert_eq!(
        media_refs::resolve_collection_document(&layout, "Collection"),
        Some(root.join(physical("Collections/Collection.md"))),
    );
    for (reference, expected) in OBSIDIAN_TARGETS
        .iter()
        .filter(|(_, path)| path.ends_with(".svg"))
    {
        assert_eq!(
            media_refs::resolve_frontmatter_media(&layout, "Cards/Example", reference),
            Some(root.join(physical(expected))),
        );
    }
    let source = std::fs::read_to_string(root.join(physical("Cards/Example.md"))).unwrap();
    assert!(source.contains("custom_property: keep this value"));
    assert!(source.contains("[[Related#Heading|Related label]]"));
}
