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
//! The entries here are the ones the menus moved into the panel hold: a
//! card's menus, a selection's, those of an open card's content (a media
//! file's, a new card's collection, an embedded video's), the chrome's (the
//! Display panels, the settings' sections, the list of spaces, a
//! collection's row in the sidebar), the settings window's and the tab
//! bar's. A stage that moves
//! a menu with another
//! kind of entry into the panel adds the kind with it (SPEC_MENU_WINDOW.md,
//! section 14).

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
    Pencil,
    Folder,
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

/// A space in the list of spaces: its folder, its name, and whether it can
/// open in a new tab (it has an identity; a space never opened has none).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct MenuSpace {
    pub path: String,
    pub name: String,
    pub tab: bool,
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
    /// The collections of a selection of cards: the same list, a collection
    /// ticked when every card of the selection is in it.
    BatchCollectionPicker {
        /// The selected cards' slugs.
        cards: Vec<String>,
        /// The collections every selected card is in.
        in_all: Vec<String>,
        /// Every collection of the space, in the order the menu shows them.
        collections: Vec<MenuCollection>,
    },
    /// Where a new card goes: a search field, a row for no collection, every
    /// collection of the space, a row to create one. A choice creates the
    /// card; what the card is made of, the page the menu came from knows.
    NewCardPicker {
        /// Every collection of the space, in the order the space keeps them.
        collections: Vec<String>,
        /// The collection the feed stands on, if any: the list starts with it.
        current: Option<String>,
    },
    /// The spaces one may go to: a search field, the spaces in the order set
    /// in the settings, each with its actions beside it, the spaces whose
    /// folder is not there, and under a line the two actions of the space on
    /// screen.
    SpaceList {
        /// Every known space but the one on screen.
        spaces: Vec<MenuSpace>,
        /// Known spaces whose folder is not there now: listed and marked,
        /// not a destination.
        unavailable: Vec<MenuSpace>,
        /// The page opens tabs: each space offers to open in a new one.
        tabs: bool,
    },
}

/// One value of a choice, and the words of its row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct MenuOption {
    pub value: String,
    pub label: String,
}

/// How a line of text with no action reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MenuNoteTone {
    /// Why something the menu shows could not be read.
    Error,
}

/// One entry of a menu. An entry a choice may name has an `id`, the only
/// one of its menu, the same while the menu is open (МО18).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MenuEntry {
    /// A command: choosing it closes the menu, unless it stays open.
    Item {
        id: String,
        label: String,
        icon: Option<MenuIcon>,
        variant: MenuItemVariant,
        /// The label may be longer than the row: cut with an ellipsis.
        truncate: bool,
        /// The command cannot be chosen now: the row is dimmed and takes no
        /// press and no key.
        disabled: bool,
        /// Choosing it keeps the menu open: what comes of it shows in the
        /// menu (МО24).
        stays_open: bool,
        /// The row has no leading slot: its menu has no column of icons, the
        /// settings' sections for one. A plain row carries no icon.
        plain: bool,
        /// A second line of text under the label: what the command leaves
        /// as it is.
        detail: Option<String>,
    },
    /// A choice of one value out of a few: a row for each, the chosen one
    /// ticked. Choosing applies at once.
    Radio {
        id: String,
        /// The chosen value: one of `options`, or none of them is ticked.
        value: String,
        options: Vec<MenuOption>,
        /// Choosing closes the menu: the menu is there for this one choice.
        /// A panel of settings keeps it open, the next choice a press away.
        closes: bool,
    },
    /// A switch, ticked while on. Switching applies at once and keeps the
    /// menu open.
    Checkbox { id: String, label: String, checked: bool },
    Separator,
    /// A group's caption, or the line that says what the menu acts on: the
    /// count of the selected elements.
    Caption { text: String },
    /// A line of text with no action.
    Note { text: String, tone: MenuNoteTone },
    /// A row that opens a menu beside it. Its content holds no submenu
    /// (МО15).
    Submenu {
        id: String,
        label: String,
        icon: Option<MenuIcon>,
        /// The row has no leading slot, as a plain item's.
        plain: bool,
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
    #[error("the row {0:?} has an icon and no slot for it")]
    PlainWithIcon(String),
    #[error("the choice {0:?} offers the value {1:?} twice")]
    DuplicateOption(String, String),
}

impl MenuSpec {
    /// The description is a menu: every id is there and is the only one of
    /// its kind in the whole menu, no submenu holds a submenu, a row with no
    /// slot carries no icon, and a choice offers each value once.
    pub fn validate(&self) -> Result<(), MenuSpecError> {
        let mut ids = HashSet::new();
        self.validate_level(None, &mut ids)
    }

    fn validate_level<'a>(&'a self, inside: Option<&'a str>, ids: &mut HashSet<&'a str>) -> Result<(), MenuSpecError> {
        for entry in &self.entries {
            let id = match entry {
                MenuEntry::Separator | MenuEntry::Caption { .. } | MenuEntry::Note { .. } => continue,
                MenuEntry::Item { id, .. }
                | MenuEntry::Radio { id, .. }
                | MenuEntry::Checkbox { id, .. }
                | MenuEntry::Submenu { id, .. }
                | MenuEntry::Widget { id, .. } => id.as_str(),
            };
            if id.is_empty() {
                return Err(MenuSpecError::EmptyId);
            }
            if !ids.insert(id) {
                return Err(MenuSpecError::DuplicateId(id.to_string()));
            }
            match entry {
                MenuEntry::Item { plain: true, icon: Some(_), .. } | MenuEntry::Submenu { plain: true, icon: Some(_), .. } => {
                    return Err(MenuSpecError::PlainWithIcon(id.to_string()));
                }
                MenuEntry::Submenu { content, .. } => {
                    if let Some(outer) = inside {
                        return Err(MenuSpecError::NestedSubmenu(outer.to_string()));
                    }
                    content.validate_level(Some(id), ids)?;
                }
                MenuEntry::Radio { options, .. } => {
                    let mut values = HashSet::new();
                    for option in options {
                        if !values.insert(option.value.as_str()) {
                            return Err(MenuSpecError::DuplicateOption(id.to_string(), option.value.clone()));
                        }
                    }
                }
                _ => {}
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
    /// Connect every card of the selection to `collection`, or disconnect
    /// them all when `connected` is false. Answered with
    /// `MenuAnswer::Membership`.
    ConnectCards { collection: String, connected: bool },
    /// Create the collection `name` and connect the card, or the selection's
    /// cards, to it.
    CreateCollection { name: String },
    /// Why `name` would be refused as a new collection's. Answered with
    /// `MenuAnswer::NameRefusal`.
    CheckCollectionName { name: String },
    /// Create the new card in `collection`, or in none; `new_collection`
    /// says the collection is created first. Answered with
    /// `MenuAnswer::Done`, or with `MenuAnswer::Failed` and why.
    CreateCard { collection: Option<String>, new_collection: bool },
    /// Go to the space at `path`: in this tab, or in a new one. Closes the
    /// menu.
    SwitchSpace { path: String, new_tab: bool },
    /// Show the folder of the space at `path` in Finder. The menu stays:
    /// several folders may be shown in a row.
    RevealSpace { path: String },
    /// Ask to take the space at `path` off the list. Closes the menu: the
    /// question is a window of the page the menu came from.
    ForgetSpace { path: String },
    /// Show the folder of the space on screen in Finder. Closes the menu.
    RevealCurrentSpace,
    /// Ask for a folder to add as a space. Closes the menu.
    AddSpace,
}

/// A choice made in a menu, for the page it came from to carry out (МО23).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MenuAction {
    /// The item `id` was chosen.
    Run { id: String },
    /// `value` was chosen in the choice `id`.
    Choose { id: String, value: String },
    /// The switch `id` was turned on or off.
    Check { id: String, checked: bool },
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
    /// The choice was not carried out: why, in the words the menu shows.
    Failed { message: String },
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
            disabled: false,
            stays_open: false,
            plain: false,
            detail: None,
        }
    }

    fn submenu(id: &str, entries: Vec<MenuEntry>) -> MenuEntry {
        MenuEntry::Submenu {
            id: id.to_string(),
            label: id.to_string(),
            icon: Some(MenuIcon::Plus),
            plain: false,
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
                plain: false,
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
    fn a_selections_menu_is_a_menu_with_its_caption_its_note_and_its_picker() {
        let picker = MenuEntry::Widget {
            id: "connect.picker".to_string(),
            widget: MenuWidget::BatchCollectionPicker {
                cards: vec!["one".to_string(), "two".to_string()],
                in_all: vec!["Web".to_string()],
                collections: vec![MenuCollection { name: "Web".to_string(), count: 3 }],
            },
        };
        let spec = menu(vec![
            MenuEntry::Caption { text: "2 elements".to_string() },
            MenuEntry::Separator,
            MenuEntry::Submenu {
                id: "connect".to_string(),
                label: "Connect".to_string(),
                icon: Some(MenuIcon::Plus),
                plain: false,
                content: MenuSpec { role: MenuWidthRole::Search, entries: vec![picker] },
            },
            item("delete"),
            MenuEntry::Separator,
            // Two lines of text with no action share no id: they have none.
            MenuEntry::Note { text: "The collections could not be read.".to_string(), tone: MenuNoteTone::Error },
            MenuEntry::Note { text: "The collections could not be read.".to_string(), tone: MenuNoteTone::Error },
        ]);
        assert_eq!(spec.validate(), Ok(()));
        assert_eq!(
            serde_json::to_string(&MenuEntry::Note { text: "No".to_string(), tone: MenuNoteTone::Error }).unwrap(),
            r#"{"kind":"note","text":"No","tone":"error"}"#,
        );
        assert_eq!(
            serde_json::to_string(&MenuWidgetAction::ConnectCards { collection: "Web".to_string(), connected: true }).unwrap(),
            r#"{"kind":"connect_cards","collection":"Web","connected":true}"#,
        );
    }

    #[test]
    fn an_open_cards_menus_are_menus_with_their_picker_and_their_rows_states() {
        let picker = MenuEntry::Widget {
            id: "create.picker".to_string(),
            widget: MenuWidget::NewCardPicker { collections: vec!["Web".to_string()], current: Some("Web".to_string()) },
        };
        let copy = MenuEntry::Item {
            id: "copy-media".to_string(),
            label: "Copy Media".to_string(),
            icon: None,
            variant: MenuItemVariant::Default,
            truncate: false,
            disabled: false,
            stays_open: true,
            plain: false,
            detail: None,
        };
        let spec = menu(vec![
            MenuEntry::Submenu {
                id: "create".to_string(),
                label: "Create Element".to_string(),
                icon: Some(MenuIcon::Plus),
                plain: false,
                content: MenuSpec { role: MenuWidthRole::Search, entries: vec![picker.clone()] },
            },
            MenuEntry::Separator,
            copy.clone(),
        ]);
        assert_eq!(spec.validate(), Ok(()));
        assert_eq!(
            serde_json::to_string(&copy).unwrap(),
            r#"{"kind":"item","id":"copy-media","label":"Copy Media","icon":null,"variant":"default","truncate":false,"disabled":false,"stays_open":true,"plain":false,"detail":null}"#,
        );
        assert_eq!(
            serde_json::to_string(&picker).unwrap(),
            r#"{"kind":"widget","id":"create.picker","widget":{"kind":"new_card_picker","collections":["Web"],"current":"Web"}}"#,
        );
        assert_eq!(
            serde_json::to_string(&MenuWidgetAction::CreateCard { collection: None, new_collection: false }).unwrap(),
            r#"{"kind":"create_card","collection":null,"new_collection":false}"#,
        );
        assert_eq!(
            serde_json::to_string(&MenuAnswer::Failed { message: "The note changed.".to_string() }).unwrap(),
            r#"{"kind":"failed","message":"The note changed."}"#,
        );
        // A row that says nothing of its states is no item: the page says
        // each. A second line of text is the one thing a row may leave out.
        assert!(serde_json::from_str::<MenuEntry>(
            r#"{"kind":"item","id":"a","label":"A","icon":null,"variant":"default","truncate":false,"disabled":false,"stays_open":false}"#
        )
        .is_err());
        assert!(serde_json::from_str::<MenuEntry>(
            r#"{"kind":"item","id":"a","label":"A","icon":null,"variant":"default","truncate":false,"disabled":false,"stays_open":false,"plain":false}"#
        )
        .is_ok());
    }

    #[test]
    fn a_chromes_menu_is_a_menu_with_its_choices_its_switches_and_its_plain_rows() {
        let option = |value: &str| MenuOption { value: value.to_string(), label: value.to_string() };
        let sort = MenuEntry::Radio { id: "sort".to_string(), value: "newest".to_string(), options: vec![option("newest"), option("oldest")], closes: false };
        let links = MenuEntry::Checkbox { id: "links.wikilinks".to_string(), label: "Wikilinks".to_string(), checked: true };
        let section = |plain: bool, icon: Option<MenuIcon>| MenuEntry::Item {
            id: "appearance".to_string(),
            label: "Appearance".to_string(),
            icon,
            variant: MenuItemVariant::Default,
            truncate: false,
            disabled: false,
            stays_open: false,
            plain,
            detail: None,
        };
        let spec = menu(vec![
            MenuEntry::Caption { text: "Sort".to_string() },
            sort.clone(),
            MenuEntry::Separator,
            MenuEntry::Caption { text: "Links".to_string() },
            links.clone(),
            MenuEntry::Separator,
            section(true, None),
        ]);
        assert_eq!(spec.validate(), Ok(()));
        assert_eq!(
            serde_json::to_string(&sort).unwrap(),
            r#"{"kind":"radio","id":"sort","value":"newest","options":[{"value":"newest","label":"newest"},{"value":"oldest","label":"oldest"}],"closes":false}"#,
        );
        assert_eq!(
            serde_json::to_string(&links).unwrap(),
            r#"{"kind":"checkbox","id":"links.wikilinks","label":"Wikilinks","checked":true}"#,
        );
        assert_eq!(
            serde_json::to_string(&MenuAction::Choose { id: "sort".to_string(), value: "oldest".to_string() }).unwrap(),
            r#"{"kind":"choose","id":"sort","value":"oldest"}"#,
        );
        assert_eq!(
            serde_json::to_string(&MenuAction::Check { id: "links.wikilinks".to_string(), checked: false }).unwrap(),
            r#"{"kind":"check","id":"links.wikilinks","checked":false}"#,
        );
        // A choice and a switch are named like every entry a choice may name.
        assert_eq!(
            menu(vec![sort.clone(), MenuEntry::Checkbox { id: "sort".to_string(), label: "Sort".to_string(), checked: false }]).validate(),
            Err(MenuSpecError::DuplicateId("sort".to_string())),
        );
        assert_eq!(
            menu(vec![MenuEntry::Radio { id: "sort".to_string(), value: "newest".to_string(), options: vec![option("newest"), option("newest")], closes: true }]).validate(),
            Err(MenuSpecError::DuplicateOption("sort".to_string(), "newest".to_string())),
        );
        assert_eq!(
            menu(vec![section(true, Some(MenuIcon::Plus))]).validate(),
            Err(MenuSpecError::PlainWithIcon("appearance".to_string())),
        );
        // The tab bar's logo menu: a row of two lines, and a submenu's row
        // with no slot that opens a choice which closes the menu.
        let remove = MenuEntry::Item {
            id: "remove".to_string(),
            label: "Remove Space".to_string(),
            icon: Some(MenuIcon::Unlink),
            variant: MenuItemVariant::Detach,
            truncate: false,
            disabled: false,
            stays_open: false,
            plain: false,
            detail: Some("Files stay on disk".to_string()),
        };
        let menus = |icon: Option<MenuIcon>| MenuEntry::Submenu {
            id: "menus".to_string(),
            label: "Menus".to_string(),
            icon,
            plain: true,
            content: menu(vec![MenuEntry::Radio { id: "menus.mode".to_string(), value: "web".to_string(), options: vec![option("web"), option("window")], closes: true }]),
        };
        assert_eq!(menu(vec![remove.clone(), menus(None)]).validate(), Ok(()));
        assert!(serde_json::to_string(&remove).unwrap().ends_with(r#""plain":false,"detail":"Files stay on disk"}"#));
        assert!(serde_json::to_string(&menus(None)).unwrap().starts_with(r#"{"kind":"submenu","id":"menus","label":"Menus","icon":null,"plain":true,"content":"#));
        assert_eq!(menu(vec![menus(Some(MenuIcon::Plus))]).validate(), Err(MenuSpecError::PlainWithIcon("menus".to_string())));
        // The icons of a collection's row in the sidebar.
        assert_eq!(serde_json::to_string(&[MenuIcon::Pencil, MenuIcon::Folder]).unwrap(), r#"["pencil","folder"]"#);
    }

    #[test]
    fn the_space_menu_is_a_menu_with_the_list_of_spaces() {
        let space = |name: &str, tab: bool| MenuSpace { path: format!("/Users/me/{name}"), name: name.to_string(), tab };
        let list = MenuEntry::Widget {
            id: "spaces".to_string(),
            widget: MenuWidget::SpaceList { spaces: vec![space("Archive", true)], unavailable: vec![space("Gone", false)], tabs: true },
        };
        let spec = MenuSpec { role: MenuWidthRole::Search, entries: vec![list.clone()] };
        assert_eq!(spec.validate(), Ok(()));
        assert_eq!(
            serde_json::to_string(&list).unwrap(),
            r#"{"kind":"widget","id":"spaces","widget":{"kind":"space_list","spaces":[{"path":"/Users/me/Archive","name":"Archive","tab":true}],"unavailable":[{"path":"/Users/me/Gone","name":"Gone","tab":false}],"tabs":true}}"#,
        );
        let actions = [
            (MenuWidgetAction::SwitchSpace { path: "/a".to_string(), new_tab: true }, r#"{"kind":"switch_space","path":"/a","new_tab":true}"#),
            (MenuWidgetAction::RevealSpace { path: "/a".to_string() }, r#"{"kind":"reveal_space","path":"/a"}"#),
            (MenuWidgetAction::ForgetSpace { path: "/a".to_string() }, r#"{"kind":"forget_space","path":"/a"}"#),
            (MenuWidgetAction::RevealCurrentSpace, r#"{"kind":"reveal_current_space"}"#),
            (MenuWidgetAction::AddSpace, r#"{"kind":"add_space"}"#),
        ];
        for (action, json) in actions {
            assert_eq!(serde_json::to_string(&action).unwrap(), json);
        }
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
            r#"{"role":"action","entries":[{"kind":"item","id":"reveal","label":"reveal","icon":null,"variant":"default","truncate":false,"disabled":false,"stays_open":false,"plain":false,"detail":null},{"kind":"separator"}]}"#,
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
