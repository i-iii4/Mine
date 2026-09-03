# SPEC_GROUP_SELECTION

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_CARD_MERGE.md](SPEC_CARD_MERGE.md) | [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md)

Status: implemented.

## Goal

Add Grid-owned group selection and batch card actions to the desktop feed.
Selection must feel spatial and visual, not list-like: the user selects cards in
the masonry surface and acts on the selected set from a bottom floating action
commands row.

## Scope

In scope:

- `Cmd+click` toggles individual cards in the current Grid.
- `Shift+click` has the same behavior as `Cmd+click`: it toggles only the
  clicked card.
- Empty-area pointer drag draws a marquee rectangle and selects every committed
  card that intersects it.
- Selected cards get a strong monochrome selected frame.
- Dragging a selected card drags the whole selected set.
- Dropping selected cards on a channel connects every dragged card to that
  channel.
- The selection commands row takes over the chrome content segment while one or more cards are selected.
- Batch actions: close selection, `Connect`, collection-scoped `Disconnect`,
  `Merge`, `Delete`.

Out of scope for the first implementation:

- `Cmd+A` / keyboard-only range extension.
- Cross-channel persistent selection.
- Selecting skeleton/provisional cards.
- Batch actions in Detail or non-Grid surfaces.

## Ownership

Grid owns selection state:

```ts
type GroupSelectionState = {
  selectedSlugs: Set<string>;
  marqueeSelection: MarqueeSelection | null;
};
```

`Card` does not own selection and does not query DOM selection state. Grid
derives `isSelected` from `selectedSlugs.has(block.slug)` and marks GridItem
with `data-feed-grid-item-selected="true"`.

All selection operations use stable block `slug` identity. Marquee selection
uses `layout.positions`; never `getBoundingClientRect()`, DOM order, or array
index math as source of truth.

## Pointer Selection

### Plain Click

Plain click without modifiers opens Detail only when no group selection is
active. If `selectedSlugs.size > 0`, plain click on a committed card becomes a
selection toggle for that card and must not open Detail:

- not selected -> add to `selectedSlugs`;
- selected -> remove from `selectedSlugs`.

If the user opens Detail from a non-selection state, any stale selection must be
cleared before Detail becomes interactive.

### Modified Click

`Cmd+click` and `Shift+click` on a committed card both toggle only that card:

- not selected -> add to `selectedSlugs`;
- selected -> remove from `selectedSlugs`.

Modified click prevents the normal Detail open action.

If toggling removes the last selected card, `selectedSlugs` becomes empty and
the selection commands row disappears.

`Cmd+Shift+click` is not a separate range mode; it follows the same single-card
toggle behavior.

### Marquee Drag

Empty-area primary-button drag starts marquee selection. Empty area means the
pointer target is not a card, button, input, link, menu item, or editable
surface.

While dragging:

- Grid draws an axis-aligned marquee rectangle in masonry layout coordinates;
- the rectangle becomes active only after a small drag threshold;
- every committed card whose layout rectangle intersects the marquee rectangle
  is selected;
- the current selected set is replaced by the current marquee intersection.

Cards are selected by rectangle intersection, not by center point containment.

### Marquee Edge Autoscroll

Selection is not limited to what is on screen when the drag starts. Holding an
active marquee drag inside the top or bottom edge band of the Grid scrollport
pulls the feed in that direction and keeps extending the rectangle.

- The edge band is `56px` deep, measured from the scrollport edge.
- Speed ramps from `160px/s` at the outer boundary of the band to `1800px/s` at
  the scrollport edge, by depth into the band.
- A pointer past the scrollport edge keeps the maximum speed instead of losing
  the pull, so a drag that leaves the window still scrolls.
- Autoscroll runs only while the marquee is `active`; a drag below the
  threshold never scrolls.
- Pointer events stop arriving while the pointer is held still, so each frame
  scrolls the port, recomputes the marquee point from the unchanged client
  position, and reselects. The rectangle therefore grows by exactly the
  scrolled distance.
- Scrolling stops at the ends of the feed; it never extends beyond
  `scrollHeight - clientHeight` or above zero.
- Selection during autoscroll obeys the same rule as during pointer movement:
  every committed card intersecting the rectangle is selected, and cards that
  become render-ready as they scroll into the runway participate.

## State Reset

Selection is cleared when:

- current channel/tag changes;
- vault route changes or a fresh vault is opened;
- selected blocks disappear from the current `blocks` list;
- user presses `Escape` while Grid selection is active;
- user performs a primary click on empty Grid space without crossing the
  marquee drag threshold;
- a batch `Delete` or collection-scoped `Disconnect` completes successfully;
- plain click opens Detail from a non-selection state;
- Detail opens from another surface such as Sidebar previews, related notes or
  external App-level navigation.

Selection is preserved when:

- `Connect` menu opens and closes without applying changes;
- pointer hover moves between cards;
- keyboard focus moves through the Grid;
- `Cmd+K` opens a card overflow menu or the selected-card batch menu.

When selection starts while the main search input is focused, Grid notifies App
to release search keyboard ownership. Empty main search chrome closes; a
non-empty search query/filter stays active, but `Escape` now clears selection
instead of first blurring or closing the search input.

Keyboard focus, pointer hover, pinned `Cmd+K` menu anchor, and group selection
are separate states. A card can be focused, hovered, pinned, selected, or any
compatible combination of those states.

While `selectedSlugs.size > 0`, Grid suppresses feed card hover actions for all
cards: `CardHoverMenu` does not receive CSS `group-hover` affordances and hidden
action layers stay non-interactive. Batch actions are exposed through the
selection commands row for pointer users and through a focused-card
`Cmd+K` batch menu for keyboard users.

### Keyboard Selection

When Grid keyboard focus is active:

- `Shift+Enter` toggles the focused committed card in `selectedSlugs`;
- after `selectedSlugs.size > 0`, plain `Enter` also toggles the focused card
  instead of opening Detail;
- the macOS `Delete` key (`⌫`, DOM `Backspace`) opens the existing batch delete
  confirmation for the whole selected set; it never deletes without confirmation;
- arrow keys continue to move Grid focus by `layout.positions`;
- `Cmd+K` opens a contextual batch menu anchored to the focused card's
  top-right overflow action.

When group selection is active, `Enter` must stay inside selection mode even if
the browser's DOM focus and Grid's interaction focus diverge:

- if the current interaction mode is keyboard, `Enter` toggles Grid
  `focusedSlug`; stale DOM focus on another card must be ignored;
- if the current interaction mode is pointer and the keyboard event target is a
  committed feed card, `Enter` toggles that card;
- if focus is on passive Grid/body space and the pointer is hovering a
  committed card, `Enter` toggles the pointer-hovered card;
- `Enter` must not fall through to `Card` activation and must not open Detail
  while `selectedSlugs.size > 0`.

The contextual batch menu is not the normal single-card menu. It shows a muted
count header (`1 карточка`, `2 карточки`, `5 карточек`) and only batch actions:

- `Connect` opens the existing `BatchCollectionPicker`;
- `Disconnect` appears only when `currentTag` exists and removes all selected
  cards from that current collection;
- `Merge` appears only when at least two cards are selected and opens the
  reorder-first merge dialog from [SPEC_CARD_MERGE.md](SPEC_CARD_MERGE.md);
- `Delete` opens the existing batch delete confirmation.

`Connect` (`Plus`), `Disconnect` (`Unlink`) and `Delete` (`Trash2`) carry icons
in the batch menu, matching the card menus; `Merge` is a text command with an
empty leading icon slot, so labels stay aligned.

`Source`, `Rename`, `Reveal`, `Copy Path`, single-card collection actions and
other single-card actions are not present in this focused-card batch menu. This
keeps keyboard batch actions local to the active card while the count header
makes the selected-set scope explicit.

## Right-click on a Selection

Right-click follows the same scope rule as `Cmd+K`, so the pointer path cannot
act on less than the user sees selected.

- right-clicking a card whose slug is in `selectedSlugs` opens a selection
  context menu carrying the same commands as the focused-card batch menu: count
  header, `Connect`, `Disconnect` (only with `currentTag`), `Merge` (only from
  two cards) and `Delete`. Every command applies to all selected cards, never to
  the clicked card alone;
- right-clicking a card outside the selection opens the ordinary single-card
  menu and leaves `selectedSlugs` untouched, so an accidental right-click never
  silently drops a selection;
- `Reveal in Finder`, `Copy Path`, `Rename…` and `Source` are absent from the
  selection menu rather than disabled: each addresses exactly one file or one
  URL, so on a selection they would either pick a card silently or open a window
  per card;
- the delete confirmation is the shared selection dialog and is mounted by the
  grid, not by the menu content, which unmounts as soon as the menu closes.

Both entry points read their state through one hook, so the two menus cannot
drift apart in what a batch command does.

## Selected Card Visual

Selected cards use a strong monochrome frame, not the blue system selection
color.

Visual contract:

- the frame is individual per selected card, not a rectangle around the whole
  selected area;
- frame color is white in dark theme and black in light theme;
- frame thickness is `2px`;
- frame is outside the card, with a `1px` gap between card edge and frame;
- frame has no corner radius;
- no glow, shadow, blur, gradient, or colored outline;
- selected frame is the primary visual signal and must read stronger than
  hover/focus.

Implementation contract:

- GridItem receives `data-feed-grid-item-selected="true"`;
- selected frame is rendered by GridItem as a sibling overlay outside the
  clipped card layer, not by Card;
- overlay is `pointer-events: none` and does not affect masonry layout;
- the ring sits on the card's edge, and one measurement serves twice: its own
  thickness, and how far the selected card grows outward to make room for it.
  Nothing inside the card moves or is covered when it is selected:

```css
[data-feed-grid-selection-frame] {
  position: absolute;
  inset: calc(-1 * var(--feed-selection-ring));
  box-shadow: inset 0 0 0 var(--feed-selection-ring) var(--feed-selection-frame);
  border-radius: calc(var(--radius-card) + var(--feed-selection-ring));
}
```

Rounding follows the card's own, widened by the growth, so the corner arc is
the ring's colour the whole way round. A fixed `border-radius: 0` used to cut a
square across a rounded card, and the ring — 2px thick, standing 3px off the
edge — read as a separate object laid on top of the card rather than as its
selected state (29.08.2026).

Tokens:

```css
:root {
  /* thickness and outward growth are the same value */
  --feed-selection-ring: 1px;
  --feed-selection-frame: oklch(0.145 0 0);
}

:root[data-theme="dark"] {
  --feed-selection-frame: oklch(0.985 0 0);
}
```

The selected frame layer must render above media wash and hover overlays. It may
render above the `Cmd+K` badge because the ring sits on the card's edge and does
not reach the badge at `left-2 top-2`. Contract — `src/lib/selectionRing.test.ts`.

## Marquee Visual

The drag marquee is a temporary Grid-owned overlay rendered inside
`data-grid-layout`.

Visual contract:

- no corner radius;
- `pointer-events: none`;
- fill uses the design-system surface +2 token: `--active`;
- border uses the next surface/border token: `--border`;
- implementation may use `color-mix(in oklch, var(--active) 72%, transparent)`
  for fill readability, but the source value must remain `--active`;
- no glow, blur, gradient, shadow, or color outside the monochrome system.

CSS contract:

```css
[data-feed-grid-marquee-selection] {
  position: absolute;
  border: 1px solid var(--border);
  background: color-mix(in oklch, var(--active) 72%, transparent);
  border-radius: 0;
  pointer-events: none;
}
```

## Group Drag To Channels

When `selectedSlugs.size > 0` and the user starts drag from a selected
committed card, the drag becomes a group card drag.

Payload contract:

- `Card` remains the draggable surface, but the dnd payload includes
  `dragSlugs` for the whole selected set;
- the card under the pointer is the first/front block in `dragBlocks`;
- the rest of `dragBlocks` follow the current Grid `blocks` order, deduped by
  slug;
- if the pointer starts drag from a non-selected card, the operation is a
  normal single-card drag and any old selection is cleared on drag start;
- Detail drags and media/text-selection drags keep their existing single-item
  payload contracts.

Drop behavior:

- dropping a group card drag on `tag:<channel>` connects every `dragSlugs`
  entry to that channel in one batch operation;
- dropping on `Everything` is not a connect target;
- dropping on `create-channel` opens the existing create-channel flow and, once
  the channel is created, connects every dragged slug to the new channel;
- the operation is idempotent: cards already connected to the channel do not
  create duplicate membership or visible errors;
- Grid card order and sidebar taxonomy order must not reflow during the
  optimistic drag/drop interaction.

During group drag:

- real masonry cards do not move and do not reflow;
- the bottom action island is hidden/inert while a block drag is active;
- hover, focus and `Cmd+K` affordances do not become the primary visual signal;
- sidebar channel rows still use the normal drop-hover row state.

## Drag Stack Preview

Group drag uses a macOS-style card stack preview, not a single-card preview.

Visual contract:

- the front layer is the card where drag started;
- every visible layer is a real frozen card preview from the selected set, not
  an empty plate;
- up to four selected cards are shown; if more cards are selected, payload
  still includes all cards and the preview adds a count badge with the full
  dragged count;
- visible layers use read-only previews, not interactive `Card`: no hover menu,
  no playback, no selection frame, no `Cmd+K` badge;
- no layer uses `scale(...)`;
- front layer is not transformed; back layers use integer-pixel offsets and
  small rotations only;
- depth comes from real card occlusion, slight flocking angles and existing
  card frame/shadow;
- no new corner radius is introduced.

Layer transforms:

| Layer | Transform |
|---|---|
| 0 front | no transform |
| 1 card | `translate3d(-6px, -6px, 0) rotate(-0.9deg)` |
| 2 card | `translate3d(7px, -11px, 0) rotate(0.75deg)` |
| 3 card | `translate3d(-2px, -16px, 0) rotate(-0.45deg)` |

Forbidden in stack layers:

- `scale(...)`;
- fractional pixel offsets.
- interactive `Card` surfaces or controls.

Implementation markers:

- stack root: `data-feed-drag-stack`;
- root count attributes:
  `data-feed-drag-stack-count` and `data-feed-drag-stack-visible-count`;
- each layer: `data-feed-drag-stack-layer` with
  `data-feed-drag-stack-layer-index`.
- front real card wrapper: `data-feed-drag-stack-front`;
- visible card preview wrapper: `data-feed-drag-stack-card`;
- overflow badge for hidden dragged items:
  `data-feed-drag-stack-count-badge`.

## Selection Commands Row

**Superseded 23.08.2026, corrected 26.08.2026:** the bottom floating action
island is removed. The selection's commands live in the secondary chrome row
(`MainSecondaryTopBar`) as a layer while a selection exists — the same
layer-swap language the open-element states use. The row's surface does not
change: a selection swaps the half's content, and every control on the layer
computes its fill from the surface it stands on (relative elevation,
DESIGN_SYSTEM.md), so nothing shifts colour on activation.

The layer occupies the **content segment only**: it replaces that half's
ordinary content — the element count and the view switch. The sidebar segment
keeps its stats; the commands sit over the feed they act on, not over the
collections list.

Ownership and mechanics:

- selection state and every handler stay owned by Grid; only presentation
  moved. Grid portals `GroupSelectionCommands` into a host slot the row
  exposes (`createPortal`); without a host (unit renders) the commands mount
  in place;
- the host slot stays mounted so the portal target exists before the first
  selected card;
- hidden while a block drag is active, so the stack preview/drop operation is
  the only primary drag affordance;
- the action error renders as a single line anchored under the row;
- horizontal scrolling inside the row when content does not fit.

Layout order:

- the counter starts the row: `font-mono text-sm text-muted-foreground`,
  `{n} element(s) selected` (English plural helper
  `selectedElementCountLabel`, not string concatenation);
- then the actions; the rightmost control is an icon-only close button (`X`)
  that clears selection, pinned to the row's far edge.

Direct action buttons use standard design-system `Button` variants, whose
fills compute from the row's own surface (relative elevation — no hand-picked
colors). `Connect`, `Disconnect` and `Merge` use `variant="default"`
(`Disconnect` keeps `text-detach`); `Delete` uses `variant="destructive"`.

| Action | Availability | Behavior |
|---|---|---|
| `Connect` | always enabled when at least one element is selected | Opens batch collection picker for selected elements. |
| `Disconnect` | visible only when `currentTag` is present | Removes all selected elements from the current collection. |
| `Merge` | visible only when at least two elements are selected | Opens the merge reorder dialog, then one backend merge command creates one new element and removes the selected sources. |
| `Delete` | always enabled when at least one element is selected | Opens batch destructive confirmation before deleting selected elements. |

The bottom action bar narrows to the selection's commands at the same time:
navigation and `Focus` entries leave, a pressable `Clear selection esc`
arrives ([SPEC_KEYBOARD.md](SPEC_KEYBOARD.md)).

## Batch Delete

Batch Delete must match the single-card delete model: plan first, then commit.
It must not be implemented as a loop over `deleteBlock(slug, false)` because
that makes media behavior different from ordinary card deletion and cannot
detect media that becomes unused only after the whole selected set is removed.

Backend owns the aggregate plan:

```ts
type DeleteBlocksPlan = {
  slugs: string[];
  markdown_files: string[];
  unused_media: DeleteBlockMedia[];
  shared_media: DeleteBlockMedia[];
};
```

`unused_media` means media that will have no remaining parseable references
after deleting all selected cards. `shared_media` means media referenced by at
least one non-selected card/note and must never be deleted by this batch action.

Examples:

- one selected card owns one image and no other note references it ->
  `unused_media` includes that image;
- two selected cards both reference the same image and no unselected note
  references it -> `unused_media` includes that image once;
- a selected card and an unselected article both reference the same image ->
  `shared_media` includes that image and the image stays on disk.

The dialog copy follows the single delete confirmation semantics:

- title: `Delete selected cards?`;
- description always names the selected-card count;
- when `unused_media.length === 0`, only one destructive commit action is
  needed and the dialog states that media files stay in the vault;
- when `unused_media.length > 0`, the dialog shows compact media previews and
  offers both `Keep media` and `Delete media`;
- `Keep media` deletes selected `.md` cards and derived artifacts only;
- `Delete media` deletes selected `.md` cards plus eligible `unused_media`;
- `shared_media` is never offered for deletion, but may be summarized as kept
  when useful for clarity.

The commit path must be one backend batch command, not N independent frontend
calls. The backend command receives the selected slugs plus
`delete_unused_media`, rebuilds or validates the plan at commit time, deletes
only eligible media, refreshes affected index rows/previews, and returns one
success/failure result. After success, Grid clears selection and preserves the
viewport using the existing delete scroll-anchor contract.

## Batch Connect

Batch Connect uses `BatchCollectionPicker` from the same
`src/components/CollectionPicker.tsx` implementation family as existing
single-card `Connect`. It must inherit the same search input, active row,
right action slot, hover outline and keyboard/pointer conflict contract.
Batch mode intentionally has only binary membership behavior:

- all selected cards connected to channel -> row action is `Disconnect`;
- at least one selected card not connected to channel -> row action is
  `Connect`.

The picker must not render selected-card membership counts like `1/3` or
`2/3`; partial membership is not a separate visible state.

Toggling a channel applies to all selected cards:

- from partial/none -> connect all selected cards to the channel;
- from all connected -> disconnect all selected cards from the channel.

The visible channel order must match sidebar taxonomy order exactly. Realtime
membership updates must not reorder rows while the picker is open.

The row label/state update is local and optimistic. The picker must switch
`Connect`/`Disconnect` before the filesystem mutation or snapshot refresh
starts; persistence runs after the UI update, and App refreshes grid/taxonomy/
previews through the coalesced refresh queue instead of blocking the open menu
with `reloadAllSnapshots()`.

## Batch Delete

Batch Delete must reuse the existing destructive confirmation principles:

- show exact selected count;
- name the action as deleting cards, not media assets;
- do not delete unrelated media unless the existing card-delete flow already
  owns that behavior for each selected block;
- clear selection only after successful completion.

After a successful delete, Grid must preserve the user's approximate viewport
instead of keeping the old absolute `scrollTop`. The source of truth is the
previous `layout.positions`: Grid captures a surviving card near the viewport
top before the block list changes, carries that anchor across the new layout
generation, and restores the same viewport offset only after the anchor card is
committed in the reflowed masonry layout. Pending delete anchoring suppresses
stale keyboard-focus autoscroll, so an old focused card cannot pull the feed
away from the user's current reading position.

## Collection-Scoped Disconnect

`Disconnect` is only available inside a concrete collection route
(`currentTag` exists).

The operation removes every selected card from that current collection and then
clears selection. If a selected card is not in the current collection because of
a stale UI snapshot, the operation skips it without failing the whole batch.

## Testing Requirements

Frontend tests must cover:

- `Cmd+click` adds and removes individual selected cards without opening Detail;
- `Shift+click` follows the same single-card toggle behavior as `Cmd+click`;
- `Shift+Enter` toggles the keyboard-focused card;
- plain `Enter` toggles the keyboard-focused card while `selectedSlugs.size > 0`;
- while `selectedSlugs.size > 0`, plain `Enter` ignores stale DOM card focus in
  keyboard mode, toggles the Grid-focused card and does not open Detail;
- while `selectedSlugs.size > 0`, plain `Enter` can also toggle a committed
  pointer-hovered or DOM-focused feed card in pointer mode;
- `Cmd+K` opens the focused-card batch menu with count header, `Connect`,
  collection-scoped `Disconnect` outside Everything and `Delete`;
- plain card click toggles selection instead of opening Detail while
  `selectedSlugs.size > 0`;
- empty-area marquee drag renders `data-feed-grid-marquee-selection`;
- marquee selection selects every committed card whose `layout.positions`
  rectangle intersects the marquee rectangle;
- a marquee drag held inside the bottom edge band scrolls the feed while the
  pointer stays still, and the rectangle grows by the scrolled distance;
- autoscroll speed is zero away from the edge bands, ramps with depth, and
  keeps its maximum past the scrollport edge;
- changing channel clears selection;
- disappearing selected blocks are removed from selection;
- `Escape` clears selection before other Grid escape behavior;
- selected GridItem renders `data-feed-grid-item-selected` and selection frame;
- active group selection suppresses card hover action buttons on selected and
  unselected cards;
- bottom island appears/disappears based on count;
- Russian pluralization for `1`, `2`, `5`, `21`, `25`;
- `Disconnect` only appears when `currentTag` exists and is absent in
  Everything;
- `Merge` appears in the bottom island and focused-card batch menu only when
  two or more cards are selected;
- `Merge` opens the reorder-first merge dialog from
  [SPEC_CARD_MERGE.md](SPEC_CARD_MERGE.md);
- `Delete` opens batch confirmation;
- deleting cards preserves the viewport anchor after masonry reflow, including
  when removed cards are scattered above and below the current viewport;
- stale keyboard focus does not override delete scroll anchoring;
- selected-card draggable data exposes the whole selected group as
  `data-feed-card-drag-count`/`data-feed-card-drag-slugs`;
- block drag hides the bottom action island without clearing selected frames;
- group drag stack renders at most four real frozen card-preview layers;
- stack layers use no `scale(...)`, front layer has no transform, back layers
  use only integer `translate3d(...)` plus small `rotate(...)`;
- stack preview shows an overflow count badge when selected count exceeds the
  visible layer cap;
- group drop on a channel applies connect to all dragged slugs;
- group drop on create-channel carries all dragged slugs into the channel
  creation flow;
- sidebar channel hover/drop target is resolved from the actual
  `[data-sidebar-row]` under the pointer, not only from cached droppable rects;
- selection visual coexists with keyboard focus and `Cmd+K` pinned menu anchor.

Manual QA must cover:

- marquee selection across uneven masonry card heights;
- marquee selection on empty spaces between columns and rows;
- edge autoscroll over a feed longer than several screens, including selection
  of cards that were not rendered when the drag started;
- edge autoscroll stopping cleanly at the top and bottom of the feed;
- dark and light theme selected frames;
- selection frame on image, video, article and mixed media cards;
- bottom island does not overlap open popovers/menus;
- real vault batch connect/remove/delete with Obsidian `Mine Collections`
  wikilinks.
