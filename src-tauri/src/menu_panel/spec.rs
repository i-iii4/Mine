//! What a menu holds, as data (SPEC_MENU_WINDOW.md, МО16 to МО18, МО23,
//! МО25). No Tauri, no AppKit.
//!
//! The page a menu opens on describes it: its width's role and its entries.
//! One component draws the description, in the menu panel and on the page
//! alike (src/components/MenuSpecView.tsx). A choice made in the menu comes
//! back as an action that names the entry, and an action that needs a result
//! is answered. The types are these, and TypeScript's are made from them:
//! the backend reads a description when it takes it, so the panel's page
//! draws only what has this shape (МО17).
//!
//! The entries here are the ones the card menus hold. A stage that moves a
//! menu with another kind of entry into the panel adds the kind with it
//! (SPEC_MENU_WINDOW.md, section 14).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// What sets a menu's width (МО5): a menu of commands, or a list under a
/// search field, which fills its surface with no inset of the surface's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MenuWidthRole {
    Action,
    Search,
}

/// The icons a menu's row may carry: a closed set, drawn by the page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MenuIcon {
    Plus,
    External,
    Unlink,
    Trash,
}

/// How a command's row reads: an ordinary one, one that breaks a link and
/// keeps the content, one that deletes for good.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MenuItemVariant {
    Default,
    Detach,
    Destructive,
}

/// A collection in a picker, with the count of its cards.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct MenuCollection {
    pub name: String,
    pub count: u32,
}

/// Content that is more than rows (МО27): a component of the page's that
/// takes its data from here and keeps what lives only while the menu is
/// open, the query of its search field among it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MenuWidget {
    /// The collections of one card: a search field, every collection of the
    /// space with the card's own ticked, a row to create one.
    CollectionPicker {
        /// The card's slug.
        card: String,
        /// The collections the card is in.
        selected: Vec<String>,
        /// Every collection of the space, in the order the menu shows them.
        collections: Vec<MenuCollection>,
        /// The collection the feed stands on, if any.
        current: Option<String>,
    },
}

/// One entry of a menu. An entry a choice may name has an `id`, the only
/// one of its menu, the same while the menu is open (МО18).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MenuEntry {
    /// A command: choosing it closes the menu.
    Item {
        id: String,
        label: String,
        icon: Option<MenuIcon>,
        variant: MenuItemVariant,
        /// The label may be longer than the row: cut with an ellipsis.
        truncate: bool,
    },
    Separator,
    /// A row that opens a menu beside it. Its content holds no submenu
    /// (МО15).
    Submenu {
        id: String,
        label: String,
        icon: Option<MenuIcon>,
        content: MenuSpec,
    },
    Widget {
        id: String,
        widget: MenuWidget,
    },
}

/// A menu as data: what the page draws.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct MenuSpec {
    pub role: MenuWidthRole,
    pub entries: Vec<MenuEntry>,
}

/// Why a description is no menu.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MenuSpecError {
    #[error("an entry has an empty id")]
    EmptyId,
    #[error("two entries have the id {0:?}")]
    DuplicateId(String),
    #[error("the submenu {0:?} holds a submenu")]
    NestedSubmenu(String),
}

impl MenuSpec {
    /// The description is a menu: every id is there and is the only one of
    /// its kind in the whole menu, and no submenu holds a submenu.
    pub fn validate(&self) -> Result<(), MenuSpecError> {
        let mut ids = HashSet::new();
        self.validate_level(None, &mut ids)
    }

    fn validate_level<'a>(&'a self, inside: Option<&'a str>, ids: &mut HashSet<&'a str>) -> Result<(), MenuSpecError> {
        for entry in &self.entries {
            let id = match entry {
                MenuEntry::Separator => continue,
                MenuEntry::Item { id, .. } | MenuEntry::Submenu { id, .. } | MenuEntry::Widget { id, .. } => id.as_str(),
            };
            if id.is_empty() {
                return Err(MenuSpecError::EmptyId);
            }
            if !ids.insert(id) {
                return Err(MenuSpecError::DuplicateId(id.to_string()));
            }
            if let MenuEntry::Submenu { content, .. } = entry {
                if let Some(outer) = inside {
                    return Err(MenuSpecError::NestedSubmenu(outer.to_string()));
                }
                content.validate_level(Some(id), ids)?;
            }
        }
        Ok(())
    }
}

/// What a widget asks of the page its menu came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MenuWidgetAction {
    /// Connect the card to `collection`, or disconnect it when `connected`
    /// says it is in it now. Answered with `MenuAnswer::Membership`.
    ToggleCollection { collection: String, connected: bool },
    /// Create the collection `name` and connect the card to it.
    CreateCollection { name: String },
    /// Why `name` would be refused as a new collection's. Answered with
    /// `MenuAnswer::NameRefusal`.
    CheckCollectionName { name: String },
}

/// A choice made in a menu, for the page it came from to carry out (МО23).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MenuAction {
    /// The item `id` was chosen.
    Run { id: String },
    /// The widget `id` asks.
    Widget { id: String, action: MenuWidgetAction },
}

/// The page's answer to a choice that needs one (МО25).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MenuAnswer {
    Done,
    /// A membership change was made (true), refused (false) or not known.
    Membership { made: Option<bool> },
    /// Why a typed collection name would be refused, or none.
    NameRefusal { reason: Option<String> },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str) -> MenuEntry {
        MenuEntry::Item {
            id: id.to_string(),
            label: id.to_string(),
            icon: None,
            variant: MenuItemVariant::Default,
            truncate: false,
        }
    }

    fn submenu(id: &str, entries: Vec<MenuEntry>) -> MenuEntry {
        MenuEntry::Submenu {
            id: id.to_string(),
            label: id.to_string(),
            icon: Some(MenuIcon::Plus),
            content: MenuSpec { role: MenuWidthRole::Action, entries },
        }
    }

    fn menu(entries: Vec<MenuEntry>) -> MenuSpec {
        MenuSpec { role: MenuWidthRole::Action, entries }
    }

    #[test]
    fn a_menu_of_rows_separators_and_one_level_of_submenus_is_a_menu() {
        let picker = MenuEntry::Widget {
            id: "connect.picker".to_string(),
            widget: MenuWidget::CollectionPicker {
                card: "card".to_string(),
                selected: vec!["Web".to_string()],
                collections: vec![MenuCollection { name: "Web".to_string(), count: 3 }],
                current: None,
            },
        };
        let spec = menu(vec![
            MenuEntry::Submenu {
                id: "connect".to_string(),
                label: "Connect".to_string(),
                icon: Some(MenuIcon::Plus),
                content: MenuSpec { role: MenuWidthRole::Search, entries: vec![picker] },
            },
            MenuEntry::Separator,
            item("reveal"),
            MenuEntry::Separator,
            item("delete"),
        ]);
        assert_eq!(spec.validate(), Ok(()));
    }

    #[test]
    fn two_entries_never_share_an_id_even_across_a_submenu() {
        assert_eq!(
            menu(vec![item("a"), item("a")]).validate(),
            Err(MenuSpecError::DuplicateId("a".to_string())),
        );
        assert_eq!(
            menu(vec![item("a"), submenu("more", vec![item("a")])]).validate(),
            Err(MenuSpecError::DuplicateId("a".to_string())),
        );
        assert_eq!(menu(vec![item("")]).validate(), Err(MenuSpecError::EmptyId));
    }

    #[test]
    fn a_submenu_holds_no_submenu() {
        let nested = menu(vec![submenu("outer", vec![submenu("inner", vec![item("a")])])]);
        assert_eq!(nested.validate(), Err(MenuSpecError::NestedSubmenu("outer".to_string())));
    }

    #[test]
    fn a_description_travels_as_json_tagged_by_kind() {
        let spec = menu(vec![item("reveal"), MenuEntry::Separator]);
        let text = serde_json::to_string(&spec).unwrap();
        assert_eq!(
            text,
            r#"{"role":"action","entries":[{"kind":"item","id":"reveal","label":"reveal","icon":null,"variant":"default","truncate":false},{"kind":"separator"}]}"#,
        );
        assert_eq!(serde_json::from_str::<MenuSpec>(&text).unwrap(), spec);
        // What is not an entry is no menu: the backend refuses it.
        assert!(serde_json::from_str::<MenuSpec>(r#"{"role":"action","entries":[{"kind":"format_disk"}]}"#).is_err());
        let action = MenuAction::Widget {
            id: "connect.picker".to_string(),
            action: MenuWidgetAction::ToggleCollection { collection: "Web".to_string(), connected: false },
        };
        assert_eq!(
            serde_json::to_string(&action).unwrap(),
            r#"{"kind":"widget","id":"connect.picker","action":{"kind":"toggle_collection","collection":"Web","connected":false}}"#,
        );
    }
}
