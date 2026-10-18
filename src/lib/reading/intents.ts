// What an event on an element of a note means, decided once for both
// surfaces of the note: the reading mode and the editor (SPEC_EDITING.md,
// Л11.1; Local MD, SPEC_SURFACE_PARITY). The surfaces only carry the intent
// out, each with an exhaustive `switch` checked by `never`: a new intent does
// not build until every surface carries it out or refuses it with its reason
// in code.

/** The two surfaces of a note. */
export type NoteSurface = "reading" | "editing";

/** Where a link of the note leads. */
export type NoteLinkTarget =
  | { kind: "note"; target: string }
  | { kind: "external"; href: string }
  | { kind: "anchor"; fragment: string };

/** The element an event happened on, by its place in the note. */
export type NoteElement =
  | { kind: "link"; to: NoteLinkTarget }
  | { kind: "task" }
  | { kind: "image" }
  | { kind: "embed" }
  | { kind: "table" }
  | { kind: "table-cell" }
  | { kind: "code" }
  | { kind: "mermaid" }
  | { kind: "math" }
  | { kind: "callout" }
  | { kind: "html" }
  | { kind: "rule" }
  | { kind: "text" };

/** The events a surface asks about. */
export type NoteEvent = "click" | "command-click" | "enter" | "space";

export interface NoteInteraction {
  surface: NoteSurface;
  element: NoteElement;
  event: NoteEvent;
  /** In the editor: the element shows its source now (Л5.2). */
  revealed?: boolean;
  /** In the editor: the block is selected (Л5.3, Л8.4). */
  selected?: boolean;
}

/** What an event means (Л11.1). */
export type NoteInteractionIntent =
  | { kind: "OpenNote"; target: string }
  | { kind: "OpenExternal"; href: string }
  | { kind: "JumpToAnchor"; fragment: string }
  | { kind: "ToggleTask" }
  | { kind: "OpenImagePreview" }
  | { kind: "OpenEmbed" }
  | { kind: "EnterTableCell" }
  | { kind: "SelectBlock" }
  | { kind: "RevealBlock" }
  | { kind: "PlaceCaret" }
  | { kind: "Nothing" };

const NOTHING: NoteInteractionIntent = { kind: "Nothing" };

function follow(to: NoteLinkTarget): NoteInteractionIntent {
  switch (to.kind) {
    case "note":
      return { kind: "OpenNote", target: to.target };
    case "external":
      return { kind: "OpenExternal", href: to.href };
    case "anchor":
      return { kind: "JumpToAnchor", fragment: to.fragment };
  }
}

/** A block the editor draws as a widget: what a click and Enter mean
 *  there (Л5.3). */
function editorBlock(element: NoteElement, interaction: NoteInteraction): NoteInteractionIntent {
  switch (element.kind) {
    // A picture and a note embed are chosen first, Enter shows the source.
    case "image":
    case "embed":
      if (interaction.event === "click") return { kind: "SelectBlock" };
      return interaction.event === "enter" && interaction.selected ? { kind: "RevealBlock" } : NOTHING;
    // A table opens a cell: its editor, not its source (Л9.2).
    case "table":
      if (interaction.event === "click") return { kind: "EnterTableCell" };
      return interaction.event === "enter" && interaction.selected ? { kind: "EnterTableCell" } : NOTHING;
    // Code, a diagram, a formula, a callout and HTML show their source at
    // once.
    default:
      if (interaction.event === "click") return { kind: "RevealBlock" };
      return interaction.event === "enter" && interaction.selected ? { kind: "RevealBlock" } : NOTHING;
  }
}

/**
 * What `interaction` means on its surface (Л10.1, Л5.3, Л7.4, Л9, Л11.1;
 * SPEC_READING_MODE.md, Ч11.7, Ч12.2):
 *
 * - a link opens with a click in the reading mode and, in the editor, while
 *   it is drawn; a revealed link takes the caret, ⌘-click opens it there;
 * - a task box changes with a click and Space, not Enter (WAI-ARIA);
 * - a picture opens its preview in the reading mode, a note embed its note;
 *   in the editor both are chosen as blocks;
 * - code, a diagram, a formula, a callout and HTML show their source in the
 *   editor at a click; a table opens a cell;
 * - anything else takes the caret in the editor and does nothing in the
 *   reading mode.
 */
export function noteInteractionIntent(interaction: NoteInteraction): NoteInteractionIntent {
  const { surface, element, event } = interaction;
  if (element.kind === "task") return event === "click" || event === "space" ? { kind: "ToggleTask" } : NOTHING;
  if (surface === "reading") {
    switch (element.kind) {
      case "link":
        return event === "click" || event === "command-click" || event === "enter" ? follow(element.to) : NOTHING;
      case "image":
        return event === "click" ? { kind: "OpenImagePreview" } : NOTHING;
      case "embed":
        return event === "space" || event === "enter" || event === "click" ? { kind: "OpenEmbed" } : NOTHING;
      default:
        return NOTHING;
    }
  }
  switch (element.kind) {
    case "link":
      if (event === "command-click") return follow(element.to);
      if (event === "click") return interaction.revealed ? { kind: "PlaceCaret" } : follow(element.to);
      return NOTHING;
    case "table-cell":
      return event === "click" ? { kind: "EnterTableCell" } : NOTHING;
    case "rule":
    case "text":
      return event === "click" || event === "command-click" ? { kind: "PlaceCaret" } : NOTHING;
    default:
      return editorBlock(element, interaction);
  }
}
